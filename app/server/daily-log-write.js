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
 * ## 費用項目的每日進度是系統推算的,不是讀來的
 *
 * 職安衛管理費、品管費、保商管理費、保險費、營業稅這幾項沒有施工實體,工地日誌
 * 不會記。承辦人以前是自己在這幾列每天填一個固定數字,系統則照日誌抄——而日誌
 * 有的寫金額、有的寫比例,單位都不一致。44 案對帳裡 87% 的「兩邊都有但不同」
 * 全出在這裡。故改由系統統一依契約工期平均推算。
 *
 * ⚠️ 這個數字是**算出來的,不是工地量出來的**。報表版面刻意不動(不加註記),
 * 標示放在系統畫面上——這是產品決定,不是因為報表上沒地方放。
 * 承辦人以前用的公式推不出來(文安案工期 56 天,平均應是 0.0179,實際填 0.0109),
 * 所以這裡不是「重現承辦人的算法」,是**另定一個講得清楚的規則**。
 */

const { isFeeItem } = require('./budget-sheet');

const FIRST_DATE_COL = 10;   // J
const LAST_DATE_COL = 762;   // ACH,範本鋪到這裡
const FIRST_ITEM_ROW = 2;    // 第 1 列是標題
const SHEET = '每日施工紀錄';

const MS_PER_DAY = 86400000;
const dayNum = (iso) => {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? Math.round(t / MS_PER_DAY) : null;
};

/**
 * 工期天數(含頭尾)。日期不合法、竣工早於開工、或超出範本鋪好的日期欄時回 0
 * ——回 0 代表「不推算」,讓費用項目維持照日誌的原行為。這裡刻意不丟錯:
 * 推算費用是輔助功能,不該讓一份本來寫得進去的日誌整份卡住。
 * @returns {number} 0 表示無法推算
 */
function 工期天數(開工日, 竣工日) {
  const a = dayNum(開工日);
  const b = dayNum(竣工日);
  if (a == null || b == null || b < a) return 0;
  const n = b - a + 1;
  return FIRST_DATE_COL + n - 1 > LAST_DATE_COL ? 0 : n;
}

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
 * 哪些項目會由系統推算、每天推算成多少。
 *
 * 抽成獨立函式是為了讓**畫面上的說明**與**實際寫進去的值**同一個來源:承辦人選的
 * 是「報表版面不動,改在系統畫面標示」,所以那句「這幾列是系統算的」必須跟寫入
 * 完全一致,不能是前端另外寫死的一段文案。
 *
 * 分母固定用**契約工期**,不是「目前收到幾天日誌」:後者會讓每收一批日誌,
 * 先前寫進去的數字全部作廢要重算重寫,承辦人看到的數字也會一直變。
 *
 * @param {Array<{項次:string, 項目:string, 數量:number}>} contract
 * @param {string} 開工日 ISO
 * @param {string} [竣工日] ISO
 * @returns {{工期天數:number, items:Array<{row:number,項次:string,項目:string,每日:number}>}}
 *   工期天數 0 代表無法推算(沒填竣工日等),此時 items 必為空
 */
function feeItemsPlan(contract, 開工日, 竣工日) {
  const span = 工期天數(開工日, 竣工日);
  const items = [];
  if (span) {
    (contract || []).forEach((c, row) => {
      if (!isFeeItem(c.項次)) return;
      const 每日 = Number(c.數量) / span;
      if (!Number.isFinite(每日)) return;
      items.push({ row, 項次: c.項次, 項目: c.項目, 每日 });
    });
  }
  return { 工期天數: span, items };
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
 * @param {string} [竣工日] ISO。有給才推算費用項目——沒有工期就算不出每天多少,
 *   這時維持「照日誌」的原行為,不要用猜的分母硬算。
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
  const rowOf = new Map(contract.map((c, i) => [String(c.項次), i]));
  const values = contract.map(() => new Array(width).fill(null));

  for (let i = 0; i < list.length; i++) {
    const col = offsets[i] - minOff;
    for (const row of list[i].dailyRows || []) {
      const idx = rowOf.get(String(row.項次));
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

  // 這幾道一定要排在主範圍**之後**:主範圍是一整塊矩形,會把它涵蓋到的費用格
  // 寫成 null,順序反了等於白算。一列一道而不是整塊,是因為費用項目未必連在一起,
  // 而涵蓋到施工項目的矩形會把先前批次寫進去的進度清成 null。
  const plan = feeItemsPlan(contract, 開工日, 竣工日);
  for (const f of plan.items) {
    ops.push({
      type: 'setRange',
      sheet: SHEET,
      startAddr: `${colName(FIRST_DATE_COL)}${FIRST_ITEM_ROW + f.row}`,
      values: [new Array(plan.工期天數).fill(f.每日)],
    });
  }

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

module.exports = {
  colName, daysToOperations, weatherToOperations, diffDays, feeItemsPlan,
  legacyFormulaOperations, SHEET, FIRST_DATE_COL, FIRST_ITEM_ROW,
};
