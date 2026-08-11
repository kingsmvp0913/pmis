const fs = require('fs');
const path = require('path');
const { findCandidates } = require('../server/budget-sheet');
const {
  selectSheets, validateItems, diffItems, itemsToOperations, supervisionItemRowCount,
  SHEET, INDEX_ROWS,
} = require('../server/contract-items');

const fx = (key) => JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'budget', `${key}.json`), 'utf8'));

// 一個上傳檔案 → { file, candidates }。selectSheets 吃的就是這個形狀。
const asFile = (key) => ({ file: `${key}.xls`, candidates: findCandidates(fx(key).sheets) });

const item = (項次, 複價, extra = {}) => ({
  項次, 項目: '項目' + 項次, 單位: '式', 數量: 1, 單價: 複價, 複價, ...extra,
});

// ── 選表:以決標金額比對 ─────────────────────────────────────

test('單張命中決標金額時直接採用', () => {
  const r = selectSheets([asFile('damei')], 1036370);
  expect(r.matched.map((m) => m.name.trim())).toEqual(['詳細價目表']);
  expect(r.合計).toBe(1036370);
});

// 南陽檔內兩張表,第一張是複製底稿沒改乾淨的殘留(施工小計 1,185,308 是南陽
// 自己的數字,同樣的殘留出現在 5 個不同檔案)。照分頁名稱挑會挑到它。
test('雙表案例挑出合計等於決標金額的那張,不是第一張', () => {
  const r = selectSheets([asFile('nanyang')], 3122168);
  expect(r.matched).toHaveLength(1);
  expect(r.合計).toBe(3122168);
  expect(r.matched[0].name.trim()).toBe('詳細價目表 (2)');
});

// 重興是真的兩個標的,而且分在兩個檔案:871,943 + 812,102 = 1,684,045
test('跨兩個檔案相加才等於決標金額時,兩張一起採用', () => {
  const r = selectSheets([asFile('chongxing-toilet'), asFile('chongxing-sewage')], 1684045);
  expect(r.matched).toHaveLength(2);
  expect(r.合計).toBe(1684045);
  expect(r.items.length).toBe(r.matched.reduce((n, m) => n + m.items.length, 0));
});

// 同一個檔的兩張表相加(1,587,660 + 3,122,168)是不可能的組合——那是舊版與
// 新版的同一份工程。不設這個限制,搜尋空間會生出一堆荒謬但湊得出數字的組合。
test('同一個檔案最多只取一張', () => {
  const r = selectSheets([asFile('nanyang')], 4709828);
  expect(r.matched).toBe(null);
});

test('全部對不上時回 null 並附上所有候選供人工挑選', () => {
  const r = selectSheets([asFile('damei')], 999999);
  expect(r.matched).toBe(null);
  expect(r.candidates.map((c) => c.合計)).toContain(1036370);
});

// 兩組都湊得出決標金額時,系統挑哪一組都可能是錯的——這種時候要人來看
test('命中多組時不自行決定', () => {
  const files = [
    { file: 'a.xls', candidates: [{ name: 'S1', items: [item('1', 100)], 合計: 100 }] },
    { file: 'b.xls', candidates: [{ name: 'S2', items: [item('1', 100)], 合計: 100 }] },
  ];
  const r = selectSheets(files, 100);
  expect(r.matched).toBe(null);
  expect(r.candidates).toHaveLength(2);
});

test('沒有任何候選分頁時回 null', () => {
  const r = selectSheets([{ file: 'x.xlsm', candidates: [] }], 100);
  expect(r.matched).toBe(null);
  expect(r.candidates).toEqual([]);
});

// ── 卡控 ───────────────────────────────────────────────────

test('齊全時無錯', () => {
  expect(validateItems([item('1', 100), item('貳', 50)])).toEqual([]);
});

test('項目名稱為空判硬錯', () => {
  const errs = validateItems([item('1', 100, { 項目: '  ' })]);
  expect(errs).toHaveLength(1);
  expect(errs[0].項次).toBe('1');
});

// 不驗錯誤總數:數量改成 0 之後複價自然也對不上 0×單價,那第二則錯誤是對的。
// 釘住總數會逼實作把合理的錯誤吞掉。
test.each([['數量', 0], ['數量', -1], ['單價', 0], ['單價', -5]])('%s 為 %p 判硬錯', (k, v) => {
  const 訊息 = validateItems([item('1', 100, { [k]: v })]).map((e) => e.訊息);
  expect(訊息).toContain(`${k}須大於 0`);
});

// 1094 列樣本全部符合 複價 = ROUND(數量×單價),範本 F 欄也是這條公式。
// 對不上代表這份檔案被人改過數字,寫進去合計就會與決標金額對不起來。
test('複價與數量乘單價對不上判硬錯', () => {
  const errs = validateItems([{ 項次: '1', 項目: 'A', 單位: '式', 數量: 2, 單價: 100, 複價: 199 }]);
  expect(errs).toHaveLength(1);
  expect(errs[0].訊息).toMatch(/複價/);
});

// 範本靠 MATCH(項次) 拉資料,項次重複時 MATCH 永遠只回第一筆,
// 第二筆項目的施工進度會靜默記到第一筆頭上
test('項次重複判硬錯', () => {
  const errs = validateItems([item('1', 100), item('1', 200)]);
  expect(errs).toHaveLength(1);
  expect(errs[0].訊息).toMatch(/重複/);
});

// ── 差異比對(重傳時給承辦人看) ──────────────────────────────
// 廠商會改舊項目,不是只會加新項目。整張覆蓋前必須把改了什麼攤開,
// 否則承辦人看到的只是「已更新」,不知道 20 項裡有 3 項單價變了。

test('新增與刪除的項目各自列出', () => {
  const d = diffItems([item('1', 100), item('2', 200)], [item('1', 100), item('3', 300)]);
  expect(d.added.map((i) => i.項次)).toEqual(['3']);
  expect(d.removed.map((i) => i.項次)).toEqual(['2']);
  expect(d.changed).toEqual([]);
});

// 依項目名稱配對而非列位置:列位置正是重傳時會位移的東西
test('項目名稱相同但數量或單價變了算修改', () => {
  const 舊 = [{ 項次: '1', 項目: '砌磚牆', 單位: 'M2', 數量: 6, 單價: 1500, 複價: 9000 }];
  const 新 = [{ 項次: '3', 項目: '砌磚牆', 單位: 'M2', 數量: 8, 單價: 1600, 複價: 12800 }];
  const d = diffItems(舊, 新);
  expect(d.added).toEqual([]);
  expect(d.removed).toEqual([]);
  expect(d.changed).toHaveLength(1);
  expect(d.changed[0]).toMatchObject({ 項目: '砌磚牆', 舊: { 數量: 6, 單價: 1500 }, 新: { 數量: 8, 單價: 1600 } });
});

test('完全相同時三類皆空', () => {
  const items = [item('1', 100), item('貳', 50)];
  expect(diffItems(items, items)).toEqual({ added: [], removed: [], changed: [] });
});

test('第一次建立(沒有舊資料)時全部算新增', () => {
  const d = diffItems(null, [item('1', 100)]);
  expect(d.added).toHaveLength(1);
  expect(d.removed).toEqual([]);
});

// ── 寫入指令組裝 ────────────────────────────────────────────

const many = (n) => Array.from({ length: n }, (_, i) => item(String(i + 1), 100));

test('項目寫進契約詳細價目表 A2 起的五欄', () => {
  const ops = itemsToOperations([
    { 項次: '1', 項目: '施工圍籬', 單位: '式', 數量: 1, 單價: 3000, 複價: 3000 },
  ]);
  const set = ops.find((o) => o.type === 'setRange');
  expect(set).toMatchObject({ sheet: SHEET, startAddr: 'A2' });
  // F 欄複價不寫:那是範本公式 ROUND(E*D,0)。寫死值會讓公式被換掉,
  // 之後任何人改數量單價,複價都不會跟著動。
  expect(set.values).toEqual([['1', '施工圍籬', '式', 1, 3000]]);
});

// 49 個舊案的人工報表 42 份把大類接在項次前面(饒平「壹.1」、鎮西「壹.一.1」),
// 而**來源的經費總表全部**都是「壹」大類列 +「1、2、3」——前綴是承辦人加的版面慣例。
// ⚠️ 只有寫進報表 A 欄時才組:項次本身是 SP3 對施工日誌的 key(廠商日誌寫純數字),
// 資料層加前綴會讓每天都對不上、整份寫不進去。這條測的就是「只動版面不動 key」。
test('報表 A 欄印的項次帶大類前綴,費用項目不帶', () => {
  const ops = itemsToOperations([
    { 項次: '1', 項目: '施工圍籬', 單位: '式', 數量: 1, 單價: 3000, 複價: 3000, 大類: '壹' },
    { 項次: '2', 項目: '整地', 單位: '式', 數量: 1, 單價: 200, 複價: 200, 大類: '壹.一' },
    { 項次: '貳', 項目: '職業安全衛生管理費', 單位: '式', 數量: 1, 單價: 50, 複價: 50, 大類: null },
  ]);
  const set = ops.find((o) => o.type === 'setRange');
  expect(set.values.map((v) => v[0])).toEqual(['壹.1', '壹.一.2', '貳']);
});

// 一份工程 = N 個施工項目(阿拉伯項次) + 5 個費用項目(貳~陸),與真實樣本同形
const 費用 = ['貳', '參', '肆', '伍', '陸'];
const mixed = (施工數) => [
  ...Array.from({ length: 施工數 }, (_, i) => item(String(i + 1), 100)),
  ...費用.map((n) => item(n, 50)),
];

// 範本的公式列是有限的:每日施工紀錄鋪到第 37 列、監造報表到第 40 列。
test('項目數在兩個分頁的容量內時不擴列', () => {
  const ops = itemsToOperations(mixed(26)); // 31 項總數、26 施工項,兩邊都剛好塞得下
  expect(ops.filter((o) => /copyRowDown|insertRowsBelow/.test(o.type))).toEqual([]);
});

// 真實已填實例釘住的規律:**監造報表引用列數 = 價目表項目數 − 5**
// (豐榮 39→34、南陽 36→31、東榮災後 11→6)。差的正是五個費用項目——
// 監造報表是給人看施工進度的,職安衛管理費與營業稅沒有施工進度可言。
test('監造報表只算施工項目,費用項目不佔列', () => {
  const ops = itemsToOperations(mixed(34)); // 豐榮:34 施工 + 5 費用 = 39 項
  const 監造 = ops.find((o) => o.sheet === '監造報表');
  const 每日 = ops.find((o) => o.sheet === '每日施工紀錄');
  expect(監造.count).toBe(3);  // 34 施工項 − 31 容量
  expect(每日.count).toBe(3);  // 39 項總數 − 36 容量
});

// 監造報表的項目區正下方就是報表正文(二、監督…/三、查核…/簽章)。
// FillDown 會直接覆蓋掉那些內容,而且覆蓋後看起來只是「報表少了幾段」——
// 豐榮的真實實例是把正文往下推到第 44 列,即插入而非覆蓋。
test('監造報表用插入列,每日施工紀錄用覆蓋', () => {
  const ops = itemsToOperations(mixed(34));
  expect(ops.find((o) => o.sheet === '監造報表').type).toBe('insertRowsBelow');
  expect(ops.find((o) => o.sheet === '每日施工紀錄').type).toBe('copyRowDown');
});

test('只有每日施工紀錄超出時,不動監造報表', () => {
  const ops = itemsToOperations(mixed(31)); // 36 項總數(剛好)、31 施工項(剛好)
  expect(ops.filter((o) => o.sheet === '監造報表')).toEqual([]);
  const ops2 = itemsToOperations(mixed(32)); // 37 項總數(超 1)、32 施工項(超 1)
  expect(ops2.find((o) => o.sheet === '每日施工紀錄').count).toBe(1);
});

// 擴列要排在寫值之前:公式列不存在的話,寫進去的項目在那兩個分頁上看不到
test('擴列指令排在寫值之前', () => {
  const ops = itemsToOperations(mixed(34));
  expect(ops.findIndex((o) => /copyRowDown|insertRowsBelow/.test(o.type)))
    .toBeLessThan(ops.findIndex((o) => o.type === 'setRange'));
});

// 重傳的新表項目變少時,舊表多出來的那幾列會原封不動留在畫面上,
// 看起來像是契約真的有這些項目
test('新表比舊表短時,多出來的舊列要被清空', () => {
  const ops = itemsToOperations(many(2), 5);
  const set = ops.find((o) => o.type === 'setRange');
  expect(set.values).toHaveLength(5);
  expect(set.values.slice(2)).toEqual([
    [null, null, null, null, null],
    [null, null, null, null, null],
    [null, null, null, null, null],
  ]);
});

test('沒有項目時拒絕組指令', () => {
  expect(() => itemsToOperations([])).toThrow(/項目/);
});

// ── 多餘的項目列要整列刪掉 ──────────────────────────────
//
// 人工報表把用不到的項目列**整列刪掉**,正文因此緊貼最後一個真項目
// (饒平 25 個施工項目 → 正文在第 35 列)。留著的話報表不但多印五列費用項目,
// 正文也整段被往下推。範本預留 31 列,而真實案子的施工項目多半只有 20~35 個。

// A 欄:第 1 列是「項次」表頭在第 9 列,項目列 10 起,正文錨點在 anchorRow
const 監造報表A欄 = (anchorRow) => Array.from({ length: anchorRow + 5 }, (_, i) => {
  const r = i + 1;
  if (r === 9) return '項次';
  if (r === anchorRow) return '二、監督依照設計圖說及核定施工圖說施工（含約定之檢驗停留點）：';
  return r > 9 && r < anchorRow ? `壹.${r - 9}` : '';
});

test('監造報表的項目列數由實檔的正文錨點算出', () => {
  expect(supervisionItemRowCount(監造報表A欄(41))).toBe(31); // 公版範本:10~40 共 31 列
  expect(supervisionItemRowCount(監造報表A欄(35))).toBe(25); // 已刪過列的常駐檔
});

// 刪列不可逆:錨點找不到就寧可不動版面,也不猜著刪——刪掉的正文不會有錯誤訊息
test('找不到正文錨點時回 null', () => {
  expect(supervisionItemRowCount(['項次', '', ''])).toBeNull();
});

// 三個分頁各自量:監造報表 31 列(10~40)、每日施工紀錄與價目表各 36 列(2~37)
const 範本列數 = { 監造報表: 31, 每日施工紀錄: 36, 契約詳細價目表: 36 };

test('項目少於現有列數時,三個分頁的多餘列都整列刪掉', () => {
  const ops = itemsToOperations(mixed(25), 0, 範本列數); // 饒平:25 施工 + 5 費用 = 30 項
  expect(ops.filter((o) => o.type === 'deleteRows')).toEqual([
    // 全部項目(30)→ 第 32 列起多餘;順序:被引用的價目表排在引用它的日誌之後
    { type: 'deleteRows', sheet: '每日施工紀錄', startRow: 32, count: 6 },
    // 只算施工項目(25)→ 第 35 列起多餘,正文因此緊貼最後一個真項目
    { type: 'deleteRows', sheet: '監造報表', startRow: 35, count: 6 },
    { type: 'deleteRows', sheet: '契約詳細價目表', startRow: 32, count: 6 },
  ]);
});

// 每日施工紀錄的 A 欄公式引用價目表同列。先刪被引用的那邊,引用端會先變成 #REF!
// ——雖然接著也會被刪掉,但沒必要製造那個中間狀態。
test('刪列順序:引用端(每日施工紀錄)排在被引用端(價目表)之前', () => {
  const ops = itemsToOperations(mixed(25), 0, 範本列數).filter((o) => o.type === 'deleteRows');
  expect(ops.findIndex((o) => o.sheet === '每日施工紀錄'))
    .toBeLessThan(ops.findIndex((o) => o.sheet === '契約詳細價目表'));
});

// 沒量到實際列數(檔案讀不開/錨點不見)時只擴不刪
test('沒給列數就不刪列', () => {
  expect(itemsToOperations(mixed(25)).filter((o) => o.type === 'deleteRows')).toEqual([]);
});

// 量得到的分頁才刪,量不到的那個維持現況——不是「有一個量不到就全部不動」
test('只刪量得到列數的那些分頁', () => {
  const ops = itemsToOperations(mixed(25), 0, { 監造報表: 31, 每日施工紀錄: null });
  expect(ops.filter((o) => o.type === 'deleteRows').map((o) => o.sheet)).toEqual(['監造報表']);
});

// 監造報表第 10+k 列一對一拉價目表第 2+k 列,所以「留前 w 列」等於「留前 w 個項目」
// ——唯有施工項目全部排在費用項目前面才剛好是要的結果。交錯時刪尾巴會刪到真項目。
// 另兩個分頁收全部項目,尾巴一定是空的,不受這條限制。
test('費用項目不在尾端時,只有監造報表不刪', () => {
  const 交錯 = [item('1', 100), item('貳', 50), item('2', 100)];
  const ops = itemsToOperations(交錯, 0, 範本列數).filter((o) => o.type === 'deleteRows');
  expect(ops.map((o) => o.sheet)).toEqual(['每日施工紀錄', '契約詳細價目表']);
});

// 常駐檔已被刪過列之後,擴列要從**現存的最後一列**複製公式,不是範本的第 40 列
test('擴列的來源列以實檔的列數為準', () => {
  const ops = itemsToOperations(mixed(28), 0, { ...範本列數, 監造報表: 25 });
  expect(ops.find((o) => o.sheet === '監造報表'))
    .toMatchObject({ type: 'insertRowsBelow', srcRow: 34, count: 3 });
});

// 49 案裡有 2 案項目數超過範本的 36 列(三崙 38、簡易棒球場 49)。價目表的 F 欄
// 複價是公式且只鋪到第 37 列,不擴的話那幾列複價是空的,再被每日施工紀錄原封不動
// 拉過去,完成百分比整列算不出來。
test('項目超過範本容量時,價目表也要擴列', () => {
  const ops = itemsToOperations(mixed(44), 0, 範本列數); // 簡易棒球場:44 施工 + 5 費用 = 49 項
  expect(ops.find((o) => o.sheet === '契約詳細價目表'))
    .toMatchObject({ type: 'copyRowDown', srcRow: 37, count: 13 });
  expect(ops.filter((o) => o.type === 'deleteRows')).toEqual([]);
});

test('刪列指令排在寫值之前', () => {
  const ops = itemsToOperations(mixed(25), 0, 範本列數);
  expect(ops.findIndex((o) => o.type === 'deleteRows'))
    .toBeLessThan(ops.findIndex((o) => o.type === 'setRange'));
});
