/**
 * kickoff-values.js — 開工報告表的值正規化(純函式,不碰 IO)
 *
 * 開工報告表的值形態與決標公告不同:金額有國字大寫(台西、鹿場)、
 * 日期有「中華民國115年6月16日」與 115/06/16 兩種。不轉換就是 100% 假警報。
 *
 * Exports:
 *   rocToISO(v)       民國各種寫法 → 'YYYY-MM-DD';非法回 null
 *   cnNumToNumber(v)  國字大寫金額 → 數值;非國字回 null
 *   parseMoney(v)     阿拉伯數字與國字大寫都吃 → 數值
 *   parseDuration(v)  契約工期字串 → {天數:number|null, 基準:string|null}
 *   deriveDuration(startISO, endISO)  開工日→竣工日 → 日曆天數(含頭尾)
 */

// OCR 對中文會逐字插空格(「1 1 5 年」),比對前一律先清掉所有空白。
//
// 同時做 NFKC:OCR 會把千分位讀成全形逗號(實測「新台幣3,122,168元」被讀成
// 「3，122，168」),不轉半形的話 parseMoney 只吃到第一段就回 3 —— 一個看起來
// 合法、比對層攔不住的錯值,比讀不到危險得多。
// NFKC 只放在這一層(金額/日期/工期),不可上移到 items 層:NFKC 會把「㎡」
// 拆成「m2」,那會打壞施工日誌讀取器的單位比對。
const stripSpace = (s) => String(s).normalize('NFKC').replace(/[\s　]/g, '');

/**
 * 民國年轉西元 ISO。接受 '115/06/16'、'115/6/3'、'中華民國115年6月16日'。
 *
 * 必須驗日曆合法性:JS 的 Date 會把 2/30 靜默滾成 3/2,不驗就會產生一個
 * 看起來正常、實際錯誤的日期寫進比對結果。民國年下界為 1(0 年不存在),
 * 上界 999(四位數必為 OCR 讀錯,不得編造)。
 *
 * @returns {string|null} 'YYYY-MM-DD';無法解析或日曆不存在回 null
 */
function rocToISO(v) {
  if (v == null) return null;
  const s = stripSpace(v);
  const m = /(\d{1,3})[/年\-.](\d{1,2})[/月\-.](\d{1,2})/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || y > 999 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const year = y + 1911;
  const dt = new Date(Date.UTC(year, mo - 1, d));
  // 2/30 這種日曆上不存在的日期,Date 會滾到下個月;比對回來即可揪出
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(mo)}-${pad(d)}`;
}

const CN_DIGIT = {
  零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 貳: 2, 两: 2, 兩: 2, 三: 3, 叁: 3, 參: 3,
  四: 4, 肆: 4, 五: 5, 伍: 5, 六: 6, 陸: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
};
const CN_UNIT = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };
const CN_BIG = { 萬: 10000, 万: 10000, 億: 100000000 };

/**
 * 國字大寫金額轉數值:'貳佰肆拾伍萬陸仟元整' → 2456000。
 *
 * 決標公告一律阿拉伯數字,開工報告表有兩份用國字大寫(台西、鹿場),
 * 逐字比對必然誤判(spec §3.3),故必須轉成同一種型別再比。
 *
 * 演算法:section 累計「萬」以下的部分,遇到萬/億就結算進 total。
 * 「元整」「新台幣」等前後綴在進入前先清掉。
 *
 * @returns {number|null} 不含任何國字數字時回 null(交給 parseMoney 走數字路徑)
 */
function cnNumToNumber(v) {
  if (v == null) return null;
  const s = stripSpace(v).replace(/^.*?[:：]/, '').replace(/[元圓整]/g, '');
  if (s === '' || !/[零〇一壹二貳兩三叁參四肆五伍六陸七柒八捌九玖十拾百佰千仟萬万億]/.test(s)) return null;

  let total = 0;
  let section = 0;
  let digit = 0;
  for (const ch of s) {
    if (CN_DIGIT[ch] !== undefined) {
      digit = CN_DIGIT[ch];
    } else if (CN_UNIT[ch]) {
      // 「十五」這種省略前導一的寫法:十 前面沒數字時視為 1
      section += (digit === 0 ? 1 : digit) * CN_UNIT[ch];
      digit = 0;
    } else if (CN_BIG[ch]) {
      total += (section + digit) * CN_BIG[ch];
      section = 0;
      digit = 0;
    } else {
      // 夾雜非國字數字字元(OCR 雜訊)→ 不猜,整串放棄
      return null;
    }
  }
  const n = total + section + digit;
  return n > 0 ? n : null;
}

/**
 * 金額:阿拉伯數字(含千分位)與國字大寫都吃。讀不到一律 null,不編造。
 * @returns {number|null}
 */
function parseMoney(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = stripSpace(v);
  const m = /^[^\d]*?([\d,]+)/.exec(s);
  if (m && /\d/.test(m[1])) {
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return cnNumToNumber(s);
}

/**
 * 契約工期:取天數與基準。'150日曆天' / '160工作天' / '機關通知日起90日曆天竣工'。
 *
 * 基準必須分辨:由開工日→竣工日推導出的是**日曆天**,明禮那份是工作天,
 * 不分基準就會對它產生一個必然的假警報(spec §5.4)。
 * 讀壞的值(南陽 '_J50_'、豐榮 '一』一一')一律回 null,不從雜訊裡硬湊數字。
 *
 * @returns {{天數:number|null, 基準:'日曆天'|'工作天'|null}}
 */
function parseDuration(v) {
  if (v == null) return { 天數: null, 基準: null };
  const s = stripSpace(v);
  const 基準 = /工作天/.test(s) ? '工作天' : (/日曆天/.test(s) ? '日曆天' : null);
  // 只認連續的純數字。'_J50_' 裡的 50 也會被抓到,故要求數字前後不得緊鄰
  // 英文字母或底線——那是 OCR 把字形讀壞的特徵,不是真的數字。
  const m = /(?:^|[^0-9A-Za-z_])(\d{1,4})(?:[^0-9A-Za-z_]|$)/.exec(s);
  const 天數 = m ? Number(m[1]) : null;
  return { 天數: 天數 != null && 天數 > 0 ? 天數 : null, 基準 };
}

const MS_PER_DAY = 86400000;

/**
 * 由開工日、竣工日推導工期(**含頭尾**)。3/18→8/14 是 150 天,不是 149。
 * 少算一天會讓 24 份全部判不符。
 *
 * 迄早於起是資料錯誤,回 null 而非負數:負數會與表上的正數比出「不符」,
 * 看起來像是工期填錯,實際是日期填反,兩者要承辦人做的事不同。
 *
 * @param {string|null} startISO 'YYYY-MM-DD'
 * @param {string|null} endISO   'YYYY-MM-DD'
 * @returns {number|null}
 */
function deriveDuration(startISO, endISO) {
  if (!startISO || !endISO) return null;
  const a = Date.parse(`${startISO}T00:00:00Z`);
  const b = Date.parse(`${endISO}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / MS_PER_DAY) + 1;
}

module.exports = { rocToISO, cnNumToNumber, parseMoney, parseDuration, deriveDuration };
