/**
 * baorong.pmisparser.js — 寶嶸營造有限公司施工日誌讀取器(橋頭國小暨許厝分校廁所整修)
 *
 * vendorKey 取自**決標公告的得標廠商**(`模板\決標公告\橋頭國小決標公告.pdf`,
 * 工程編號 A1150507);日誌的「施工廠商」欄也寫同一個名稱,兩邊一致。
 * ⚠️ 不是既有的「寶樹體育設備工程有限公司」,是另一家。
 *
 * ── 逐日資料在「工程進度表」,不在「施工日誌」分頁 ──
 * 活頁簿有六個分頁,而叫「施工日誌」的那個是**用公式抓當天的單日列印表單**
 * (234 列、只有一天)。照它讀的話,一份檔只讀得到一天。
 * 真正的逐日資料在 **`工程進度表`:矩陣型,一天一欄**。
 *
 * ── 矩陣的語意(用算式核對過,不是照標籤猜)──
 *   欄 9   逐列的標籤(日期／上午天氣／下午天氣／預定進度)
 *   欄 11  **當前選定日**的快照欄(日期是 7/31,而逐日欄是從 7/15 開始遞增)
 *   欄 12~191  逐日,一欄一天(180 天 = 核定工期)
 *   列 9/10 明細表頭(項次/工程項目/單位/數量/單價/合計/施作金額/權重…)
 *   列 11 起是明細,欄 0/1 是「當天」的本日/累計完成數量(公式算出來的)
 * **矩陣格放的是「該日完成數量」**:33 個項目逐列把欄 12~191 加總,
 * 33 個都等於欄 1 的累計完成數量。故累計完成數量由逐日累加求得——那是這份文件
 * 自己的結構,不是回推。
 *
 * ── 逐日欄要靠「日期遞增最長段」找,不能從第一個日期欄開始 ──
 * 欄 11 也印著日期(當前選定日 7/31),排在逐日欄(7/15 起)的**左邊**。
 * 從第一個有日期的欄開始收,第一天就會變成 7/31,整份的時序全錯。
 *
 * ── 此格式沒有的東西(一律 null,不回推)──
 * **沒有逐日的實際進度**(只有當前日那一格)、沒有本日完成金額、沒有累計金額、
 * 沒有出工人數。金額欄照 skill 的護欄:算得出來也不填,沒有就是沒有。
 * 預定進度有逐日值,照收。
 *
 * ── 檔案重複 ──
 * `橋頭施工日誌2026.xlsm`／`-7月.xlsm`／`(1).xlsx` 三份內容完全相同(許厝那三份同理),
 * 是同一份檔的不同存檔。依填報日期去重即可。
 */

const META_VENDOR_KEY = '寶嶸營造有限公司';

const SHEET = '工程進度表';
// 這家的日期是文字,而且斜線常常打成兩個(「2026//7/31」)
const DATE_RE = /(\d{4})\/+(\d{1,2})\/+(\d{1,2})/;
// 單位一律白名單(禁樣式判定:名稱裡的 RC/PVC 會被當成單位)
const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'kg', '噸', 'T',
  '公尺', '公斤', '平方公尺', '立方公尺', '場', '座', '組', '支', '個', '只', '片',
  '面', '處', '間', '棵', '株', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '才', '天', '日', '人']);

const nfkc = (v) => String(v == null ? '' : v).normalize('NFKC');
const despace = (v) => nfkc(v).replace(/[\s　]/g, '');

function text(v) {
  const s = nfkc(v).replace(/[\r\n]+/g, '').trim();
  return s === '' || s === '-' || s === '－' ? null : s;
}

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = nfkc(v).replace(/[,\s　%]/g, '');
  if (s === '' || s === '-' || s === '－') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const unitOf = (v) => {
  const s = despace(v);
  return s && KNOWN_UNITS.has(s) ? s : null;
};

function isoOf(v) {
  const m = nfkc(v).match(DATE_RE);
  if (!m) return null;
  return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
}

const at = (grid, r, c) => (grid && grid[r] ? grid[r][c] : undefined);

/** 找「欄 9 的標籤等於 label」的列(日期/上午天氣/下午天氣/預定進度)。 */
function rowOfLabel(grid, label) {
  for (let r = 0; r < (grid || []).length; r++) {
    for (let c = 0; c < (grid[r] || []).length; c++) {
      if (despace(grid[r][c]) === label) return r;
    }
  }
  return -1;
}

/**
 * 逐日欄 = 日期列裡**遞增最長的連續段**。
 *
 * 欄 11 是「當前選定日」的快照(日期 7/31),排在逐日欄(7/15 起)的左邊;
 * 從第一個有日期的欄開始收,第一天會變成 7/31,整份時序全錯。
 */
function dayColumns(dateRow) {
  const dates = (dateRow || []).map(isoOf);
  let best = [];
  let cur = [];
  for (let c = 0; c < dates.length; c++) {
    if (dates[c] == null) { if (cur.length > best.length) best = cur; cur = []; continue; }
    if (cur.length && dates[c] <= dates[cur[cur.length - 1]]) {
      if (cur.length > best.length) best = cur;
      cur = [];
    }
    cur.push(c);
  }
  if (cur.length > best.length) best = cur;
  return best;
}

/** 明細列:欄 2 有項次、欄 4 是已知單位(大類「壹／一」沒有單位,自然排除)。 */
function itemRows(grid, hr) {
  const out = [];
  for (let r = hr + 1; r < grid.length; r++) {
    const 項次 = text(at(grid, r, 2));
    const 單位 = unitOf(at(grid, r, 4));
    if (項次 == null || 單位 == null) continue;
    out.push({ r, 項次, 單位 });
  }
  return out;
}

/**
 * 解析「工程進度表」為逐日結構(純函式;selfTest 重用之)。
 * @param {Array<Array>} grid 工程進度表分頁
 * @param {object} [meta] 從其他分頁取來的固定欄位 { 工程名稱, 承包廠商, 開工日期 }
 */
function parseMatrix(grid, meta = {}) {
  const dr = rowOfLabel(grid, '日期');
  const hr = rowOfLabel(grid, '工程項目');
  if (dr < 0 || hr < 0) throw new Error('找不到「日期」列或明細表頭(此檔非寶嶸的工程進度表)');
  const cols = dayColumns(grid[dr]);
  if (!cols.length) throw new Error('工程進度表裡找不到逐日欄');

  const amr = rowOfLabel(grid, '上午天氣');
  const pmr = rowOfLabel(grid, '下午天氣');
  const plr = rowOfLabel(grid, '預定進度');
  const items = itemRows(grid, hr);

  const 累計 = new Map();
  const days = [];
  for (const c of cols) {
    const dailyRows = items.map(({ r, 項次, 單位 }) => {
      const 本日 = num(at(grid, r, c));
      const before = 累計.get(r) || 0;
      // 累計 = 逐日累加(矩陣本身的結構,33 個項目全部驗過 = 欄 1 的累計完成數量)。
      // 這一天沒有值時累計仍要往下帶,不可變成 null——否則 SP3 的 F1 會判成回退。
      const now = 本日 == null ? before : before + 本日;
      累計.set(r, now);
      return {
        項次,
        工程項目: text(at(grid, r, 3)),
        單位,
        契約單價: num(at(grid, r, 6)),
        契約數量: num(at(grid, r, 5)),
        本日完成數量: 本日,
        本日完成金額: null,                             // 此格式沒有金額,不由數量×單價回推
        累計完成數量: now,
      };
    });
    days.push({
      header: {
        工程名稱: meta.工程名稱 || null,
        填報日期: isoOf(at(grid, dr, c)),
        星期: null,                                     // 標了「星期」但值印的是日期,不收
        天氣_上午: amr < 0 ? null : text(at(grid, amr, c)),
        天氣_下午: pmr < 0 ? null : text(at(grid, pmr, c)),
        預定進度: plr < 0 ? null : num(at(grid, plr, c)),
        實際進度: null,                                  // 逐日沒有,只有當前日那一格
        出工總人數: null,                                // 此格式不提供
        本日累計金額: null,                              // 此格式沒有金額
        承包廠商: meta.承包廠商 || null,
        開工日期: meta.開工日期 || null,
      },
      dailyRows,
      extras: {},
    });
  }
  return days;
}

/** 從「施工日誌」單日表單那個分頁取固定欄位(工程名稱/廠商/開工日期)。 */
function fixedMeta(grid, serialToISO) {
  if (!grid) return {};
  const out = {};
  for (let r = 0; r < grid.length && r < 30; r++) {
    const row = grid[r] || [];
    for (let c = 0; c < row.length; c++) {
      const lab = despace(row[c]);
      if (lab !== '工程名稱:' && lab !== '施工廠商' && lab !== '開工日期:') continue;
      let v = null;
      for (let i = c + 1; i < row.length; i++) {
        if (despace(row[i]) === lab) continue;
        if (row[i] == null || String(row[i]).trim() === '') continue;
        v = row[i]; break;
      }
      if (v == null) continue;
      if (lab === '工程名稱:') out.工程名稱 = text(v);
      if (lab === '施工廠商') out.承包廠商 = text(v);
      if (lab === '開工日期:') {
        const n = num(v);
        out.開工日期 = n != null && serialToISO ? serialToISO(n) : isoOf(v);
      }
    }
  }
  return out;
}

/** 依填報日期去重(保留填得最多的那一份),並照時序輸出。 */
function dedupe(days) {
  const byDate = new Map();
  for (const d of days) {
    const k = d.header.填報日期;
    if (!k) continue;
    const score = (x) => x.dailyRows.filter((r) => r.本日完成數量 != null).length;
    const prev = byDate.get(k);
    if (!prev || score(prev) < score(d)) byDate.set(k, d);
  }
  return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, d]) => d);
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.readWorkbook !== 'function') throw new Error('缺少注入的 filetypes.readWorkbook');
  const wb = ft.readWorkbook(filePath);
  const sheets = (wb && wb.sheets) || {};
  if (!sheets[SHEET]) {
    // 回空陣列會被上游當成「這份沒有資料」而靜靜略過
    throw new Error(`找不到「${SHEET}」分頁(此檔非寶嶸日誌,或是無文字層的掃描件)`);
  }
  const meta = fixedMeta(sheets['施工日誌'], ft.excelSerialToISO);
  const days = parseMatrix(sheets[SHEET], meta);
  // 「還沒填的天」濾掉:範本把 180 天的日期都預先填好了,只有天氣或完成量能分辨
  // 哪幾天真的填過。兩個條件並用——只看完成量會讓「有到工、當天沒進度」的天消失。
  const filled = days.filter((d) => d.header.天氣_上午 != null || d.header.天氣_下午 != null
    || d.dailyRows.some((r) => r.本日完成數量 != null));
  if (!filled.length) throw new Error('工程進度表裡每一天都沒有天氣也沒有完成數量(這份還沒開始填)');
  return dedupe(filled);
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest 用**真實儲存格**造一份小矩陣(取自 `橋頭施工日誌2026.xlsm` 的
 * 工程進度表,只換工程名稱)。斷言各對著一個坑:欄 11 的快照不可被當成第一天、
 * 累計要逐日累加且不回退、大類列不可變成明細、沒有的欄位不可回推。
 */
function selfTest(ft) {
  const g = [];
  const set = (r, c, v) => { g[r] = g[r] || []; g[r][c] = v; };
  // 欄 11 = 當前選定日的快照(7/31),欄 12~15 才是逐日(7/15~7/18)
  const 日 = ['2026//7/31', '2026//7/15', '2026//7/16', '2026//7/17', '2026//7/18'];
  set(4, 9, '日期'); 日.forEach((v, i) => set(4, 11 + i, v));
  set(6, 9, '上午天氣'); set(6, 11, '晴'); set(6, 12, '晴'); set(6, 13, '晴'); set(6, 15, '雨');
  set(7, 9, '下午天氣'); set(7, 11, '晴'); set(7, 12, '晴'); set(7, 13, '陰'); set(7, 15, '雨');
  set(8, 9, '預定進度'); set(8, 11, 0.0492); set(8, 12, 0.002243); set(8, 13, 0.002243);
  set(9, 0, '本日完成\r\n數量'); set(9, 1, '累計完成\r\n數量'); set(9, 2, '項');
  set(9, 3, '工程項目'); set(9, 4, '單位'); set(9, 5, '數量'); set(9, 6, '單價'); set(9, 7, '合計');
  // 大類與中類:有項次、沒有單位 —— 不可變成明細
  set(11, 2, '壹'); set(11, 3, '發包工程費');
  set(12, 2, '一'); set(12, 3, '假設工程');
  const item = (r, no, name, unit, qty, price, cells) => {
    set(r, 2, no); set(r, 3, name); set(r, 4, unit); set(r, 5, qty); set(r, 6, price);
    Object.entries(cells).forEach(([c, v]) => set(r, Number(c), v));
  };
  item(13, '1', '工程告示牌與職安衛告示牌(租用)、施工圍籬、警示帶、安全警示燈等安全措施(租用)',
    '式', 1, 16250, { 0: 0, 1: 1, 15: 1 });
  item(14, '2', '施工動線開闢與損壞復原，既有設備管線遷移與復原；測量與放樣', '式', 1, 50000, { 0: 0, 1: 0 });
  item(15, '3', '拆除(含切割)集中廁所既有牆面、地坪、磁磚', '式', 1, 108000, { 0: 0.25, 1: 1, 12: 0.75, 14: 0.25 });
  item(44, '五', '營造綜合保險費 ', '式', 1, 8669, { 0: 0, 1: 1, 12: 1 });
  set(46, 7, 1993432);                                  // 總計列:沒有項次,不可變成明細

  const days = parseMatrix(g, { 工程名稱: '測試工程', 承包廠商: META_VENDOR_KEY, 開工日期: '2026-07-15' });
  // 逐日欄取的是遞增最長段(7/15~7/18),欄 11 的 7/31 快照不算
  if (days.length !== 4) return false;
  if (days[0].header.填報日期 !== '2026-07-15') return false;
  if (days[3].header.填報日期 !== '2026-07-18') return false;
  if (days[0].header.工程名稱 !== '測試工程') return false;
  if (days[0].header.承包廠商 !== META_VENDOR_KEY) return false;
  if (days[0].header.天氣_上午 !== '晴' || days[1].header.天氣_下午 !== '陰') return false;
  if (days[0].header.預定進度 !== 0.002243) return false;
  // 此格式沒有的:一律 null,不由數量×單價回推
  if (days[0].header.實際進度 !== null || days[0].header.本日累計金額 !== null) return false;
  if (days[0].dailyRows.some((r) => r.本日完成金額 != null)) return false;
  // 大類「壹／一」與總計列不可變成明細
  if (days[0].dailyRows.length !== 4) return false;
  const 名稱 = days[0].dailyRows.map((r) => r.工程項目);
  if (名稱.includes('發包工程費') || 名稱.includes('假設工程')) return false;
  // 項次 3:7/15 完成 0.75、7/17 再 0.25 → 累計 0.75 / 0.75 / 1 / 1(不回退)
  const 項3 = days.map((d) => d.dailyRows[2]);
  if (項3[0].本日完成數量 !== 0.75 || 項3[0].累計完成數量 !== 0.75) return false;
  if (項3[1].本日完成數量 !== null || 項3[1].累計完成數量 !== 0.75) return false;
  if (項3[2].累計完成數量 !== 1 || 項3[3].累計完成數量 !== 1) return false;
  // 逐日累加的期末累計要等於矩陣列的總和(= 該檔欄 1 的累計完成數量)
  if (days[3].dailyRows[0].累計完成數量 !== 1) return false;
  if (days[3].dailyRows[3].累計完成數量 !== 1) return false;
  if (項3[0].契約單價 !== 108000 || 項3[0].契約數量 !== 1 || 項3[0].單位 !== '式') return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '天氣_上午', '天氣_下午', '預定進度',
      '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約單價', '契約數量', '本日完成數量', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parseMatrix, dayColumns, itemRows, fixedMeta, dedupe },
};
