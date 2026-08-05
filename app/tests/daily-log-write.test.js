const { colName, daysToOperations, diffDays } = require('../server/daily-log-write');

const CONTRACT = [
  { 項次: '1', 項目: '項目1' },
  { 項次: '2', 項目: '項目2' },
  { 項次: '貳', 項目: '職業安全衛生管理費' },
];
const 開工日 = '2026-04-08';

const day = (填報日期, rows) => ({ header: { 填報日期 }, dailyRows: rows });
const r = (項次, 本日完成數量) => ({ 項次, 本日完成數量 });

// ── Excel 欄名 ─────────────────────────────────────────────
// 日期欄從 J 起算(J1 = 工程基本資料!B8 開工日,K1=J1+1…),一路到 ACH。
// 換算錯一欄,整份進度就會整體平移一天,而報表上完全看不出來。
test.each([[10, 'J'], [26, 'Z'], [27, 'AA'], [28, 'AB'], [52, 'AZ'], [53, 'BA'], [762, 'ACH']])(
  '第 %p 欄的名稱是 %s', (n, name) => {
    expect(colName(n)).toBe(name);
  });

// ── 日期 → 欄 ──────────────────────────────────────────────

test('開工日當天寫在 J 欄', () => {
  const ops = daysToOperations([day(開工日, [r('1', 5)])], CONTRACT, 開工日);
  expect(ops[0].startAddr).toBe('J2');
});

test('開工日隔天寫在 K 欄', () => {
  const ops = daysToOperations([day('2026-04-09', [r('1', 5)])], CONTRACT, 開工日);
  expect(ops[0].startAddr).toBe('K2');
});

// 項次對應的列 = 契約詳細價目表的順序(每日施工紀錄靠 MATCH 項次拉同一個順序)
test('值依契約表的項次順序排列', () => {
  const ops = daysToOperations([day(開工日, [r('貳', 7), r('1', 5)])], CONTRACT, 開工日);
  expect(ops[0].values).toEqual([[5], [null], [7]]);
});

// 假日不填是常態(金大 04/10 之後跳到 04/13)。中間那幾欄要留空,
// 不能把後面的資料往前擠——擠了就是整段進度對到錯的日期。
test('中間缺的日期留空,不擠掉後面的欄', () => {
  const ops = daysToOperations([day('2026-04-10', [r('1', 3)]), day('2026-04-13', [r('1', 4)])],
    CONTRACT, 開工日);
  expect(ops).toHaveLength(1);
  expect(ops[0].startAddr).toBe('L2'); // 04-10 = 開工日 +2
  // L(04/10) M(11) N(12) O(13) —— 週末兩欄留 null
  expect(ops[0].values[0]).toEqual([3, null, null, 4]);
});

// 沒施工的項目要寫 null 而不是 0:0 代表「今天做了 0 個單位」,
// null 代表「今天沒有這一項」,範本的 SUM 兩者結果一樣但語意不同。
test('沒有數量的項目寫 null', () => {
  const ops = daysToOperations([day(開工日, [r('1', null)])], CONTRACT, 開工日);
  expect(ops[0].values).toEqual([[null], [null], [null]]);
});

test('契約表沒有的項次直接忽略(E1 已在驗證層擋下)', () => {
  const ops = daysToOperations([day(開工日, [r('99', 5), r('1', 1)])], CONTRACT, 開工日);
  expect(ops[0].values).toEqual([[1], [null], [null]]);
});

// 範本的日期欄鋪到 ACH(約 753 天)。超出就沒有欄可寫,靜默丟掉等於那幾天的
// 進度憑空消失。
test('日期超出範本可容納的天數時丟錯', () => {
  expect(() => daysToOperations([day('2028-12-31', [r('1', 1)])], CONTRACT, 開工日))
    .toThrow(/超出/);
});

test('填報日期早於開工日時丟錯', () => {
  expect(() => daysToOperations([day('2026-04-01', [r('1', 1)])], CONTRACT, 開工日))
    .toThrow(/開工/);
});

// ── 跨批次差異 ─────────────────────────────────────────────
// 「後面才發現前面錯了」是真實流程:同一天可能被重送修正版,覆蓋前要讓承辦人
// 看到改了什麼,不能只說「已更新」。

test('新的日期算新增', () => {
  const d = diffDays([], [{ 日期: '2026-04-08', 項次: '1', 本日完成數量: 5 }]);
  expect(d.added).toHaveLength(1);
  expect(d.changed).toEqual([]);
});

test('同一天同項次數量變了算修改', () => {
  const d = diffDays(
    [{ 日期: '2026-04-08', 項次: '1', 本日完成數量: 5 }],
    [{ 日期: '2026-04-08', 項次: '1', 本日完成數量: 8 }],
  );
  expect(d.changed).toEqual([
    { 日期: '2026-04-08', 項次: '1', 舊: 5, 新: 8 },
  ]);
});

test('完全相同時無差異', () => {
  const rows = [{ 日期: '2026-04-08', 項次: '1', 本日完成數量: 5 }];
  expect(diffDays(rows, rows)).toEqual({ added: [], changed: [], removed: [] });
});

// 這批沒送的日期不算刪除:施工日誌是分批提交的,第二批不含第一批的日期是常態,
// 判成刪除會把已寫入的進度誤報成要清掉。
test('這批沒送到的舊日期不算刪除', () => {
  const d = diffDays(
    [{ 日期: '2026-04-08', 項次: '1', 本日完成數量: 5 }],
    [{ 日期: '2026-05-01', 項次: '1', 本日完成數量: 3 }],
  );
  expect(d.removed).toEqual([]);
  expect(d.added).toHaveLength(1);
});

// 同一天重送但少了某個項次,那一項的數量就該被清掉——留著會讓那天的累計多算
test('同一天重送時少掉的項次算刪除', () => {
  const d = diffDays(
    [
      { 日期: '2026-04-08', 項次: '1', 本日完成數量: 5 },
      { 日期: '2026-04-08', 項次: '2', 本日完成數量: 3 },
    ],
    [{ 日期: '2026-04-08', 項次: '1', 本日完成數量: 5 }],
  );
  expect(d.removed).toEqual([{ 日期: '2026-04-08', 項次: '2', 本日完成數量: 3 }]);
});
