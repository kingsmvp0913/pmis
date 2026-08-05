/**
 * kickoff-compare.js — 開工報告表 vs 決標公告的逐欄比對(純函式)
 *
 * 級別二分(spec §5.2):
 *   hard 硬錯 — 兩份文件對同一事實記載不同,必須發文請廠商更正
 *   hint 提示 — 決標公告的履約起迄明載「(預估)」,機關實際通知開工較晚屬正常,
 *               判硬錯會逼承辦人去請廠商修正一份正確的文件(古坑案)
 *
 * 契約工期比對是**開工報告表的內部自洽性檢查**(表上明載工期 vs 表上開工/竣工日
 * 推導工期),不是跨文件比對,但級別仍是 hard(spec §5.2 明訂):表上兩個數字互相
 * 矛盾就是這份文件自己填錯,不像開工/竣工日兩欄有「決標公告寫的是預估值」這種
 * 正常解釋可以開脫。這是唯一能抓出「文件自己填錯」的檢查,降成 hint 等於让這種
 * 錯誤被當成可忽略的提示放行、照常歸檔(見 task-6-report.md 修正記錄)。
 *
 * 狀態四態,不可壓成布林:
 *   match / diff / missing(有一邊沒值,沒得比) / no_award(該工程未歸檔決標公告)
 *
 * Exports:
 *   compareKickoff(kickoff, award) → rows
 *   hardErrors(rows)               → 篩出硬錯
 */
const { normalizeOrgName } = require('./org-match');
const { deriveDuration, rocToISO } = require('./kickoff-values');

// 名稱與地名一律走 org-match 的正規化(全形轉半形 + 臺→台 + 去空白)。
// 不得另寫一份:同一份文件內即混用臺/台,兩套規則遲早漂走。
const eqText = (a, b) => {
  const na = normalizeOrgName(a);
  const nb = normalizeOrgName(b);
  if (na == null || nb == null) return null; // 沒得比
  return na === nb;
};

const MS_PER_DAY = 86400000;
function daysBetween(aISO, bISO) {
  const a = Date.parse(`${aISO}T00:00:00Z`);
  const b = Date.parse(`${bISO}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.abs(Math.round((b - a) / MS_PER_DAY));
}

function row(欄位, 開工報告表值, 決標公告值, 狀態, 級別, 差異天數) {
  const r = { 欄位, 開工報告表值, 決標公告值, 狀態, 級別 };
  if (差異天數 != null) r.差異天數 = 差異天數;
  return r;
}

// 一般欄位:兩值皆有才比,任一缺即 missing。
function cmp(欄位, kv, av, hasAward, eq) {
  if (!hasAward) return row(欄位, kv, null, 'no_award', 'hard');
  if (kv == null || av == null) return row(欄位, kv, av, 'missing', 'hard');
  return row(欄位, kv, av, eq ? 'match' : 'diff', 'hard');
}

/**
 * 逐欄比對。
 * @param {object} kickoff extractFields 的輸出
 * @param {object|null} award parseAwardNotice 的輸出;該工程未歸檔決標公告時傳 null
 * @returns {Array<object>}
 */
function compareKickoff(kickoff, award, opts) {
  const k = kickoff || {};
  const a = award || {};
  const hasAward = !!award;
  const confirmed = !!(opts && opts.confirmed);
  const rows = [];

  // ── 硬錯欄位 ────────────────────────────────────────────
  rows.push(cmp('工程名稱', k.工程名稱, a.工程名稱, hasAward, eqText(k.工程名稱, a.工程名稱) === true));

  // 契約編號**不做數值正規化**:格式各機關自訂,數值化會把 '0123' 誤判等於 '123'
  rows.push(cmp('契約編號', k.契約編號, a.工程編號, hasAward,
    normalizeOrgName(k.契約編號) === normalizeOrgName(a.工程編號)));

  rows.push(cmp('契約金額', k.契約金額, a.契約金額, hasAward,
    Number(k.契約金額) === Number(a.契約金額)));

  // 決標公告是民國字串,開工報告表已轉 ISO,比對前把公告側也轉過去
  const awardAwardDate = hasAward ? rocToISO(a.決標日期) : null;
  rows.push(cmp('決標日', k.決標日期, awardAwardDate, hasAward, k.決標日期 === awardAwardDate));

  rows.push(cmp('學校', k.主辦機關, a.主辦機關, hasAward, eqText(k.主辦機關, a.主辦機關) === true));
  rows.push(cmp('縣市', k.縣市, a.履約地點, hasAward, eqText(k.縣市, a.履約地點) === true));

  // ── 契約工期:開工報告表的**內部自洽性檢查**,不與決標公告比,但仍是硬錯 ──
  // 表上明載的工期 vs 表上開工日→竣工日推導值。SP1 §4.3 已用 27 組全量驗證
  // 推翻「以履約起迄推導契約工期」(僅 14 組相符),故不拿決標公告當比對基準;
  // 但表上兩個數字互相矛盾就是這份文件自己填錯,沒有「預估值」這種正常解釋
  // 可以開脫,級別維持 hard(spec §5.2)。
  const dur = k.契約工期 || { 天數: null, 基準: null };
  // 確認階段(confirmed)的天數來自畫面上的日曆天欄位——前端對工作天案例刻意
  // 留空該欄並要承辦人自行換算,OCR 的工作天數字不會流進去。故此時有值即是
  // 已換算的日曆天,照常推導驗算。解析階段仍不推導(那時的值是 OCR 讀到的
  // 工作天,推導必然假警報);少了這個區分,工作天案例(明禮)在必填上線後
  // 恆為 missing → 永遠歸不了檔。
  if (dur.基準 === '工作天' && !(confirmed && dur.天數 != null)) {
    // 由日期推導出的是日曆天,工作天案例必然對不上(明禮)。只取表上數字、不推導。
    rows.push(row('契約工期', `${dur.天數} 工作天`, '（工作天不推導）', 'missing', 'hard'));
  } else {
    const derived = deriveDuration(k.契約規定開工日, k.契約規定竣工日);
    if (dur.天數 == null || derived == null) {
      rows.push(row('契約工期', dur.天數, derived == null ? null : `（表內推導）${derived}`, 'missing', 'hard'));
    } else {
      rows.push(row('契約工期', dur.天數, `（表內推導）${derived}`,
        dur.天數 === derived ? 'match' : 'diff', 'hard'));
    }
  }

  // ── 提示欄位:履約起迄明載「(預估)」,只顯示差幾天,不阻擋 ──
  for (const [欄位, kv, av] of [
    ['契約規定開工日', k.契約規定開工日, hasAward ? rocToISO(a.履約起迄 && a.履約起迄.起) : null],
    ['契約規定竣工日', k.契約規定竣工日, hasAward ? rocToISO(a.履約起迄 && a.履約起迄.迄) : null],
  ]) {
    if (!hasAward) { rows.push(row(欄位, kv, null, 'no_award', 'hint')); continue; }
    if (kv == null || av == null) { rows.push(row(欄位, kv, av, 'missing', 'hint')); continue; }
    const d = daysBetween(kv, av);
    rows.push(row(欄位, kv, av, kv === av ? 'match' : 'diff', 'hint', d));
  }

  return rows;
}

/**
 * 硬錯清單。**一次列全**——逐條修正會讓承辦人來回發文好幾次。
 * missing 不算硬錯:那是「沒讀到、沒得比」,要承辦人補值,不是要廠商改文件。
 */
function hardErrors(rows) {
  return (rows || []).filter((r) => r && r.級別 === 'hard' && r.狀態 === 'diff');
}

// 必填七欄。**學校與決標日刻意不在其中**:署名欄校名 21/24(3 份被印章蓋掉
// 尾字)、臺中市格式整份沒有決標日,列必填會讓這些合法文件永遠歸不了檔。
const REQUIRED = [
  '工程名稱', '契約編號', '契約金額', '縣市', '契約規定開工日', '契約規定竣工日',
];

const isEmpty = (v) => v == null || (typeof v === 'string' && v.trim() === '');

const isPositiveInt = (v) => Number.isInteger(Number(v)) && Number(v) > 0;

// 比對表標籤 → values 的鍵名(這兩欄兩邊命名不同)
const DATE_KEY = {
  決標日: '決標日期', 契約規定開工日: '契約規定開工日', 契約規定竣工日: '契約規定竣工日',
};

// ISO 日期的日曆合法性。rocToISO 已對民國字串擋掉 2/30,confirm 收的是
// 前端送來的 ISO 字串,同一種錯誤要在這條路徑上再擋一次。
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidISO(s) {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * 必填檢查。看的是**開工報告表值本身有沒有**,與比對狀態無關——
 * hardErrors 只認 'diff',missing(沒得比)一律放行,所以少了這一層,
 * 九欄全空也照樣歸檔,下游 SP2 接到的會是一份空的工程基本資料。
 *
 * @param {object} values 承辦人確認後的值(extractFields 形狀)
 * @returns {Array<{欄位:string, 訊息:string}>} 欄位用比對表的中文標籤(前端以此標紅)
 */
function validateValues(values) {
  const v = values || {};
  const errs = REQUIRED.filter((k) => isEmpty(v[k]))
    .map((欄位) => ({ 欄位, 訊息: '必填,請對照 PDF 填寫', 級別: 'hard' }));
  const 天數 = v.契約工期 && v.契約工期.天數;
  if (isEmpty(天數)) errs.push({ 欄位: '契約工期', 訊息: '必填,請對照 PDF 填寫', 級別: 'hard' });

  // ── 值域 ────────────────────────────────────────────────
  // 前端是 <input type=number/date>,但 confirm 收的是 JSON,繞得過去;
  // 且瀏覽器的 number 欄本來就擋不住負號與小數。
  if (!isEmpty(v.契約金額) && !isPositiveInt(v.契約金額)) {
    errs.push({ 欄位: '契約金額', 訊息: '須為大於 0 的整數(元)', 級別: 'hard' });
  }
  if (!isEmpty(天數) && !isPositiveInt(天數)) {
    errs.push({ 欄位: '契約工期', 訊息: '須為大於 0 的天數', 級別: 'hard' });
  }
  for (const 欄位 of ['決標日', '契約規定開工日', '契約規定竣工日']) {
    const val = v[DATE_KEY[欄位]];
    if (!isEmpty(val) && !isValidISO(val)) {
      errs.push({ 欄位, 訊息: '日期格式不正確或日曆上不存在', 級別: 'hard' });
    }
  }
  const 開工 = v.契約規定開工日;
  const 竣工 = v.契約規定竣工日;
  // 日期填反時 deriveDuration 回 null,承辦人只會看到「契約工期讀不到」,
  // 看不出真正的問題是兩個日期顛倒——那要做的事完全不同。
  if (isValidISO(開工) && isValidISO(竣工) && 竣工 < 開工) {
    errs.push({ 欄位: '契約規定竣工日', 訊息: '竣工日早於開工日', 級別: 'hard' });
  }
  // 決標之後才會開工。但決標日本身可空、也有補辦決標的例外,判硬錯會擋住
  // 合法文件,故只提示。
  if (isValidISO(v.決標日期) && isValidISO(開工) && v.決標日期 > 開工) {
    errs.push({ 欄位: '決標日', 訊息: '決標日晚於開工日,請確認是否填反', 級別: 'hint' });
  }
  return errs;
}

module.exports = { compareKickoff, hardErrors, validateValues };
