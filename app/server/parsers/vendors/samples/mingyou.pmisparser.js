/**
 * mingyou.pmisparser.js — 銘佑營造有限公司(龍井國小廁所)施工日誌讀取器
 *
 * vendorKey 取自決標公告(`龍井國小廁所決標公告.pdf` → 銘佑營造有限公司)。
 * ⚠️ 同一所學校還有另一案「龍井國小新建綜合球場」,得標廠商是**經緯營造股份有限公司**
 * (讀取器 `jingwei`),兩案的日誌別搞混。
 *
 * ── 這是**無文字層的掃描件**,走 OCR ──
 * `龍井國小七月份施工日誌.pdf` 4 頁 = 封面 + 3 天(7/29~7/31),`extractItems` 回 0 個 item。
 * 走 `ctx.filetypes.extractItemsOcr`(把 OCR 的字框換算成與 extractItems 同形狀的 items)。
 * 實測 2200px、38 秒;涵蓋範圍偵測(日期/星期/天氣)100% 正確。
 *
 * ── 版面事實(實測第 2 頁,座標為 OCR 換算後的點)──
 * **雙欄**,同一份明細被切成左右兩半,右欄**接在左欄之後**(不是交錯):
 *   左欄 施工項目 x44~150 / 單位 x155 / 派工數量 x184~195 / 本日完成 x237 / 累計完成 x277
 *   右欄 施工項目 x295~390 / 單位 x397 / 派工數量 x441 / 本日完成 x497 / 累計完成 x532
 * 明細區:表頭列(含「施工項目」)之下,到「營造業專業工程特定施工項目」為止。
 *
 * ── ⚠️ 列錨一定要用「派工數量」,不可以用單位 ──
 * 這份每天都印完整的 35 項,而且順序與發包後經費總表一字不差,所以**項次用出現序**。
 * 但出現序的前提是「一列都不能漏」——實測 7/30 那頁的「片」(項次19 的單位)
 * **OCR 沒讀到**:以單位當列錨會少一列,而**後面 16 項全部位移一格**,
 * 每一格都還是合法數字,SP3 一條都不會叫。
 * 改以派工數量當錨:三天的左欄都是
 *   1 1 1 1 1 1 40 1 592 327 26 129 5 364 138 2 331 129 4 22 1
 * 右欄都是 23 1 1 …(14 個),與契約表 35 項完全一致。
 * 數量欄一律兩位小數(`1.00`),下方人員機具表的數字是裸整數(`1`/`4`/`0`),
 * 形態本身就分得開——但仍以「明細區下界」為準,不靠形態。
 *
 * ── 名稱照收,不修 OCR 錯字 ──
 * 掃描件的名稱有固定的錯字(`乙種施工团`=圍、`速工带料`=連工帶料、`给排水`、`折除`、
 * `搞播`、`范圍`、`练材`、`黄任`)。**不做模糊比對、不改寫**:項次靠出現序已經對得上,
 * 名稱錯只會讓 SP3 的 E3 出軟警告(那正是要讓承辦人看到的),
 * 改寫來源反而會把「OCR 讀錯」偽裝成「廠商就是這樣寫」。
 */

const META_VENDOR_KEY = '銘佑營造有限公司';

// 兩欄的分界。左欄最右是累計完成數量(x~278),右欄最左是施工項目(x~295)。
const COL_SPLIT = 290;
const 左 = { 名稱: 40, 單位: 152, 數量: 170, 本日: 215, 累計: 262, 界: COL_SPLIT };
const 右 = { 名稱: 292, 單位: 394, 數量: 415, 本日: 470, 累計: 512, 界: 600 };

// 派工數量(=契約數量)一律兩位小數。裸整數是下方人員機具表的數字。
const QTY_RE = /^\d{1,5}\.\d{2}$/;
const NUM_RE = /^-?\d{1,6}(\.\d{1,3})?$/;
const DASH_RE = /^[-－—–]+$/;

// 費用項目的項次是中文大寫,不在出現序裡。名稱即使帶 OCR 錯字也認得出來
// (實測 `營造综合保險費` 的「綜」被讀成簡體「综」,關鍵詞仍在)。
const FEE_ORDER = ['貳', '參', '肆', '伍', '陸'];
const FEE_RE = /(安全衛生管理費|品質管制作業費|利潤及管理費|管理費及利潤|保險費|營業稅)/;

// OCR 對中文會逐字插空格,而**插進去的空格不是來源的內容**——實測同一個項目
// 三天分別讀成「營業稅（（壹~伍）*5%）」「營 業 稅（（ 壹~伍）*5%）」
// 「營 業 稅(（壹~ 伍）*5%）」。不清掉的話:①費用項目認不出來(項次變成 31、32)
// ②SP3 的 E3 每天報一次名稱不一致。
// **只清「中文與中文之間」的空格**:數字之間的空格要留著(清掉會把 115 7 29 黏成
// 一個數字),英數與中文之間也留著(那多半是真的排版)。
const despaceCjk = (s) => String(s == null ? '' : s)
  .replace(/([一-鿿])[ \t　]+(?=[一-鿿])/g, '$1');

const text = (v) => {
  const s = despaceCjk(v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
  return s === '' || DASH_RE.test(s) ? null : s;
};

function numOf(v) {
  const s = v == null ? '' : String(v).replace(/[,\s　]/g, '');
  if (s === '' || DASH_RE.test(s)) return null;
  if (!NUM_RE.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 民國「115年7月29日」→ ISO。 */
function rocToISO(s) {
  const t = String(s == null ? '' : s).replace(/[\s　]/g, '');
  const m = /(\d{2,3})年(\d{1,2})月(\d{1,2})/.exec(t);
  if (!m) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${Number(m[1]) + 1911}-${p(Number(m[2]))}-${p(Number(m[3]))}`;
}

const between = (items, lo, hi) => items.filter((i) => i.x >= lo && i.x < hi);
// 一個「帶」可能跨好幾行(跨行的長名稱),接的順序要**先由上而下、再由左而右**。
// 只依 x 排會把第二行接到第一行前面——實測項次 27 的名稱會變成
// 「件,各層樓每間廁所皆有求救鈕…施做緊急求救按鈕(」,頭尾顛倒。
const joinText = (items) => text(items.slice()
  .sort((a, b) => (Math.abs(a.y - b.y) > 1.5 ? b.y - a.y : a.x - b.x))
  .map((i) => i.s).join(''));

/**
 * 一欄的明細列。以派工數量為錨(見檔頭)。
 *
 * ── 名稱:歸給「它下方最近的那個錨」 ──
 * 長名稱會跨 2 行,而**數值一定印在名稱區塊的最後一行**
 * (項次 4:名稱 664.8 與 656.1、數值 656.1;項次 8、17 同樣)。
 * 所以續行永遠在錨的**上方**,規則就是「每個名稱格歸給 y ≤ 自己的最近錨」。
 * 用「上一個錨到本錨之間」會把續行判給上一列——那不會有任何欄位變 null。
 *
 * ── 單位:在錨的**下方**約 5pt ──
 * 實測項次 1 錨 697.3 / 單位 692.1、項次 2 錨 684.8 / 單位 679.7。
 * 但項次 4 的單位與錨同一行(656.1),而它上面那行(664.8)也有一個「式」
 * ——那是同一個合併格被 OCR 讀了兩次。取「錨下方一個列距內、最靠近錨」的那一格,
 * 兩種情形都對,也不會把上一列的單位收過來。
 */
function columnRows(items, C, 上界, 下界) {
  const 區 = items.filter((i) => i.y < 上界 && i.y > 下界);
  const anchors = between(區, C.數量, C.本日)
    .filter((i) => QTY_RE.test(String(i.s).trim()))
    .sort((a, b) => b.y - a.y);
  if (!anchors.length) return [];

  // 列距:相鄰錨的間距中位數。寫死會在換解析度時整份錯開。
  const gaps = anchors.slice(1).map((a, i) => anchors[i].y - a.y).sort((x, y) => x - y);
  const 列距 = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 13;

  const 名稱格 = between(區, C.名稱, C.單位);
  const 單位格 = between(區, C.單位, C.數量);
  const 歸屬 = new Map(anchors.map((a) => [a, []]));
  for (const n of 名稱格) {
    // y ≤ 自己 的錨裡取最上面那一個 = 「下方最近的錨」
    const a = anchors.filter((x) => x.y <= n.y + 1).sort((p, q) => q.y - p.y)[0];
    if (a) 歸屬.get(a).push(n);
  }

  return anchors.map((a) => {
    const u = 單位格.filter((i) => i.y <= a.y + 1 && i.y > a.y - 列距)
      .sort((p, q) => q.y - p.y)[0];
    const 同列 = 區.filter((i) => Math.abs(i.y - a.y) <= 1.5);
    return {
      工程項目: joinText(歸屬.get(a)),
      // 讀不到就 null——7/30 那頁的「片」OCR 沒讀到,補一個猜的值會讓 E4 判成廠商寫錯。
      單位: u ? text(u.s) : null,
      契約單價: null,                                   // 此格式沒有單價欄
      契約數量: numOf(a.s),
      本日完成數量: numOf(joinText(between(同列, C.本日, C.累計))),
      本日完成金額: null,                               // 同上
      累計完成數量: numOf(joinText(between(同列, C.累計, C.界))),
    };
  });
}

/**
 * 把**橫跨兩欄的 item 切開**。
 *
 * 雙欄版面上,左欄的最後一格與右欄的第一格會被 OCR 讀成同一個 item:
 * 實測 `[x278 w108]"0.50貼深色石材 面(t=2cm,倒圆角)"` —— 前面 4 個字是左欄的
 * 累計完成數量、其餘是右欄的施工項目。不切開的話**兩邊一起壞**:
 * 左欄的累計變 null(整串不是數字),右欄那一列的名稱也變 null。
 *
 * 切點優先取「開頭那個數字結束的位置」(那才是真正的欄界),
 * 取不到才退回以 COL_SPLIT 換算的字元位置——`w / s.length` 推出來的字元寬度
 * 有捨入誤差,實測用 COL_SPLIT 會把「0.50」切成「0.5」。
 */
function splitAtColumn(list) {
  const out = [];
  for (const it of list) {
    const s = String(it.s == null ? '' : it.s);
    const w = it.w || 0;
    // **整串就是一個數字時絕不切**。數字不可能橫跨兩欄,而 `w / s.length` 推出來的
    // 字元寬度有捨入誤差:實測「0.00」(x278 w19)算出來的切點是 3,會被切成
    // 「0.0」+「0」,右欄每一列的名稱前面就多一個 0。
    if (!s || w <= 0 || it.x >= COL_SPLIT || it.x + w <= COL_SPLIT || s.length < 2
      || NUM_RE.test(s.trim())) {
      out.push(it);
      continue;
    }
    // 切點**只認「開頭是一個完整數字」**這一種形態,不用 COL_SPLIT 換算字元位置。
    // 位置式切點會誤傷單純比較寬的格子:工程名稱那一格(x113、跨到 x293)也「橫跨」
    // COL_SPLIT,被切成「…國民中小學老舊廁」+「所整修工程」,整個工程名稱就抽不到。
    // 真正的跨欄只發生在「左欄的數值 + 右欄的名稱」被讀成一格,而它一定以數字開頭。
    //
    // `(?![\d.])` 不可省:少了它,`\d{1,6}` 會回溯成部分比對——「1.00」被切成
    // 「1.0」+「0」,右欄每一列的名稱前面就多一個 0。
    const m = /^(-?\d{1,6}(?:\.\d{1,3})?)(?![\d.])(.+)$/.exec(s);
    if (!m) { out.push(it); continue; }
    const per = w / s.length;
    const cut = m[1].length;
    if (cut <= 0 || cut >= s.length) { out.push(it); continue; }
    out.push({ ...it, s: s.slice(0, cut), w: per * cut });
    out.push({ ...it, s: s.slice(cut), x: it.x + per * cut, w: per * (s.length - cut) });
  }
  return out;
}

/**
 * 一頁 = 一天。左欄的列在前、右欄的列在後(這是版面事實:右欄是左欄的續接)。
 * 項次用出現序;末尾的費用項目改用中文大寫,與發包後經費總表一致。
 */
function parsePage(raw) {
  // 先把橫跨兩欄的 item 切開,再做任何欄位歸屬(見 splitAtColumn)。
  const items = splitAtColumn(raw);
  // ⚠️ 表頭要**逐字相等**,不可以用 `/施工項目/` 比對:同一頁上方那句
  // 「一、依施工計畫書執行按圖施工概況(含約定之重要**施工項目**及完成數量等):」
  // 也含這四個字,而它在表頭**上面**——抓到它會讓上界高過真表頭,
  // 於是表頭那一列自己被當成明細,第 1 列的名稱尾巴多出「施工項目」四個字。
  const 表頭 = items.filter((i) => String(i.s).replace(/\s/g, '') === '施工項目')
    .sort((a, b) => b.y - a.y).pop();
  const 下界物 = items.find((i) => /營造業專業工程特定施工項目/.test(String(i.s)));
  if (!表頭) return null;
  const 上界 = 表頭.y - 1;
  const 下界 = 下界物 ? 下界物.y : -Infinity;

  const rows = [
    ...columnRows(items.filter((i) => i.x < COL_SPLIT), 左, 上界, 下界),
    ...columnRows(items.filter((i) => i.x >= COL_SPLIT), 右, 上界, 下界),
  ];

  // 費用項目在最後,依名稱認出來(見檔頭 FEE_RE);其餘依出現序編號。
  let n = 0;
  let f = 0;
  for (const r of rows) {
    // 比對前一定要再去一次空白:OCR 會把「營業稅」讀成「營 業 稅」,
    // 帶著空格比對認不出來 → 費用項目被編成 31、32,而契約表裡沒有那兩個項次。
    if (r.工程項目 && FEE_RE.test(String(r.工程項目).replace(/[\s　]/g, ''))
      && f < FEE_ORDER.length) {
      r.項次 = FEE_ORDER[f];
      f += 1;
    } else {
      n += 1;
      r.項次 = String(n);
    }
  }

  const 找 = (re) => {
    const hit = items.find((i) => re.test(String(i.s)));
    return hit ? String(hit.s) : null;
  };
  const 日期列 = items.filter((i) => /填表日期|115年|116年/.test(String(i.s)))
    .map((i) => String(i.s)).join(' ');
  const 天氣 = 找(/本日天氣/) || '';
  const wm = /上午[:：]?\s*(\S+?)\s*下午[:：]?\s*(\S+)/.exec(天氣.replace(/\s+/g, ''));
  const 進度 = items.map((i) => String(i.s)).join(' ');
  const pm = /預定進度（?%）?\s*([\d.]+)%/.exec(進度.replace(/\s+/g, ''));
  const am = /實際進度（?%）?\s*([\d.]+)%/.exec(進度.replace(/\s+/g, ''));

  return {
    header: {
      工程名稱: text((/工程名稱/.test(找(/工程名稱/) || '') ? null : null))
        || text((items.find((i) => /老舊廁所整修工程/.test(String(i.s))) || {}).s),
      填報日期: rocToISO(日期列),
      星期: (/(星期[一二三四五六日天])/.exec(進度) || [])[1] || null,
      天氣_上午: wm ? text(wm[1]) : null,
      天氣_下午: wm ? text(wm[2]) : null,
      預定進度: pm ? Number(pm[1]) : null,
      實際進度: am ? Number(am[1]) : null,
      出工總人數: null,
      本日累計金額: null,
      承包廠商: text((items.find((i) => /營造有限公司/.test(String(i.s))) || {}).s),
      開工日期: rocToISO((items.find((i) => /開工日期/.test(String(i.s))) || {}).s
        || (/開工日期\s*(\S+)/.exec(進度) || [])[1] || ''),
    },
    dailyRows: rows,
    extras: {},
  };
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.extractItemsOcr !== 'function') {
    throw new Error('缺少注入的 filetypes.extractItemsOcr(此格式是無文字層的掃描件)');
  }
  const pages = await ft.extractItemsOcr(filePath, { width: 2200 });
  const out = [];
  for (const p of pages) {
    const day = parsePage(p.items || p);
    // 封面頁沒有明細表頭,parsePage 回 null;有表頭但一列都沒有的頁也不收。
    if (!day || !day.dailyRows.length) continue;
    if (!day.header.填報日期) continue;
    out.push(day);
  }
  if (!out.length) throw new Error('讀不到任何一天的明細(非銘佑的掃描件格式?)');
  return out;
}

async function parse(filePath, ctx) {
  const all = await parseAll(filePath, ctx);
  return all[0] || null;
}

// 內建座標樣本(抄自 7/29 那頁的真實 OCR 輸出,只留兩列與必要的邊界)。
// 不需要注入:座標版的 selfTest 就是一組 {x,y,s}。
function selfTest() {
  const it = (x, y, s) => ({ x, y, s, w: 10, h: 6 });
  const items = [
    it(83, 709, '施工項目'), it(154, 709, '單位'), it(173, 709, '派工數量'),
    it(325, 709, '施工項目'), it(395, 709, '單位'), it(425, 709, '派工數量'),
    it(46, 698, '乙種施工团 、警示帶、安全警示燈等安全措施（租用）'),
    it(191, 698, '1.00'), it(237, 698, '0.5'), it(278, 698, '0.50'),
    it(156, 692, '式'),
    it(295, 698, '貼深色石材 面（t=2cm，倒圆角）'),
    it(397, 692, '才'), it(441, 692, '23.00'), it(532, 692, '0.00'),
    it(295, 685, '營業稅（（壹~伍）*5%）'),
    it(397, 680, '式'), it(443, 680, '1.00'), it(532, 680, '0.00'),
    it(45, 408, '營造業專業工程特定施工項目'),
    it(443, 793, '115年7月29日'),
  ];
  const d = parsePage(items);
  if (!d || d.dailyRows.length !== 3) return false;
  // 左欄在前、右欄在後
  if (d.dailyRows[0].項次 !== '1' || d.dailyRows[0].單位 !== '式') return false;
  if (d.dailyRows[0].契約數量 !== 1 || d.dailyRows[0].累計完成數量 !== 0.5) return false;
  if (d.dailyRows[1].項次 !== '2' || d.dailyRows[1].契約數量 !== 23) return false;
  // 費用項目改用中文大寫、不佔出現序;這個小樣本裡它是第一個費用項,故為「貳」。
  if (d.dailyRows[2].項次 !== '貳') return false;
  // OCR 逐字插的空格要清掉,否則費用項目認不出來、E3 也會每天報一次
  if (d.dailyRows[2].工程項目 !== '營業稅（（壹~伍）*5%）') return false;
  return d.header.填報日期 === '2026-07-29';
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '星期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約數量', '本日完成數量', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parsePage, columnRows, rocToISO },
};
