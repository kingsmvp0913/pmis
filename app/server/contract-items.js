/**
 * contract-items.js — 契約詳細價目表的選表、卡控與差異比對(SP2,純函式)
 *
 * Exports:
 *   selectSheets(files, 決標金額) → { matched, items, 合計, candidates }
 *   validateItems(items)          → 硬錯清單
 *   diffItems(舊, 新)             → { added, removed, changed }
 *
 * ## 為何要「選表」這件事存在
 *
 * 實測 5 個檔案的第一張詳細價目表,施工小計**全都是 1,185,308**——那是南陽的
 * 數字,這些檔案都是拿南陽那份改的,第一張是沒改到的殘留。照分頁名稱挑會 100%
 * 挑到錯的那張,而且錯得看起來完全正常(版面、項目數、格式都對)。
 *
 * 唯一客觀的判準是決標金額:價目表合計必須等於它。實測 30 份有明細的樣本,
 * 施工項目 + 費用項目的複價和 = 表上「發包工程費合計」,無一例外。
 */

/** 台灣四捨五入。範本 F 欄是 ROUND(E*D,0),驗算要用同一種捨入。 */
function roundHalfUp(n) {
  if (!Number.isFinite(Number(n))) return null;
  const v = Number(n);
  const r = Math.floor(Math.abs(v) + 0.5 + Number.EPSILON);
  return v < 0 ? -r : r;
}

/**
 * 以決標金額挑出該用哪一張(或哪幾張)候選分頁。
 *
 * 搜尋空間刻意限制成「**每個檔案至多取一張**」:同一個檔的兩張表是同一份工程的
 * 舊版與新版,相加沒有意義;不設限的話會生出一堆湊得出數字但荒謬的組合。
 * 跨檔案相加則是真實需求(重興:廁所 871,943 + 汙水 812,102 = 1,684,045)。
 *
 * @param {Array<{file:string, candidates:Array<{name:string,items:Array,合計:number}>}>} files
 * @param {number} 決標金額
 * @returns {{matched:Array|null, items:Array, 合計:number, candidates:Array}}
 *   matched 為 null 代表沒有唯一解(全部對不上、或命中多組),此時 candidates
 *   列出所有候選讓承辦人自己挑——系統挑哪一組都可能是錯的。
 */
function selectSheets(files, 決標金額) {
  const list = (files || []).map((f) => ({
    file: f.file,
    candidates: (f.candidates || []).map((c) => ({ ...c, file: f.file })),
  }));
  const all = list.flatMap((f) => f.candidates);
  const target = Number(決標金額);

  const hits = [];
  // 每個檔取 0 或 1 張:以檔為單位遞迴,天然排除同檔兩張的組合。
  const walk = (idx, picked, sum) => {
    if (idx === list.length) {
      if (picked.length && sum === target) hits.push(picked.slice());
      return;
    }
    walk(idx + 1, picked, sum); // 這個檔不取
    for (const c of list[idx].candidates) {
      picked.push(c);
      walk(idx + 1, picked, sum + c.合計);
      picked.pop();
    }
  };
  if (Number.isFinite(target)) walk(0, [], 0);

  if (hits.length !== 1) return { matched: null, items: [], 合計: 0, candidates: all };
  const matched = hits[0];
  const items = matched.flatMap((m) => m.items);
  return { matched, items, 合計: matched.reduce((s, m) => s + m.合計, 0), candidates: all };
}

/**
 * 寫入前的硬錯檢查。一次列全——逐條修正會讓承辦人來回改檔好幾次。
 * @returns {Array<{項次:string, 訊息:string}>}
 */
function validateItems(items) {
  const errs = [];
  const seen = new Set();
  for (const i of items || []) {
    const 項次 = String(i.項次 == null ? '' : i.項次);
    if (String(i.項目 || '').trim() === '') {
      errs.push({ 項次, 訊息: '項目名稱為空' });
    }
    if (!(Number(i.數量) > 0)) errs.push({ 項次, 訊息: '數量須大於 0' });
    if (!(Number(i.單價) > 0)) errs.push({ 項次, 訊息: '單價須大於 0' });
    // 範本 F 欄是 ROUND(E*D,0);對不上代表這份檔案的數字被改過,
    // 照抄進去合計就會與決標金額對不起來。
    if (roundHalfUp(Number(i.數量) * Number(i.單價)) !== Number(i.複價)) {
      errs.push({ 項次, 訊息: '複價與數量×單價不符' });
    }
    // 範本靠 MATCH(項次) 拉資料,重複時 MATCH 永遠只回第一筆,
    // 第二筆的施工進度會靜默記到第一筆頭上。
    if (seen.has(項次)) errs.push({ 項次, 訊息: '項次重複' });
    seen.add(項次);
  }
  return errs;
}

const key = (i) => String(i.項目 || '').replace(/[\s　]/g, '');

/**
 * 舊版與新版的逐項差異。
 *
 * **以項目名稱配對,不是列位置**——列位置正是重傳時會位移的東西。廠商既然會改
 * 舊項目(不是只會加新項目),整張覆蓋前就必須把「改了什麼」攤開;只說「已更新」
 * 的話,承辦人不會知道 30 項裡有 3 項單價變了。
 *
 * @returns {{added:Array, removed:Array, changed:Array}}
 */
function diffItems(舊, 新) {
  const oldMap = new Map((舊 || []).map((i) => [key(i), i]));
  const newMap = new Map((新 || []).map((i) => [key(i), i]));
  const added = [];
  const changed = [];
  for (const [k, n] of newMap) {
    const o = oldMap.get(k);
    if (!o) { added.push(n); continue; }
    if (Number(o.數量) !== Number(n.數量) || Number(o.單價) !== Number(n.單價)) {
      changed.push({
        項目: n.項目,
        舊: { 項次: o.項次, 數量: Number(o.數量), 單價: Number(o.單價) },
        新: { 項次: n.項次, 數量: Number(n.數量), 單價: Number(n.單價) },
      });
    }
  }
  const removed = [...oldMap].filter(([k]) => !newMap.has(k)).map(([, i]) => i);
  return { added, removed, changed };
}

const SHEET = '契約詳細價目表';
const FIRST_ROW = 2; // 第 1 列是欄位標題

/**
 * 範本裡以 INDEX/MATCH 引用契約詳細價目表的公式列範圍(實測公版範本),
 * 以及各分頁該容納哪些項目、不足時怎麼補。
 *
 * **兩個分頁的規則不同,這是 38 份已填實例釘出來的**:
 *
 * 1. `監造報表` 的引用列數 = 價目表項目數 **− 5**(豐榮 39→34、南陽 36→31、
 *    東榮災後 11→6)。差的正是五個費用項目——監造報表是給人看施工進度的,
 *    職安衛管理費與營業稅沒有施工進度可言。
 * 2. `監造報表` 的項目區**正下方就是報表正文**(二、監督…/三、查核…/簽章),
 *    只能插入列把正文往下推;FillDown 會直接覆蓋掉那幾段,而覆蓋後看起來
 *    只是「報表少了幾段」,不會有任何錯誤。豐榮實例的正文就在第 44 列,
 *    正是被往下推 3 列的結果。
 * 3. `每日施工紀錄` 收全部項目(含費用項目),且第 38 列起本來就是空白,
 *    FillDown 覆蓋不到任何東西。
 */
const INDEX_ROWS = {
  每日施工紀錄: { first: 2, last: 37, op: 'copyRowDown', 只算施工項目: false },
  監造報表: { first: 10, last: 40, op: 'insertRowsBelow', 只算施工項目: true },
};

const IS_WORK_ITEM = (i) => /^\d+$/.test(String(i.項次));

/**
 * 報表 A 欄要印的項次。**只影響版面,不影響任何比對**。
 *
 * 承辦人的慣例是把大類標題接在項次前面:49 個舊案的人工報表 42 份寫
 * `壹.1`(鎮西兩層寫 `壹.一.1`、古坑兩子工程寫 `A.壹.1`),只有 6 份寫純數字。
 * 而來源的經費總表**全部都是**「壹」大類列 + 「1、2、3」——連那 6 份也是,
 * 所以前綴是承辦人自己加的,不是資料差異。
 *
 * 前綴刻意只在這裡組、不進 `項次` 欄:廠商施工日誌寫的是純數字,SP3 拿項次
 * 逐字當 key 對日誌(`daily-log-validate.js` 的 contractByNo),資料層一加前綴
 * 就每天都對不上、整份寫不進去。
 */
const 顯示項次 = (i) => (i.大類 ? `${i.大類}.${i.項次}` : i.項次);

/**
 * 項目清單 → SP0 template-engine 的 operations。
 *
 * F 欄複價**不寫**:那是範本公式 ROUND(E*D,0)。寫死值會把公式換掉,之後任何人
 * 改了數量或單價,複價都不會跟著動(與 SP1 不寫 B9 完工期限同一個理由)。
 *
 * @param {Array} items 已通過 validateItems 的項目
 * @param {number} [previousCount] 這份報表上一版的項目數;新表較短時,多出來的
 *   舊列必須清空,否則會原封不動留在畫面上,看起來像契約真的有這些項目。
 * @returns {Array} operations(擴列排在寫值之前)
 * @throws {Error} items 為空
 */
function itemsToOperations(items, previousCount = 0) {
  const list = items || [];
  if (!list.length) throw new Error('沒有任何項目,不組寫入指令');

  const ops = [];
  // 擴列先做:公式列不存在的話,寫進去的項目在那兩個分頁上看不到。
  for (const [sheet, { first, last, op, 只算施工項目 }] of Object.entries(INDEX_ROWS)) {
    const capacity = last - first + 1;
    const needed = 只算施工項目 ? list.filter(IS_WORK_ITEM).length : list.length;
    if (needed > capacity) {
      ops.push({ type: op, sheet, srcRow: last, count: needed - capacity });
    }
  }

  const rows = Math.max(list.length, Number(previousCount) || 0);
  const values = [];
  for (let i = 0; i < rows; i++) {
    const it = list[i];
    values.push(it
      ? [顯示項次(it), it.項目, it.單位, it.數量, it.單價]
      : [null, null, null, null, null]);
  }
  ops.push({ type: 'setRange', sheet: SHEET, startAddr: `A${FIRST_ROW}`, values });
  return ops;
}

module.exports = {
  selectSheets, validateItems, diffItems, roundHalfUp,
  itemsToOperations, SHEET, INDEX_ROWS,
};
