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
const { fullItemNo, tailItemNo } = require('./item-no');

function validateItems(items) {
  const errs = [];
  const seen = new Set();
  for (const i of items || []) {
    const 項次 = fullItemNo(i);
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
 * 4. `契約詳細價目表` 本身也要擴列:項目值是 setRange 寫進去的沒有上限,但
 *    **F 欄複價是公式**(`ROUND(E*D,0)`)且只鋪到第 37 列。49 案裡有 2 案超過
 *    (三崙 38 項、簡易棒球場 49 項),第 38 列起複價是空的,再被每日施工紀錄的
 *    F 欄原封不動拉過去,完成百分比整列算不出來。第 38 列起是空白,FillDown 安全。
 *
 * 順序有意義:`每日施工紀錄` 的公式引用 `契約詳細價目表` 同列,先刪被引用的那邊
 * 會讓引用端變成 #REF!(雖然接著也會被刪掉,但中間狀態不必製造)。
 */
const INDEX_ROWS = {
  每日施工紀錄: { first: 2, last: 37, op: 'copyRowDown', 只算施工項目: false },
  監造報表: { first: 10, last: 40, op: 'insertRowsBelow', 只算施工項目: true },
  契約詳細價目表: { first: 2, last: 37, op: 'copyRowDown', 只算施工項目: false },
};

const IS_WORK_ITEM = (i) => /^\d+$/.test(tailItemNo(fullItemNo(i)));

// 「参/贰/陆」是異體字,樣本裡兩種混用(見 budget-sheet.js 的 FEE_NO);
// 不正規化的話,寫「(壹~参)」的案子會找不到那一列。
const 正體 = (s) => String(s == null ? '' : s).replace(/参/g, '參').replace(/贰/g, '貳').replace(/陆/g, '陸');
// 古坑那種兩個子工程的案子項次帶前綴(`A.伍`),比對只看最後一段。
const 項次尾 = (i) => 正體(String(i.項次 == null ? '' : i.項次).split('.').pop().trim());
// 費用項目名稱裡承辦人自己註明的範圍:`營業稅((壹~伍)*5%)`。
// 破折號與波浪號都出現過(來源經費總表寫 `~`、人工報表寫 `-`)。
const FEE_BASE_RANGE = /壹\s*[-—–~～至]\s*([貳參肆伍陸])/;

/**
 * 建造費用 = 發包工程費 − 保險費 − 營業稅。
 *
 * 監造設計費的「建造費用百分比法」要乘的是這個數,**不是決標金額**
 * (使用者清單第 20 項)。49 案實測建造費用穩定落在合計的 94.6%~95.1%,
 * 用錯基數會讓設計費多算約 5%——**這是計費規則,直接影響請款金額**。
 *
 * 保險費與營業稅由**費用項目的名稱**認:49 案裡含「保險」與含「營業稅」的
 * 費用列各自恰好一列(49/49、49/49),沒有零列也沒有多列。認不到就回 null——
 * 少扣一項會讓設計費偏高,**寧可讓畫面顯示「算不出來」,也不要靜默給一個偏高的數字**。
 *
 * 複價不從 DB 讀:`contract_items` 只存數量與單價(權威是 .xlsm 裡的公式),
 * 故在這裡以同一條 ROUND(數量×單價,0) 重算。
 *
 * @param {Array<{項次:string, 項目:string, 數量:number, 單價:number}>} items 全部項目
 * @returns {{建造費用:number, 發包工程費:number, 保險費:number, 營業稅:number}|null}
 */
function constructionCost(items) {
  const list = items || [];
  if (!list.length) return null;
  const 複價 = (i) => roundHalfUp(Number(i.數量) * Number(i.單價)) || 0;
  const 發包工程費 = list.reduce((s, i) => s + 複價(i), 0);
  const 費用項 = list.filter((i) => !IS_WORK_ITEM(i));
  const 保 = 費用項.filter((i) => /保險/.test(String(i.項目 || '')));
  const 稅 = 費用項.filter((i) => /營業稅/.test(String(i.項目 || '')));
  if (保.length !== 1 || 稅.length !== 1) return null;
  const 保險費 = 複價(保[0]);
  const 營業稅 = 複價(稅[0]);
  return { 建造費用: 發包工程費 - 保險費 - 營業稅, 發包工程費, 保險費, 營業稅 };
}

/**
 * 費用項目的費率:**還原得出原本單價的最短小數**。
 *
 * 名稱多半自己寫著費率(`職業安全衛生管理費(壹*1%)`),但**不能照抄**——49 案裡
 * 245 個費用列有 68 個算出來與單價對不上(名稱寫「約壹*7%」實際 6.9857%)。
 * 而合計等於決標金額是整條線的錨,值不准動,所以費率一律以單價回推。
 *
 * 直接寫回推值會得到 `0.300000548898634%` 這種打開來看不懂的東西,連本來就剛好是
 * 0.3% 的案子都遭殃(保險費那類名稱沒寫費率,對不到名目值)。故由短到長試,
 * 取第一個仍然算得出同一個單價的位數:剛好的案子拿到 `0.3%`、`1%`、`7%`,
 * 對不上的案子才落到長小數——而**兩種都保證值不變**。
 *
 * @returns {string} Excel 的百分比字面量,如 `0.6%`
 */
function 費率(base, 單價) {
  const pct = (單價 / base) * 100;
  for (let d = 0; d <= 12; d++) {
    const 短 = Number(pct.toFixed(d));
    if (短 > 0 && roundHalfUp(base * (短 / 100)) === 單價) return `${短}%`;
  }
  return `${pct}%`;
}

/**
 * 寫完數字後要重新量寬度的欄(只加寬,見 itemsToOperations 末尾)。
 *
 * **只列實際觀察到 `########` 的欄**——監造報表的契約數量/完成數量/累計完成數量。
 * ⚠️ 曾經「順便」把契約詳細價目表與每日施工紀錄的數字欄也加進來,結果是**迴歸**:
 * 每日施工紀錄的 H(累計完成金額)被從 10.67 撐到 13.33,多出來的寬度把最右邊的
 * 「完成百分比」整欄擠出列印範圍——印出來整欄不見,而儲存格裡的值是好的。
 * 那兩個分頁的欄寬本來就放得下(人工報表也是同一組寬度),不要推測性地加寬。
 */
const 數字欄 = {
  監造報表: ['H', 'I', 'J'],
};

/**
 * 報表 A 欄要印的項次。**只影響版面,不影響任何比對**。
 *
 * 承辦人的慣例是把大類標題接在項次前面:49 個舊案的人工報表 42 份寫
 * `壹.1`(鎮西兩層寫 `壹.一.1`、古坑兩子工程寫 `A.壹.1`),只有 6 份寫純數字。
 * 而來源的經費總表**全部都是**「壹」大類列 + 「1、2、3」——連那 6 份也是,
 * 2026-09 重新盤點完整樣本後確認，同張契約會同時有「壹.一.1」與「壹.二.1」；
 * 前綴是資料鍵的一部分，不能只當版面文字，否則兩項入庫後都會退化成「1」。
 */
const 顯示項次 = (i) => fullItemNo(i);

/**
 * 費用項目(貳~陸)的單價要寫成**公式**,不是死值。
 *
 * 49 案的人工報表裡 44 案是公式(245 個費用列中 218 個),形狀一律是
 * `ROUND(SUM($F$2:$F$n)*rate,0)`——費用是按施工費的百分比算的,施工項目的數量
 * 一改,費用就該跟著動。寫死值的話報表看起來對,但任何變更設計之後就靜靜地錯了。
 *
 * ⚠️ 來源的發包經費總表**搬不過來**:實測 265 個帶公式的來源儲存格幾乎全是跨檔
 * 跨分頁參照(`總表!E7`、`'[1](預算)詳細價目表'!B37`),照抄進監造報表就是 #REF!。
 * 所以照的是人工報表自己的算式,不是來源檔的。
 *
 * **n(SUM 的上界)** 三選一,依 218 個人工公式歸納(吻合 204 個):
 *   1. 名稱寫了範圍(`營業稅((壹~伍)*5%)`)→ 該大類那個費用項目所在的列。
 *      44 個營業稅公式全部吻合,含 4 個寫 `(壹~肆)`(不含保險費)的案子。
 *   2. 沒寫範圍的營業稅 → 自己的前一列(來源樣本有 3 筆是這樣)。
 *   3. 其餘 → 最後一個施工項目那列,即「壹」的小計。132 個非保險費的公式 132 個吻合。
 *      保險費是 29:13——多數同此,少數是連貳~肆一起算;不吻合的那 13 個只差在
 *      **未來重算的基準**,寫進去的值仍然一樣(見下)。
 *
 * **rate** 一律由單價回推,見 `費率`。
 *
 * ⚠️ **值必須原封不動**:合計等於決標金額是整條線的錨(見 selectSheets),
 * 而 F 欄是 ROUND(E*D,0)、費用項目的數量實測 245/245 都是 1,所以 E 一變合計就變。
 * 回推的 rate 保證 `ROUND(base*rate,0) === 單價`,49 案實測 241/245 相同,
 * 另外 4 個是四湖無障礙的**小數單價**(11994.26)——ROUND(…,0) 重現不了,故不寫公式。
 *
 * @param {Array} list 項目清單(順序即寫入的列順序)
 * @returns {Map<number, string>} 索引 → 公式字串;算不出來的索引不在 Map 裡(維持死值)
 */
function 費用項目單價公式(list) {
  const out = new Map();
  const lastWorkIdx = list.reduce((last, it, i) => (IS_WORK_ITEM(it) ? i : last), -1);
  const rowOf = (i) => FIRST_ROW + i;
  const 累計到 = (n) => list.slice(0, n - FIRST_ROW + 1)
    .reduce((s, it) => s + (Number(it.複價) || 0), 0);

  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (IS_WORK_ITEM(it)) continue;
    const row = rowOf(i);
    const 名稱 = 正體(it.項目 || '');
    const m = FEE_BASE_RANGE.exec(名稱);
    const j = m ? list.findIndex((o) => 項次尾(o) === m[1]) : -1;
    const n = j >= 0 ? rowOf(j)
      : /營業稅/.test(名稱) ? row - 1
        : lastWorkIdx >= 0 ? rowOf(lastWorkIdx) : 0;
    // 範圍碰到自己那一列就是循環參照:Excel 跳警告、整欄變 0,而報表看起來只是「費用是 0」
    if (!(n >= FIRST_ROW && n < row)) continue;

    const base = 累計到(n);
    const 單價 = Number(it.單價);
    if (!(base > 0) || !Number.isInteger(單價) || 單價 <= 0) continue;
    out.set(i, `=ROUND(SUM($F$${FIRST_ROW}:$F$${n})*${費率(base, 單價)},0)`);
  }
  return out;
}

/**
 * 「每日施工紀錄」費用項目那幾列的底色。
 *
 * ## 為什麼要由系統重畫,不能靠範本
 *
 * 範本把費用列(最後五列)漆成淺綠 `E2F0D9`,但那個顏色綁在**固定的列號**上
 * (範本是 r33~r37)。實際項目數每案不同,擴列/刪列之後綠色就留在原地:
 * 元長實測 33 項 → 費用落在 r30~r34,而綠色還在 r33~r34
 * ——**貳/參/肆 沒有底色、伍/陸 有**,半塊有色半塊沒有。
 * 值全都是對的,所以逐格比對永遠看不見(同 [[report-visual-check]] 那一類)。
 *
 * ## 為什麼要連「施工列」一起還原
 *
 * 項目數超過範本容量時走 `insertRowsBelow`,它是從最後一列 FillDown ——
 * 而最後一列是綠的,於是新插的列全部帶綠。不還原的話,綠色會反過來蓋到施工列上。
 * 施工列的原樣是**A~I 無底色 + J~WF 橘色 `FBE5D6`**(日期欄),兩段要分開下。
 *
 * 費用項目一律在尾端(見 `費用項目全在尾端`),所以兩塊都是連續區間,各一道指令。
 */
const 每日底色 = { 費用: 'E2F0D9', 日期欄: 'FBE5D6' };
const 每日欄數 = 604;        // A~WF,與範本的 !ref 一致
const 前段欄數 = 9;          // A~I:項次/名稱/單位/契約數量/單價/複價/累計/金額/百分比

/**
 * 費用列與施工列的數值格式也綁在範本的固定列號上,和底色同一個病:
 * 元長實測 貳/參/肆 印 `0.00`、伍/陸 印 `0.0000`,同一塊的小數位數不一樣。
 *
 * 只處理 **G(累計完成數量)與 H(累計完成金額)**——那是兩種列真正不同的兩欄。
 * ⚠️ 日期欄 J~WF 的格式在範本裡也有差(費用列 4 位小數),但它的分界點在 FT/FU
 * (第 176 欄)**沒有任何語意**,看起來是範本作者拉格式時的偶然,照抄等於把一個
 * 偶然固化成規則。維持不動。
 */
const 每日格式 = {
  施工: { G: '0.00_);[Red]\\(0.00\\)', H: '_-* #,##0_-;\\-* #,##0_-;_-* "-"_-;_-@_-' },
  費用: { G: '0.0000_);[Red]\\(0.0000\\)', H: '_-* #,##0.0_-;\\-* #,##0.0_-;_-* "-"_-;_-@_-' },
};
const G欄 = 7;
const H欄 = 8;

function 費用列底色(list) {
  const { first } = INDEX_ROWS.每日施工紀錄;
  const 費用起 = list.findIndex((it) => !IS_WORK_ITEM(it));
  const 末列 = first + list.length - 1;
  const ops = [];
  const 格式 = (firstRow, lastRow, 組) => [
    { type: 'setNumberFormat', sheet: '每日施工紀錄', firstRow, lastRow, firstCol: G欄, lastCol: G欄, format: 組.G },
    { type: 'setNumberFormat', sheet: '每日施工紀錄', firstRow, lastRow, firstCol: H欄, lastCol: H欄, format: 組.H },
  ];
  // 施工列:先還原成範本的樣子(綠色與 4 位小數可能是上一版留下來的)
  const 施工末 = 費用起 < 0 ? 末列 : first + 費用起 - 1;
  if (施工末 >= first) {
    ops.push({ type: 'setRowFill', sheet: '每日施工紀錄', firstRow: first, lastRow: 施工末, firstCol: 1, lastCol: 前段欄數, fill: null });
    ops.push({ type: 'setRowFill', sheet: '每日施工紀錄', firstRow: first, lastRow: 施工末, firstCol: 前段欄數 + 1, lastCol: 每日欄數, fill: 每日底色.日期欄 });
    ops.push(...格式(first, 施工末, 每日格式.施工));
  }
  if (費用起 >= 0) {
    ops.push({ type: 'setRowFill', sheet: '每日施工紀錄', firstRow: first + 費用起, lastRow: 末列, firstCol: 1, lastCol: 每日欄數, fill: 每日底色.費用 });
    ops.push(...格式(first + 費用起, 末列, 每日格式.費用));
  }
  return ops;
}

// 監造報表項目區的下界:項目列的正下方就是報表正文。人工報表把用不到的項目列
// **整列刪掉**,正文因此緊貼最後一個真項目;範本則預留到第 40 列。
const BODY_ANCHOR = /^二[、,.]?監督/;
const 去空白 = (v) => String(v == null ? '' : v).replace(/[\s　]/g, '');

/**
 * 監造報表的第 10+k 列一對一拉價目表的第 2+k 列,所以「只保留前 w 列」等於
 * 「只保留前 w 個項目」——唯有施工項目**全部排在費用項目前面**時,這才剛好是
 * 要的結果。單一分頁的案子恆成立;古坑那種兩個子工程的案子,承辦人選的是
 * 已經把費用項目合併到最後的那張分頁,實測也成立。
 *
 * 不成立就不刪:版面維持現況(多印幾列)只是不好看,刪錯列是把真項目刪掉。
 */
const 費用項目全在尾端 = (list, 施工項目數) => list.slice(0, 施工項目數).every(IS_WORK_ITEM);

/**
 * 監造報表目前有幾列項目列(第 10 列到報表正文之間)。
 *
 * 不從範本常數推、也不從 DB 的項目數推,而是**讀實際的檔案**:監造報表是常駐檔,
 * 承辦人可以上傳自己做到一半的那份(見 report-verify.js),列數不保證等於範本。
 * 推錯會刪到報表正文,而刪掉的正文不會有任何錯誤訊息。
 *
 * @param {Array<string>} aColumn 監造報表 A 欄由第 1 列起的值
 * @returns {number|null} 找不到正文錨點回 null——**寧可不動版面,也不猜著刪**
 */
function supervisionItemRowCount(aColumn) {
  const { first } = INDEX_ROWS.監造報表;
  const col = aColumn || [];
  for (let r = first; r <= col.length; r++) {
    if (BODY_ANCHOR.test(去空白(col[r - 1]))) return r - first;
  }
  return null;
}

/**
 * 每日施工紀錄與契約詳細價目表目前有幾列項目列。
 *
 * 這兩個分頁的項目區下方是**空白**(不像監造報表下面就是正文),沒有錨點可找,
 * 只能數「從第 2 列起連續有公式的列」:每日施工紀錄看 A 欄
 * (`IF(契約詳細價目表!A2="","",…)`)、價目表看 F 欄複價(`ROUND(E2*D2,0)`)。
 *
 * 從 first 起**連續**才算——中間斷掉就停,不去撿後面零星的公式格
 * (那多半是舊案殘留,把它算進容量會讓刪列的起點算錯)。
 *
 * @param {Array<boolean>} hasFormula 由第 1 列起,該列的判定欄是不是公式
 * @param {number} first 項目列的第一列
 * @returns {number|null} 第一列就沒有公式回 null(版面與預期不符,不動它)
 */
function formulaItemRowCount(hasFormula, first) {
  const col = hasFormula || [];
  let n = 0;
  for (let r = first; r <= col.length && col[r - 1]; r++) n++;
  return n === 0 ? null : n;
}

/**
 * 項目清單 → SP0 template-engine 的 operations。
 *
 * F 欄複價**不寫**:那是範本公式 ROUND(E*D,0)。寫死值會把公式換掉,之後任何人
 * 改了數量或單價,複價都不會跟著動(與 SP1 不寫 B9 完工期限同一個理由)。
 * 同理,費用項目的 E 欄單價寫的是公式而非死值(見 `費用項目單價公式`)。
 *
 * @param {Array} items 已通過 validateItems 的項目
 * @param {number} [previousCount] 這份報表上一版的項目數;新表較短時,多出來的
 *   舊列必須清空,否則會原封不動留在畫面上,看起來像契約真的有這些項目。
 * @param {object|null} [現有列數] 由實檔量出的各分頁項目列數,鍵同 INDEX_ROWS
 *   (`supervisionItemRowCount` / `formulaItemRowCount`)。某個分頁量得到才會刪它
 *   多餘的列;量不到(null/未給)就只擴不刪。
 * @returns {Array} operations(擴列/刪列排在寫值之前)
 * @throws {Error} items 為空
 */
/**
 * 把三個分頁的項目列數調成剛好容納這批項目——多的刪掉、少的補上。
 *
 * 由 itemsToOperations 抽出來獨立成一支,是因為**寫價目表(SP2)不是唯一需要它的地方**:
 * 刪列是 2026-08-11 才加的,在那之前建好的常駐報表都還留著範本自己的五列費用公式
 * (`ROUND(SUM($F$2:$F$32)*7%,0)` 那種)。那些列沒有項次/名稱/單位,卻**算得出單價**,
 * 於是「每日施工紀錄」照拉過去就是一整列 `#N/A` 配一個看起來合理的金額,再往下
 * 汙染合計與完成百分比(實測 9092.78%、189054.83%)。承辦人日常只上傳日誌、不會
 * 重跑 SP2,舊報表就永遠修不好——所以 SP3 寫入前也要跑一次。
 *
 * @param {Array} items 這份報表應有的全部項目(施工 + 費用)
 * @param {object|null} 現有列數 由實檔量出的各分頁項目列數,鍵同 INDEX_ROWS;
 *   量不到的分頁(null/未給)只擴不刪——**寧可多印幾列,也不猜著刪**
 * @returns {Array} operations
 */
function resizeOperations(items, 現有列數 = null) {
  const list = items || [];
  const ops = [];
  if (!list.length) return ops;
  for (const [sheet, { first, last, op, 只算施工項目 }] of Object.entries(INDEX_ROWS)) {
    const 量到的 = 現有列數 && Number.isInteger(現有列數[sheet]) ? 現有列數[sheet] : null;
    // 常駐檔的實際列數可能已被刪過(或承辦人上傳的那份本來就不同),量得到就以實檔為準
    const capacity = 量到的 == null ? last - first + 1 : 量到的;
    const needed = 只算施工項目 ? list.filter(IS_WORK_ITEM).length : list.length;
    if (needed > capacity) {
      ops.push({ type: op, sheet, srcRow: first + capacity - 1, count: needed - capacity });
    } else if (needed < capacity && 量到的 != null
      && (!只算施工項目 || 費用項目全在尾端(list, needed))) {
      // 人工報表把用不到的項目列**整列刪掉**。監造報表留著會多印五列費用項目、
      // 正文整段被往下推;另兩個分頁則是尾巴多出一截空白列,影響列印分頁。
      ops.push({ type: 'deleteRows', sheet, startRow: first + needed, count: capacity - needed });
    }
  }
  return ops;
}

function itemsToOperations(items, previousCount = 0, 現有列數 = null) {
  const list = items || [];
  if (!list.length) throw new Error('沒有任何項目,不組寫入指令');

  // 擴列/刪列先做:公式列不存在的話,寫進去的項目在那些分頁上看不到。
  const ops = resizeOperations(list, 現有列數);

  const rows = Math.max(list.length, Number(previousCount) || 0);
  const 公式 = 費用項目單價公式(list);
  const values = [];
  for (let i = 0; i < rows; i++) {
    const it = list[i];
    values.push(it
      ? [顯示項次(it), it.項目, it.單位, it.數量, 公式.has(i) ? 公式.get(i) : it.單價]
      : [null, null, null, null, null]);
  }
  ops.push({ type: 'setRange', sheet: SHEET, startAddr: `A${FIRST_ROW}`, values });
  ops.push(...費用列底色(list));
  // 數字進去之後才知道要多寬。契約數量欄是固定寬度但數量不是——2,600.00 放不下,
  // Excel 就印出 ########;**值是對的,逐格比對永遠看不到**,要把報表印出來才看得見。
  // 承辦人是自己把那一欄拉寬的(49 份人工報表實測 9.67~13.00)。
  // 只加寬不縮小:範本欄寬是刻意對齊人工報表的,AutoFit 一個幾乎空的欄會縮到剩標題寬。
  ops.push(...Object.entries(數字欄).map(([sheet, cols]) => ({ type: 'autoFitColumns', sheet, cols })));
  return ops;
}

module.exports = {
  selectSheets, validateItems, diffItems, roundHalfUp, constructionCost,
  itemsToOperations, resizeOperations, supervisionItemRowCount, formulaItemRowCount,
  SHEET, INDEX_ROWS, fullItemNo,
};
