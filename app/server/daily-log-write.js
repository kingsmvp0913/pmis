/**
 * daily-log-write.js — 施工日誌 → 每日施工紀錄的寫入指令與跨批次差異(SP3,純函式)
 *
 * Exports:
 *   colName(n)                         欄序號 → Excel 欄名(J=10)
 *   daysToOperations(days, contract, 開工日)  → SP0 operations
 *   diffDays(舊, 新)                    → { added, changed, removed }
 *
 * ## 日期欄是公式錨定的
 *
 * 範本 `每日施工紀錄!J1 = 工程基本資料!B8`(開工日)、`K1=J1+1`…一路到 ACH
 * (約 753 天)。故「某天寫哪一欄」= `J + (填報日 − 開工日)`,完全 deterministic。
 * 換算錯一欄,整份進度會整體平移一天,而報表上完全看不出來。
 *
 * 列則對應契約詳細價目表的項次順序(該分頁靠 MATCH 項次拉同一個順序),
 * 第 2 列起。
 *
 * 每個項目（包括費用項目）都照施工日誌的每日完成數量寫入；日誌沒有值就留白。
 */

const FIRST_DATE_COL = 10;   // J
const LAST_DATE_COL = 762;   // ACH,範本鋪到這裡
const FIRST_ITEM_ROW = 2;    // 第 1 列是標題
const SHEET = '每日施工紀錄';
const { contractItemIndex, resolveContractItem } = require('./item-no');

const MS_PER_DAY = 86400000;
const dayNum = (iso) => {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? Math.round(t / MS_PER_DAY) : null;
};

/**
 * 欄序號 → Excel 欄名(1=A)。
 * @param {number} n
 * @returns {string}
 */
function colName(n) {
  let s = '';
  let v = n;
  while (v > 0) {
    const r = (v - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s;
}

/** 舊常駐報表仍有 NA() 與除以零公式；寫入日誌時同步升級既有項目列。 */
function legacyFormulaOperations(contract) {
  const count = (contract || []).length;
  const ops = [];
  for (let row = FIRST_ITEM_ROW; row < FIRST_ITEM_ROW + count; row++) {
    for (const col of ['A', 'B', 'C', 'D', 'E', 'F']) {
      ops.push({ type: 'setFormula', sheet: SHEET, addr: `${col}${row}`,
        formula: `=IF(契約詳細價目表!${col}${row}=\"\",\"\",契約詳細價目表!${col}${row})` });
    }
    ops.push({ type: 'setFormula', sheet: SHEET, addr: `H${row}`,
      formula: `=IF($E${row}=\"\",\"\",ROUND($G${row}*$E${row},0))` });
    ops.push({ type: 'setFormula', sheet: SHEET, addr: `I${row}`,
      formula: `=IF(OR($F${row}=\"\",$F${row}=0),\"\",ROUND($H${row}/$F${row},5))` });
  }
  const guarded = {
    B3: '"上午 : "&INDEX(監造內容!$1:$1048576,MATCH($H3,監造內容!B:B,0),3)&"      下午:"&INDEX(監造內容!A:O,MATCH($H3,監造內容!B:B,0),4)',
    B7: 'INDEX(每日施工紀錄!$1:$1048576,MATCH("預定進度",每日施工紀錄!A:A,0),MATCH($H$3,每日施工紀錄!1:1,0))',
    C6: 'INDEX(監造內容!$1:$1048576,MATCH($H3,監造內容!B:B,0),14)',
    F7: 'INDEX(每日施工紀錄!$1:$1048576,MATCH("實際進度",每日施工紀錄!A:A,0),MATCH($H$3,每日施工紀錄!$1:$1,0))',
    G5: 'INDEX(監造內容!$1:$1048576,MATCH($H3,監造內容!B:B,0),16)',
    I5: 'IF(INDEX(每日施工紀錄!$1:$1048576,MATCH("實際進度",每日施工紀錄!A:A,0),MATCH($H$3,每日施工紀錄!$1:$1,0))>=1,$H$3," ")',
    I7: 'INDEX(監造內容!A:O,MATCH($H3,監造內容!B:B,0),15)',
    O8: 'ROUND(F7-B7,5)',
  };
  for (const [addr, formula] of Object.entries(guarded)) {
    ops.push({ type: 'setFormula', sheet: '監造報表', addr, formula: `=IFERROR(${formula},"")` });
  }

  // 監造報表的工項列數會隨契約而變。舊版只補了固定位置的查表公式，沒有補這一段
  // 動態區域，日期尚未寫入或舊報表列數不一致時便整排 #N/A。列號以契約項目數推導，
  // 不綁定某一份報表：I10 起每項一列，最後一項後的監造內容欄位隔一列排放。
  ops.push({ type: 'setFormula', sheet: '監造報表', addr: 'G6',
    formula: '=IFERROR(SUM(INDEX(監造內容!$1:$1048576,MATCH($H3,監造內容!B:B,0),12),INDEX(監造內容!$1:$1048576,MATCH($H3,監造內容!B:B,0),13)),"")' });
  for (let row = 10; row < 10 + count; row++) {
    ops.push({ type: 'setFormula', sheet: '監造報表', addr: `I${row}`,
      formula: `=IFERROR(INDEX(每日施工紀錄!$1:$1048576,MATCH($A${row},每日施工紀錄!A:A,0),MATCH($H$3,每日施工紀錄!$1:$1,0)),"")` });
  }
  for (let index = 6, row = count + 11; index <= 9; index++, row += 2) {
    ops.push({ type: 'setFormula', sheet: '監造報表', addr: `A${row}`,
      formula: `=IFERROR(INDEX(監造內容!$1:$1048576,MATCH($H3,監造內容!B:B,0),${index}),"")` });
  }
  return ops;
}

/**
 * 把一批日誌組成寫入指令。
 *
 * 只產生**一個** setRange,範圍是這批日誌的最早日到最晚日:逐格 setCell 的話,
 * 80 天 × 39 項會生出 3120 道指令,Excel COM 逐格寫會慢到不能用。
 *
 * 範圍內沒有資料的日期(假日)寫 null——不能把後面的資料往前擠,擠了就是整段
 * 進度對到錯的日期。
 *
 * @param {Array<{header:object, dailyRows:Array}>} days
 * @param {Array<{項次:string, 數量:number}>} contract 契約詳細價目表(決定列順序)
 * @param {string} 開工日 ISO
 * @param {string} [竣工日] ISO（為相容既有呼叫保留，寫入不使用）
 * @returns {Array} operations
 * @throws {Error} 日期早於開工日或超出範本可容納的天數
 */
function daysToOperations(days, contract, 開工日, 竣工日) {
  const base = dayNum(開工日);
  if (base == null) throw new Error('開工日期不合法,無法定位日期欄');
  const list = (days || []).filter((d) => (d.header || {}).填報日期);
  if (!list.length) return [];

  const offsets = list.map((d) => {
    const off = dayNum(d.header.填報日期) - base;
    if (off < 0) {
      throw new Error(`填報日期 ${d.header.填報日期} 早於開工日 ${開工日},無欄可寫`);
    }
    if (FIRST_DATE_COL + off > LAST_DATE_COL) {
      throw new Error(`填報日期 ${d.header.填報日期} 超出監造報表可容納的天數`);
    }
    return off;
  });

  const minOff = Math.min(...offsets);
  const maxOff = Math.max(...offsets);
  const width = maxOff - minOff + 1;

  // 列順序完全依契約表:每日施工紀錄的項目列就是靠 MATCH 契約表項次拉出來的。
  const rowOf = new Map(contract.map((c, i) => [c, i]));
  const itemIndex = contractItemIndex(contract);
  const values = contract.map(() => new Array(width).fill(null));

  for (let i = 0; i < list.length; i++) {
    const col = offsets[i] - minOff;
    for (const row of list[i].dailyRows || []) {
      const idx = rowOf.get(resolveContractItem(row, itemIndex));
      // 契約表沒有的項次直接忽略:那是 E1 硬錯,驗證層已經擋下來了,
      // 走到寫入還在的話也沒有欄可以放。
      if (idx == null) continue;
      const v = row.本日完成數量;
      // 沒施工寫 null 而不是 0:0 是「今天做了 0 個單位」,null 是「今天沒有這項」。
      values[idx][col] = v == null || v === '' ? null : Number(v);
    }
  }

  const ops = [{
    type: 'setRange',
    sheet: SHEET,
    startAddr: `${colName(FIRST_DATE_COL + minOff)}${FIRST_ITEM_ROW}`,
    values,
  }];

  return ops;
}

const key = (r) => `${r.日期} ${r.項次}`;

/**
 * 跨批次差異。
 *
 * **這批沒送到的舊日期不算刪除**:施工日誌是分批提交的,第二批不含第一批的日期
 * 是常態,判成刪除會把已寫入的進度誤報成要清掉。只有「同一天重送但少了某個
 * 項次」才算刪除——那一項的數量該被清掉,留著會讓那天的累計多算。
 *
 * @param {Array<{日期:string,項次:string,本日完成數量:number|null}>} 舊
 * @param {Array} 新
 * @returns {{added:Array, changed:Array, removed:Array}}
 */
function diffDays(舊, 新) {
  const oldMap = new Map((舊 || []).map((r) => [key(r), r]));
  const newMap = new Map((新 || []).map((r) => [key(r), r]));
  const 本批日期 = new Set((新 || []).map((r) => r.日期));

  const added = [];
  const changed = [];
  for (const [k, n] of newMap) {
    const o = oldMap.get(k);
    if (!o) { added.push(n); continue; }
    if (Number(o.本日完成數量) !== Number(n.本日完成數量)) {
      changed.push({ 日期: n.日期, 項次: n.項次, 舊: o.本日完成數量, 新: n.本日完成數量 });
    }
  }
  const removed = [...oldMap]
    .filter(([k, o]) => 本批日期.has(o.日期) && !newMap.has(k))
    .map(([, o]) => o);

  return { added, changed, removed };
}

/* ─────────────────── 監造內容分頁的天氣 ─────────────────── */

const 監造內容 = '監造內容';
const 監造內容_首列 = 3;    // 第 1 列是欄位標題、第 2 列是「上午/下午」子標題
const 監造內容_末列 = 763;  // B 欄的日期公式(B3=開工日、B4=B3+1…)鋪到這裡

/**
 * 施工日誌的天氣 → 監造內容分頁的 C/D 欄。
 *
 * 這一頁是**逐日一列**(B3=開工日、B4=B3+1…),與每日施工紀錄的「逐日一欄」
 * 是同一套日期換算,只是換了軸。列 = 3 + (填報日 − 開工日)。
 *
 * 為什麼要做:49 個舊案的人工報表這兩欄**全部都有填**,而系統一格都沒寫——
 * 承辦人打開監造內容就是整片空白。28 案是逐日不同的真天氣(晴/雨/陰/豪雨/雷雨),
 * 另外 21 案整份填「晴」;讀取器本來就有 `天氣_上午`/`天氣_下午`,只是沒人用。
 *
 * C2/D2 的「上午」「下午」子標題一併寫:公版範本漏了這兩格(人工報表有),
 * 而報表是常駐檔——放在寫入指令裡,既有的專案報表也會一起補上。
 *
 * 越界不 throw:天氣是附帶資訊,不該讓一份日誌因為它寫不進去而整份卡住
 * (數量本身的越界已由 daysToOperations 擋在前面)。
 *
 * ⚠️ **一定要出 setRange 不能逐格 setCell。** 每個 setCell 是一次 COM 往返,
 * 一份 87 天的日誌就是 174 次;實測簡易棒球場的指令數 11 → 185、耗時 12s → 24s,
 * 而 Excel COM 本來就會偶發 `RPC_E_CALL_REJECTED`(見 template-engine 的重試),
 * 把單案時間拉長一倍等於把失敗率往上推。改成整段寫之後是 11 → 14 道。
 *
 * **切成連續區段而不是一整塊。** 中間跳過的日期若也寫進去(值為 null),會把
 * 前一批日誌已經寫好的那幾天清空——施工日誌分多次提交是常態。
 *
 * @param {Array} days 讀取器輸出的逐日結果
 * @param {string} 開工日 ISO 日期
 * @returns {Array} operations;沒有任何天氣可寫時回空陣列
 */
function weatherToOperations(days, 開工日) {
  const base = dayNum(開工日);
  if (base == null) return [];

  const byRow = new Map();
  for (const d of days || []) {
    const h = d.header || {};
    if (!h.填報日期) continue;
    const 上午 = h.天氣_上午 == null ? '' : String(h.天氣_上午).trim();
    const 下午 = h.天氣_下午 == null ? '' : String(h.天氣_下午).trim();
    if (!上午 && !下午) continue;
    const off = dayNum(h.填報日期) - base;
    if (off == null || off < 0) continue;
    const row = 監造內容_首列 + off;
    if (row > 監造內容_末列) continue;
    // 同一天出現兩次(重送)時以後面那份為準,與 daysToOperations 同一個立場
    byRow.set(row, [上午 || null, 下午 || null]);
  }
  if (!byRow.size) return [];

  const rows = [...byRow.keys()].sort((a, b) => a - b);
  const ops = [
    { type: 'setCell', sheet: 監造內容, addr: 'C2', value: '上午' },
    { type: 'setCell', sheet: 監造內容, addr: 'D2', value: '下午' },
  ];
  let 起 = rows[0];
  let 段 = [byRow.get(起)];
  for (let i = 1; i <= rows.length; i++) {
    if (i < rows.length && rows[i] === rows[i - 1] + 1) { 段.push(byRow.get(rows[i])); continue; }
    ops.push({ type: 'setRange', sheet: 監造內容, startAddr: `C${起}`, values: 段 });
    if (i < rows.length) { 起 = rows[i]; 段 = [byRow.get(起)]; }
  }
  return ops;
}

// 與 report-workbook.js 的 PROGRESS_LABELS 同序:合計列 +0 起
const 進度標籤 = ['(合計)', '每日實際進度(%)', '實際進度', '總實際進度(%)', '每日預定進度(%)', '預定進度'];
// 與現行公版範本 J290 同一條:依工期(B7)與開工日(B8)的直線,兩者缺一為 0
const 預定進度公式 = '=IF(OR(工程基本資料!$B$7="",工程基本資料!$B$7=0,工程基本資料!$B$8=""),0,'
  + 'MIN(1,MAX(0,(J$1-工程基本資料!$B$8+1)/工程基本資料!$B$7)))';

/**
 * 補舊常駐報表的進度區塊(量法見 report-workbook.js 的 progressBlock)。
 *
 * 8/11 以前建的專案報表,每日施工紀錄少了「實際進度」「預定進度」等 A 欄標籤與
 * 預定進度那一列公式:監造報表 B7/F7 以標籤 MATCH 找列,找不到就每天都印空白。
 * 只補缺的——有值的標籤不重寫,預定進度列有手填值(承辦人照廠商日誌打的)就不蓋。
 *
 * ⚠️ 要排在**所有會刪列的指令之前**:列號是寫入前量的,刪項目列會把整段往上帶。
 *
 * @param {{合計列:number, 末欄:string, 缺標籤列:number[], 預定列空:boolean}|null} block
 */
function progressBlockOperations(block) {
  if (!block) return [];
  const ops = [];
  for (const r of block.缺標籤列 || []) {
    const i = r - block.合計列;
    if (i < 0 || i >= 進度標籤.length) continue;
    ops.push({ type: 'setCell', sheet: SHEET, addr: `${i === 0 ? 'B' : 'A'}${r}`, value: 進度標籤[i] });
  }
  if (block.合計範圍不足) {
    // 加到合計列上一列為止;空列與公式回 "" 的列,SUMPRODUCT 一律當 0
    const r = block.合計列;
    ops.push({ type: 'setFormula', sheet: SHEET, addr: `J${r}:${block.末欄}${r}`,
      formula: `=ROUND(SUMPRODUCT($E$2:$E$${r - 1},J$2:J$${r - 1}),0)` });
  }
  if (block.預定列空) {
    const r = block.合計列 + 6;
    ops.push({ type: 'setFormula', sheet: SHEET, addr: `J${r}:${block.末欄}${r}`, formula: 預定進度公式 });
  }
  return ops;
}

/**
 * 廠商日誌的實際進度是百分數還是比例(各家讀取器不一)。回傳要除的數:100 或 1。
 *
 * 只看大小會在開工頭幾天誤判(真的只有 0.6%),故拿完成金額推得的實際進度 ref(比例)
 * 當參考,取換算後與它比值最接近 1 的那個尺度;ref 算不出來才退回「> 1.05 即百分數」。
 */
function vendorProgressDivisor(v, ref) {
  if (v == null || !Number.isFinite(Number(v))) return 1;
  const n = Math.abs(Number(v));
  if (ref == null || !(Number(ref) > 0) || n === 0) return n > 1.05 ? 100 : 1;
  const 偏差 = (d) => Math.abs(Math.log((n / d) / Number(ref)));
  return 偏差(100) < 偏差(1) ? 100 : 1;
}

const 廠商進度標籤 = '廠商填報實際進度';

/**
 * 廠商日誌的實際進度 → 每日施工紀錄合計列 +7(列印範圍外的核對列),與公式算的
 * 「實際進度」同一個日期欄,上下對照。報表的實際進度仍由公式算,不覆蓋:
 * 廠商的算法多少有差,直接填會把差異藏起來(Summer 2026-10-01)。
 *
 * 只寫有值的日子、切成連續區段——沒填的那天寫 null 會把別批寫好的值清掉。
 *
 * @param {Array} days
 * @param {string} 開工日 ISO
 * @param {object|null} block progressBlock 的結果
 * @param {Object<string, number>} refByDate 日期 → 依完成金額推得的實際進度(比例),
 *   逐日判斷尺度用(見 vendorProgressDivisor)。**不可整批判一次**:久木的 xls 回比例、
 *   PDF 回百分數,7~9 月一起送時同一批混著兩種,整批判會把 8 月印成 2465%。
 */
function vendorProgressOperations(days, 開工日, block, refByDate) {
  if (!block) return [];
  const base = dayNum(開工日);
  if (base == null) return [];
  const row = block.合計列 + 7;
  const byOff = new Map();
  for (const d of days || []) {
    const h = d.header || {};
    const v = h.實際進度 == null || h.實際進度 === '' ? null : Number(h.實際進度);
    if (!h.填報日期 || v == null || !Number.isFinite(v)) continue;
    const off = dayNum(h.填報日期) - base;
    if (off < 0 || FIRST_DATE_COL + off > LAST_DATE_COL) continue;
    const divisor = vendorProgressDivisor(v, (refByDate || {})[h.填報日期]);
    byOff.set(off, Number((v / divisor).toFixed(8)));
  }
  if (!byOff.size) return [];
  const ops = (block.廠商列雜項 || []).map((addr) => ({ type: 'setCell', sheet: SHEET, addr, value: null }));
  if (block.廠商標籤缺) ops.push({ type: 'setCell', sheet: SHEET, addr: `A${row}`, value: 廠商進度標籤 });
  const offs = [...byOff.keys()].sort((a, b) => a - b);
  let 起 = offs[0];
  let 段 = [byOff.get(起)];
  for (let i = 1; i <= offs.length; i++) {
    if (i < offs.length && offs[i] === offs[i - 1] + 1) { 段.push(byOff.get(offs[i])); continue; }
    ops.push({ type: 'setRange', sheet: SHEET, startAddr: `${colName(FIRST_DATE_COL + 起)}${row}`, values: [段] });
    if (i < offs.length) { 起 = offs[i]; 段 = [byOff.get(起)]; }
  }
  return ops;
}

module.exports = {
  colName, daysToOperations, weatherToOperations, diffDays,
  legacyFormulaOperations, progressBlockOperations, vendorProgressOperations, vendorProgressDivisor,
  SHEET, FIRST_DATE_COL, FIRST_ITEM_ROW,
};
