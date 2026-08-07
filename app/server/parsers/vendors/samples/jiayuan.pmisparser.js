/**
 * jiayuan.pmisparser.js — 嘉原營造有限公司施工日誌讀取器(民生國小綜合球場)
 *
 * vendorKey 取自**決標公告的得標廠商**;日誌每一頁的「承攬廠商名稱」欄也是同一個
 * 名稱,兩邊一致。
 *
 * ── 版面事實(實測 3 份 PDF / 84 天)──
 * 有文字層的 PDF,**一天一頁**,頁首是「表單編號:」。單聯,欄位靠座標歸位:
 *   y≈766  「本日天氣:」「上午:」值「下午:」值「填表日期:」民國114年4月1日「星期二」
 *   y≈757  「工程名稱」值   「承攬廠商名稱」值
 *   y≈747  「契約工期」…「開工日期」值
 *   y≈728  「累計預定進度(%)」6.93%  「實際累計進度  (%)」4.29%
 *   y≈699  明細表頭:合約項次 / 工程項目 / 單位 / 契約數量 / 本日完成 / 累計完成數量 / 備註
 *   明細到「營造業專業工程特定施工項目」為止;再往下依序是二、材料 三、出工 四、…
 *
 * ── 三個坑 ──
 * ① **表頭是置中的、值是靠左印的**,所以「工程項目」的值(x≈87)其實落在
 *    「合約項次」表頭(x≈56)與「工程項目」表頭(x≈176)之間。用表頭欄界判斷會把
 *    整個名稱歸到項次欄。故左半(單位欄界以左)改用**形狀**判定:那一帶最左邊的
 *    item 若長得像項次(阿拉伯數字或中文大寫數字)就是項次,其餘串起來是名稱。
 *    右半的四個數值欄則以**各表頭的起點 x 為分界**(值靠右印,用 [x, x+w] 會落在界外)。
 * ② **同一列的項次與名稱 y 差 0.5**(名稱 688.0、項次 687.5),而列距只有 11。
 *    照 y 逐一分行會把一列拆成兩列,容差開太大又會併掉相鄰列。以 2pt 分帶。
 * ③ **31 天裡只有 8 天填了明細**。其餘天數的明細區整片空白(不是讀不到)。
 *    出工那張表同理:工別名稱每天都印滿,人數欄只有 17 天有值。
 *    「還沒填」與「讀不到」要分得清楚,所以空的就留 null,不要塞 0。
 *
 * ── 此格式沒有的東西 ──
 * 沒有契約單價、沒有任何金額,一律 null 不回推。
 * 「二、工地材料管理概況」那張表實測 84 天全空(而且它是左右兩個並排的區塊,
 * 真的有資料時要當兩塊處理)——目前不收,收了也只會是空陣列。
 */

const META_VENDOR_KEY = '嘉原營造有限公司';

const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'kg', '噸', 'T',
  '公尺', '公斤', '平方公尺', '立方公尺', '場', '座', '組', '支', '個', '只', '片',
  '面', '處', '間', '棵', '株', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '才', '天', '日', '人']);
// 項次:阿拉伯數字或中文大寫數字(費用項)。「参」是實測到的異體字。
const NO_RE = /^(\d{1,3}|[壹貳參参肆伍陸柒捌玖拾]+)$/;

const nfkc = (v) => String(v == null ? '' : v).normalize('NFKC');
const despace = (v) => nfkc(v).replace(/[\s　]/g, '');

function text(v) {
  const s = nfkc(v).replace(/[\r\n]+/g, '').trim();
  return s === '' || s === '-' || s === '－' ? null : s;
}

function num(v) {
  const s = nfkc(v).replace(/[,\s　%]/g, '');
  if (s === '' || s === '-' || s === '－') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const unitOf = (v) => {
  const s = despace(v);
  return s && KNOWN_UNITS.has(s) ? s : null;
};

/** 民國/西元「民國114年4月1日」「114年2月28日」→ ISO。 */
function rocTextToISO(v) {
  const m = despace(v).match(/(\d{2,4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  let y = Number(m[1]);
  if (y < 1911) y += 1911;
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(Number(m[2]))}-${p(Number(m[3]))}`;
}

/**
 * 依 y 分帶(容差 2pt:同一列的項次與名稱差 0.5,列距 11)。
 * 帶的基準 y 固定用最上面那個 item,不隨新成員位移。
 */
function bands(items, tol = 2) {
  const out = [];
  for (const it of items.slice().sort((a, b) => b.y - a.y)) {
    const last = out[out.length - 1];
    if (last && last.y - it.y <= tol) last.items.push(it);
    else out.push({ y: it.y, items: [it] });
  }
  for (const b of out) b.items.sort((a, b2) => a.x - b2.x);
  return out;
}

const bandText = (b) => b.items.map((i) => i.s).join('');

/** 找含某標籤的帶。 */
const bandWith = (all, re) => all.find((b) => b.items.some((i) => re.test(despace(i.s))));

/**
 * 取某標籤右邊、下一個標籤左邊的值(同一帶內)。
 * @param {object} band
 * @param {RegExp} labelRe 標籤
 * @param {RegExp} [stopRe] 下一個標籤;省略則取到帶尾
 */
function pick(band, labelRe, stopRe) {
  if (!band) return null;
  const its = band.items;
  const li = its.findIndex((i) => labelRe.test(despace(i.s)));
  if (li < 0) return null;
  let end = its.length;
  if (stopRe) {
    for (let i = li + 1; i < its.length; i++) if (stopRe.test(despace(its[i].s))) { end = i; break; }
  }
  const val = its.slice(li + 1, end).map((i) => i.s).join('').trim();
  return text(val);
}

/** 以「各表頭的起點 x」為分界歸欄(值靠右印,用 [x, x+w] 會落在界外)。 */
function byColumn(band, xs) {
  const cells = xs.map(() => []);
  for (const it of band.items) {
    const c = it.x + (it.w || 0) / 2;
    let k = 0;
    while (k + 1 < xs.length && c >= xs[k + 1]) k++;
    cells[k].push(it);
  }
  return cells.map((g) => g.map((i) => i.s).join('').trim());
}

/**
 * 解析一頁(一天)。純函式,selfTest 以真實座標重用之。
 * @param {Array<{x:number,y:number,w:number,s:string}>} items
 */
function parsePage(items) {
  const all = bands(items);
  const find = (re) => items.find((it) => re.test(despace(it.s)));

  const wb = bandWith(all, /^本日天氣[:：]?$/);
  const nb = bandWith(all, /^工程名稱$/);
  const pb = bandWith(all, /^累計預定進度/);
  const sb = bandWith(all, /^開工日期$/);

  const dateText = wb ? (bandText(wb).match(/民國?\s*\d{2,4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/) || [])[0] : null;
  const week = wb ? (bandText(wb).match(/星期[一二三四五六日天]/) || [])[0] : null;

  // ── 明細 ──
  const hNo = find(/^合約項次$/);
  const hUnit = find(/^單位$/);
  const hQty = find(/^契約數量$/);
  const hToday = find(/^本日完成$/);
  const hCum = find(/^累計完成數量$/);
  const hMemo = find(/^備註$/);
  const dailyRows = [];
  if (hNo && hUnit && hQty && hToday && hCum) {
    const xs = [-Infinity, hUnit.x, hQty.x, hToday.x, hCum.x, hMemo ? hMemo.x : Infinity];
    const stop = find(/^營造業專業工程特定施工項目/);
    const bottom = stop ? stop.y : -Infinity;
    for (const b of all) {
      if (b.y >= hNo.y - 0.5 || b.y <= bottom + 0.5) continue;
      const [left, 單位, 契約, 本日, 累計] = byColumn(b, xs);
      if (!left && !單位 && !契約 && !本日 && !累計) continue;
      const parts = b.items.filter((i) => i.x + (i.w || 0) / 2 < hUnit.x).sort((a, c) => a.x - c.x);
      let 項次 = null;
      let name = left;
      // 表頭置中、值靠左:名稱會落在項次欄界內,只能靠形狀分(見檔頭①)
      if (parts.length && NO_RE.test(despace(parts[0].s))) {
        項次 = despace(parts[0].s);
        name = parts.slice(1).map((i) => i.s).join('').trim();
      }
      dailyRows.push({
        項次,
        工程項目: text(name),
        單位: unitOf(單位),
        契約單價: null,                                // 此格式無單價
        契約數量: num(契約),
        本日完成數量: num(本日),
        本日完成金額: null,                            // 此格式無金額
        累計完成數量: num(累計),
      });
    }
  }

  // ── 出工/機具 ──
  const extras = {};
  let 出工總人數 = null;
  const hCrew = find(/^工別$/);
  const hToday2 = find(/^本日人數$/);
  const hCum2 = find(/^累計人數$/);
  const hMach = find(/^機具名稱$/);
  const hMToday = find(/^本日使用數量$/);
  if (hCrew && hToday2 && hCum2 && hMach && hMToday) {
    const xs = [-Infinity, hToday2.x, hCum2.x, hMach.x, hMToday.x];
    const stop = all.find((b) => b.y < hCrew.y && /^四、/.test(bandText(b).trim()));
    const bottom = stop ? stop.y : -Infinity;
    const 出工明細 = [];
    const 主要機具 = [];
    for (const b of all) {
      if (b.y >= hCrew.y - 0.5 || b.y <= bottom + 0.5) continue;
      const [工別, 本日, , 機具, 機具本日] = byColumn(b, xs);
      const w = text(工別);
      const n = num(本日);
      if (w && n != null && n > 0) 出工明細.push({ 工別: w, 人數: n });
      if (n != null) 出工總人數 = (出工總人數 || 0) + n;
      const g = text(機具);
      const gn = num(機具本日);
      if (g && gn != null && gn > 0) 主要機具.push({ 名稱: g, 數量: gn });
    }
    if (出工明細.length) extras.出工明細 = 出工明細;
    if (主要機具.length) extras.主要機具 = 主要機具;
  }

  return {
    header: {
      工程名稱: pick(nb, /^工程名稱$/, /^承攬廠商名稱$/),
      填報日期: rocTextToISO(dateText),
      星期: week || null,
      天氣_上午: pick(wb, /^上午[:：]$/, /^下午[:：]$/),
      天氣_下午: pick(wb, /^下午[:：]$/, /^填表日期[:：]$/),
      // PDF 印的就是百分數(6.93%),照收不換算
      預定進度: num(pick(pb, /^累計預定進度/, /^實際累計進度/)),
      實際進度: num(pick(pb, /^實際累計進度/, /^原契約[:：]$/)),
      出工總人數,
      本日累計金額: null,                              // 此格式無金額
      承包廠商: pick(nb, /^承攬廠商名稱$/),
      開工日期: rocTextToISO(pick(sb, /^開工日期$/)),
    },
    dailyRows,
    extras,
  };
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.extractItems !== 'function') throw new Error('缺少注入的 filetypes.extractItems');
  const pages = await ft.extractItems(filePath);
  const total = pages.reduce((a, p) => a + (p.items || []).length, 0);
  // 回空陣列會被上游當成「這份沒有資料」而靜靜略過。掃描件一定要明講。
  if (!total) throw new Error('PDF 沒有文字層(掃描件),無法解析');
  const days = [];
  for (const p of pages) {
    const items = p.items || [];
    if (!items.some((it) => /^表單編號[:：]?$/.test(despace(it.s)))) continue;
    days.push(parsePage(items));
  }
  if (!days.length) throw new Error('找不到「表單編號」頁(此檔非嘉原格式)');
  return days.filter((d) => d.header.填報日期 != null
    || (d.dailyRows || []).some((r) => r.本日完成數量));
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest 用**真實座標**(取自 `民生(球場2)日誌-0401-0430.pdf` 第 9、14 頁,
 * 只換工程名稱)。要驗的三件事都是形狀問題:名稱靠左印會落在項次欄界內、
 * 一列的項次與名稱 y 差 0.5、數值靠右印會超出表頭欄界。
 */
function selfTest() {
  const it = (x, y, w, s) => ({ x, y, w, s });
  const items = [
    it(273.2, 787.8, 49.0, '施工日誌'),
    it(53.9, 775.5, 33.6, '表單編號:'), it(87.2, 775.5, 6.7, '33'),
    it(116.8, 766.7, 6.6, '雨'), it(212.2, 766.7, 6.6, '晴'),
    it(412.0, 766.5, 50.2, '民國114年4月1日'),
    it(53.9, 766.2, 33.6, '本日天氣:'), it(87.2, 766.2, 20.2, '上午:'),
    it(168.7, 766.2, 20.2, '下午:'), it(347.4, 766.2, 33.6, '填表日期:'),
    it(507.3, 766.2, 20.2, '星期二'),
    it(317.0, 757.3, 40.3, '承攬廠商名稱'), it(383.6, 757.3, 53.8, META_VENDOR_KEY),
    it(87.2, 757.3, 100.8, '測試工程'), it(56.3, 756.8, 26.9, '工程名稱'),
    it(56.3, 747.5, 26.9, '契約工期'), it(107.4, 747.5, 6.7, '90'),
    it(116.8, 747.5, 20.2, '日曆天'), it(453.7, 747.5, 26.9, '開工日期'),
    it(497.3, 747.5, 40.1, '114年2月28日'),
    it(141.3, 728.6, 16.8, '6.93%'), it(386.8, 728.6, 23.6, '原契約:'),
    it(415.4, 728.6, 26.8, '981660元'), it(328.8, 728.6, 16.8, '4.29%'),
    it(58.9, 728.5, 50.3, '累計預定進度(%)'), it(208.6, 728.5, 57.0, '實際累計進度  (%)'),
    it(53.9, 709.2, 235.2, '一、依施工計畫書執行按圖施工概況(含約定之重要施工項目及完成數量等):'),
    it(175.6, 699.1, 26.9, '工程項目'), it(398.7, 699.1, 26.9, '本日完成'),
    it(56.3, 698.6, 26.9, '合約項次'), it(309.2, 698.6, 13.4, '單位'),
    it(347.9, 698.6, 26.9, '契約數量'), it(447.0, 698.6, 40.3, '累計完成數量'),
    it(510.7, 698.6, 13.4, '備註'),
    // 明細第一列:名稱(x87)落在「合約項次」表頭與「工程項目」表頭之間
    it(87.4, 688.0, 168.0, '工程告示牌、職安衛告示牌、施工圍籬與交通管制設施(租用)'),
    it(421.8, 688.0, 13.4, '1.00'),
    it(67.9, 687.5, 3.3, '1'), it(312.3, 687.5, 6.7, '式'),
    it(362.8, 687.5, 13.4, '1.00'), it(472.7, 687.5, 13.4, '1.00'),
    // 費用項:項次是中文大寫,有單位有數量,是真項目
    it(87.4, 677.0, 90.0, '職業安全衛生管理費(壹*1%)'), it(421.8, 677.0, 13.4, '0.10'),
    it(66.1, 676.5, 6.7, '貳'), it(312.3, 676.5, 6.7, '式'),
    it(362.8, 676.5, 13.4, '1.00'), it(472.7, 676.5, 13.4, '0.40'),
    it(53.9, 529.6, 87.4, '營造業專業工程特定施工項目'),
    it(81.1, 520.3, 6.7, 'A.'),
    it(53.9, 501.6, 194.9, '二、工地材料管理概況(含約定之重要材料使用狀況及數量等):'),
    it(53.9, 464.1, 215.0, '三、工地人員及機具管理(含約定之出工人數及機具使用情形及數量):'),
    it(269.2, 454.7, 26.9, '累計人數'), it(427.4, 454.7, 40.3, '本日使用數量'),
    it(88.5, 454.7, 13.4, '工別'), it(167.8, 454.7, 26.9, '本日人數'),
    it(357.9, 454.7, 26.9, '機具名稱'), it(497.3, 454.3, 40.3, '累計使用數量'),
    it(85.1, 445.4, 20.2, '拆除工'), it(361.3, 445.4, 20.2, '刨除機'),
    it(85.1, 379.9, 20.2, '一般工'), it(179.5, 379.9, 3.3, '3'), it(281.0, 379.9, 3.3, '3'),
    it(53.9, 370.4, 329.3, '四、本日施工項目是否有須依「營造業專業工程特定施工項目應置之技術士…'),
  ];

  const d = parsePage(items);
  if (d.header.工程名稱 !== '測試工程') return false;
  if (d.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (d.header.填報日期 !== '2025-04-01' || d.header.星期 !== '星期二') return false;
  if (d.header.開工日期 !== '2025-02-28') return false;
  if (d.header.天氣_上午 !== '雨' || d.header.天氣_下午 !== '晴') return false;
  if (d.header.預定進度 !== 6.93 || d.header.實際進度 !== 4.29) return false;  // PDF 印的是百分數
  if (d.header.出工總人數 !== 3) return false;         // 累計那欄不可混進來
  if (d.extras.出工明細.length !== 1) return false;    // 沒填人數的工別不列
  if (d.extras.主要機具) return false;                 // 機具只印了名稱,沒有數量
  if (d.dailyRows.length !== 2) return false;
  const [r1, fee] = d.dailyRows;
  if (r1.項次 !== '1') return false;
  if (r1.工程項目 !== '工程告示牌、職安衛告示牌、施工圍籬與交通管制設施(租用)') return false;
  if (r1.單位 !== '式' || r1.契約數量 !== 1) return false;
  if (r1.本日完成數量 !== 1 || r1.累計完成數量 !== 1) return false;
  if (fee.項次 !== '貳' || fee.單位 !== '式') return false;   // 費用項是真項目
  if (fee.本日完成數量 !== 0.1 || fee.累計完成數量 !== 0.4) return false;
  if (fee.契約單價 !== null || fee.本日完成金額 !== null) return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '星期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '出工總人數', '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約數量', '本日完成數量', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parsePage, bands, pick },
};
