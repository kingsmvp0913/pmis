const {
  colName, daysToOperations, weatherToOperations, diffDays, legacyFormulaOperations,
} = require('../server/daily-log-write');

const CONTRACT = [
  { 項次: '1', 項目: '項目1', 數量: 10 },
  { 項次: '2', 項目: '項目2', 數量: 20 },
  { 項次: '貳', 項目: '職業安全衛生管理費', 數量: 1 },
];
const 開工日 = '2026-04-08';
const 竣工日 = '2026-04-17'; // 工期 10 天(含頭尾)

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
  const ops = daysToOperations([day(開工日, [r('2', 7), r('1', 5)])], CONTRACT, 開工日);
  expect(ops[0].values).toEqual([[5], [7], [null]]);
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

// ── 費用項目照施工日誌寫入 ─────────────────────────────────

test('費用項目照施工日誌的每日完成數量寫入', () => {
  const ops = daysToOperations([day(開工日, [r('貳', 0.007)])], CONTRACT, 開工日, 竣工日);
  expect(ops).toHaveLength(1);
  expect(ops[0].values).toEqual([[null], [null], [0.007]]);
});

test('費用項目沒有日誌值時保持空白', () => {
  const 第一批 = daysToOperations([day(開工日, [r('1', 5)])], CONTRACT, 開工日, 竣工日);
  const 第二批 = daysToOperations(
    [day('2026-04-09', [r('1', 3)]), day('2026-04-10', [r('1', 4)])], CONTRACT, 開工日, 竣工日);
  expect(第一批[0].values[2]).toEqual([null]);
  expect(第二批[0].values[2]).toEqual([null, null]);
});

test('費用項目與其他項目共用同一批寫入範圍', () => {
  const ops = daysToOperations([day(開工日, [r('1', 5)])], CONTRACT, 開工日, 竣工日);
  expect(ops).toHaveLength(1);
  expect(ops[0].startAddr).toBe('J2');
});

test('日誌有寫費用項目時不覆蓋來源數值', () => {
  const ops = daysToOperations([day(開工日, [r('貳', 999)])], CONTRACT, 開工日, 竣工日);
  expect(ops[0].values[2][0]).toBe(999);
});

test('沒有竣工日期不影響費用項目的日誌值', () => {
  const ops = daysToOperations([day(開工日, [r('貳', 0.007)])], CONTRACT, 開工日, null);
  expect(ops[0].values[2][0]).toBe(0.007);
});

test('竣工日期不影響費用項目的日誌值', () => {
  const ops = daysToOperations([day(開工日, [r('貳', 0.007)])], CONTRACT, 開工日, '2026-04-01');
  expect(ops[0].values[2][0]).toBe(0.007);
});

test('帶前綴的費用項次(A.貳)也照施工日誌寫入', () => {
  const contract = [{ 項次: 'A.壹.1', 項目: '施工', 數量: 5 }, { 項次: 'A.貳', 項目: '職安衛', 數量: 1 }];
  const ops = daysToOperations([day(開工日, [r('A.貳', 0.0026)])], contract, 開工日, 竣工日);
  expect(ops[0].values).toEqual([[null], [0.0026]]);
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

test('不同大類的同尾碼依唯一項目名稱寫入各自契約列', () => {
  const contract = [
    { 項次: '壹.一.1', 項目: '跑道整地', 數量: 5 },
    { 項次: '壹.貳.1', 項目: '球場整地', 數量: 8 },
  ];
  const rows = [
    { 項次: '1', 工程項目: '球場整地', 本日完成數量: 3 },
    { 項次: '1', 工程項目: '跑道整地', 本日完成數量: 2 },
  ];
  const ops = daysToOperations([day(開工日, rows)], contract, 開工日);
  expect(ops[0].values).toEqual([[2], [3]]);
});

test('舊報表的項目列公式升級為空白與除以零防呆', () => {
  const ops = legacyFormulaOperations(CONTRACT);
  expect(ops).toContainEqual({
    type: 'setFormula', sheet: '每日施工紀錄', addr: 'B2',
    formula: '=IF(契約詳細價目表!B2="","",契約詳細價目表!B2)',
  });
  expect(ops).toContainEqual({
    type: 'setFormula', sheet: '每日施工紀錄', addr: 'I4',
    formula: '=IF(OR($F4="",$F4=0),"",ROUND($H4/$F4,5))',
  });
  expect(ops).toContainEqual({
    type: 'setFormula', sheet: '監造報表', addr: 'B7',
    formula: '=IFERROR(INDEX(每日施工紀錄!$1:$1048576,MATCH("預定進度",每日施工紀錄!A:A,0),MATCH($H$3,每日施工紀錄!1:1,0)),"")',
  });
  expect(ops).toContainEqual({
    type: 'setFormula', sheet: '監造報表', addr: 'I12',
    formula: '=IFERROR(INDEX(每日施工紀錄!$1:$1048576,MATCH($A12,每日施工紀錄!A:A,0),MATCH($H$3,每日施工紀錄!$1:$1,0)),"")',
  });
  expect(ops).toContainEqual({
    type: 'setFormula', sheet: '監造報表', addr: 'A14',
    formula: '=IFERROR(INDEX(監造內容!$1:$1048576,MATCH($H3,監造內容!B:B,0),6),"")',
  });
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

// ── 監造內容分頁的天氣 ──────────────────────────────
//
// 49 個舊案的人工報表這兩欄**全部都有填**(28 案是逐日不同的真天氣、21 案整份「晴」),
// 而系統一格都沒寫——承辦人打開監造內容就是整片空白。讀取器本來就有
// 天氣_上午/天氣_下午,只是從來沒人寫進去。

const 天氣日 = (填報日期, 上午, 下午) => ({
  header: { 填報日期, 天氣_上午: 上午, 天氣_下午: 下午 }, dailyRows: [],
});
const 範圍 = (ops) => ops.filter((o) => o.type === 'setRange');
const addrOf = (ops, addr) => ops.find((o) => o.addr === addr);

// 這一頁是逐日一列(B3=開工日、B4=B3+1…),與每日施工紀錄的逐日一欄同一套換算
test('天氣寫進監造內容,列 = 3 + (填報日 − 開工日)', () => {
  const ops = weatherToOperations([
    天氣日(開工日, '晴', '陰'),
    天氣日('2026-04-09', '多雲', '雷雨'),
  ], 開工日);
  expect(範圍(ops)).toEqual([
    { type: 'setRange', sheet: '監造內容', startAddr: 'C3', values: [['晴', '陰'], ['多雲', '雷雨']] },
  ]);
});

// ⚠️ 逐格 setCell 是一次 COM 往返:一份 87 天的日誌就是 174 次,實測讓簡易棒球場
// 的指令數 11 → 185、耗時 12s → 24s。Excel COM 本來就會偶發 RPC_E_CALL_REJECTED,
// 把單案時間拉長一倍等於把失敗率往上推。
test('連續的日期併成一道 setRange,不逐格寫', () => {
  const days = Array.from({ length: 30 }, (_, i) => 天氣日(`2026-04-${String(8 + i).padStart(2, '0')}`, '晴', '晴'));
  const ops = weatherToOperations(days, 開工日);
  expect(範圍(ops)).toHaveLength(1);
  expect(ops.filter((o) => o.type === 'setCell')).toHaveLength(2); // 只有 C2/D2 子標題
});

// 施工日誌分多次提交是常態。中間跳過的日期若也寫進去(值為 null),
// 會把前一批已經寫好的那幾天清空。
test('中間跳過的日期切成兩段,不把它清空', () => {
  const ops = weatherToOperations([
    天氣日(開工日, '晴', '晴'),
    天氣日('2026-04-10', '雨', '雨'),
  ], 開工日);
  expect(範圍(ops)).toEqual([
    { type: 'setRange', sheet: '監造內容', startAddr: 'C3', values: [['晴', '晴']] },
    { type: 'setRange', sheet: '監造內容', startAddr: 'C5', values: [['雨', '雨']] },
  ]);
});

// 公版範本漏了 C2/D2 這兩個子標題(人工報表有)。報表是常駐檔,放在寫入指令裡
// 才能讓既有的專案報表也一起補上。
test('順便補上「上午」「下午」子標題', () => {
  const ops = weatherToOperations([天氣日(開工日, '晴', '晴')], 開工日);
  expect(addrOf(ops, 'C2').value).toBe('上午');
  expect(addrOf(ops, 'D2').value).toBe('下午');
});

test('只有半天有天氣時,另一半寫 null 不寫空字串', () => {
  const ops = weatherToOperations([天氣日(開工日, '晴', '')], 開工日);
  expect(範圍(ops)[0].values).toEqual([['晴', null]]);
});

test('沒有任何天氣就不出指令(連子標題也不寫)', () => {
  expect(weatherToOperations([天氣日(開工日, null, '')], 開工日)).toEqual([]);
  expect(weatherToOperations([], 開工日)).toEqual([]);
});

// 天氣是附帶資訊,不該讓一份日誌因為它寫不進去而整份卡住——
// 數量本身的日期越界已由 daysToOperations 擋在前面(那裡是 throw)
test('日期越界只跳過那一天,不 throw', () => {
  const ops = weatherToOperations([
    天氣日('2026-04-07', '晴', '晴'),   // 早於開工日
    天氣日('2028-12-31', '晴', '晴'),   // 超出 763 列
    天氣日(開工日, '雨', '雨'),
  ], 開工日);
  expect(範圍(ops)).toEqual([
    { type: 'setRange', sheet: '監造內容', startAddr: 'C3', values: [['雨', '雨']] },
  ]);
});
