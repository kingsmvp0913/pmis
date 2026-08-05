const { validateDailyLog } = require('../server/daily-log-validate');

// 一列明細的預設形狀 = 「這列沒問題」,測試只覆寫要驗的那一欄。
const row = (項次, extra = {}) => ({
  項次, 工程項目: `項目${項次}`, 單位: '式',
  契約單價: 100, 契約數量: 10,
  本日完成數量: null, 本日完成金額: null, 累計完成數量: 0,
  ...extra,
});

const day = (填報日期, rows = [row('1')], header = {}) => ({
  header: {
    工程名稱: '測試工程', 填報日期, 星期: null,
    天氣_上午: '晴', 天氣_下午: '晴',
    預定進度: 10, 實際進度: 10, 出工總人數: null, 本日累計金額: 0,
    ...header,
  },
  dailyRows: rows,
});

const CONTRACT = [
  { 項次: '1', 項目: '項目1', 單位: '式', 數量: 10, 單價: 100 },
];
const PROJECT = {
  工程名稱: '測試工程', 承包廠商: '某某營造', 契約金額: 1000,
  開工日期: '2026-04-08', 竣工日期: '2026-12-31',
};

const run = (days, extra = {}) => validateDailyLog({
  days, contract: CONTRACT, project: PROJECT, ...extra,
});
const codes = (r) => r.errors.map((e) => e.code);
const wcodes = (r) => r.warnings.map((e) => e.code);

test('乾淨的日誌沒有任何硬錯', () => {
  const r = run([day('2026-04-08')]);
  expect(r.errors).toEqual([]);
});

// ── 欄位整份都缺 = 這個格式不提供,不是漏填 ────────────────────
// 金大那份 80 天的天氣全是 null(讀取器抽不到,或文件本來就沒這欄)。照 A2 判硬錯
// 的話,這家廠商的日誌 100% 過不了,而原因不是廠商漏填。同一個坑 SP1B 踩過:
// 「抽不到」與「真的沒填」不能當成同一件事。

test('某欄位整份都是 null 時跳過該條驗證', () => {
  const days = [
    day('2026-04-08', [row('1')], { 天氣_上午: null, 天氣_下午: null }),
    day('2026-04-09', [row('1')], { 天氣_上午: null, 天氣_下午: null }),
  ];
  const r = run(days);
  expect(codes(r)).not.toContain('A2');
});

// 靜默跳過會讓承辦人以為驗過了——沒驗到什麼一定要講
test('跳過的驗證要出現在報告裡並說明原因', () => {
  const days = [
    day('2026-04-08', [row('1')], { 天氣_上午: null, 天氣_下午: null }),
    day('2026-04-09', [row('1')], { 天氣_上午: null, 天氣_下午: null }),
  ];
  const r = run(days);
  const s = r.skipped.find((x) => x.code === 'A2');
  expect(s).toBeDefined();
  expect(s.原因).toMatch(/天氣/);
});

// 只有其中一天缺,那就是真的漏填了
test('只有部分天數缺該欄位時照樣判硬錯', () => {
  const days = [
    day('2026-04-08'),
    day('2026-04-09', [row('1')], { 天氣_上午: null }),
  ];
  const r = run(days);
  expect(codes(r)).toContain('A2');
  expect(r.errors.find((e) => e.code === 'A2').日期).toBe('2026-04-09');
});

// ── A 完整性 ───────────────────────────────────────────────

test('A1 填報日期未填', () => {
  const r = run([day('2026-04-08'), day(null)]);
  expect(codes(r)).toContain('A1');
});

// 填報日期是所有逐日驗證的定位點,缺了就無從說「哪一天錯」;
// 對這天再跑其他規則只會產生一串「日期 null」的錯誤,淹掉真正的問題。
test('A1 那一天不再跑其他逐日驗證', () => {
  const r = run([day('2026-04-08'), day(null, [row('1', { 單位: null })])]);
  expect(codes(r)).toContain('A1');
  expect(codes(r)).not.toContain('A6');
});

test('A2 天氣任一為空', () => {
  const r = run([day('2026-04-08'), day('2026-04-09', [row('1')], { 天氣_下午: null })]);
  expect(codes(r)).toContain('A2');
});

test('A3 星期未填是軟警告', () => {
  const r = run([
    day('2026-04-08', [row('1')], { 星期: '三' }),
    day('2026-04-09', [row('1')], { 星期: null }),
  ]);
  expect(wcodes(r)).toContain('A3');
  expect(codes(r)).not.toContain('A3');
});

// 只有一天時,「整份都缺」與「這天漏填」是同一件事,分不出來。分不出來就不放行——
// 否則承辦人單天補送一份漏填天氣的日誌,會被當成「這個格式不提供天氣」直接放過。
test('只有一天的日誌不套用「整份都缺」的放行', () => {
  const r = run([day('2026-04-08', [row('1')], { 天氣_上午: null, 天氣_下午: null })]);
  expect(codes(r)).toContain('A2');
  // 不驗 skipped 全空:B5 是「讀取器從來就沒有這個欄位」,與天數多寡無關,恆在其中
  expect(r.skipped.map((s) => s.code)).not.toContain('A2');
});

test.each([
  ['A4', { 項次: null }],
  ['A5', { 工程項目: '  ' }],
  ['A6', { 單位: null }],
  ['A7', { 契約數量: null }],
])('%s 明細欄位未填', (code, patch) => {
  const r = run([day('2026-04-08', [row('1', patch)])]);
  expect(codes(r)).toContain(code);
});

// 「壹 直接工程費」是大類標題,單位/數量/單價本來就都是空的(金大實測第 1 列)。
// 不排除的話,每一天都會生出 A5/A6/A7 三個假硬錯,承辦人幾天之後就學會忽略警告。
test('大類列不套用明細必填', () => {
  const r = run([day('2026-04-08', [
    { 項次: '壹', 工程項目: '直接工程費', 單位: null, 契約單價: null, 契約數量: null },
    row('1'),
  ])]);
  expect(codes(r)).toEqual([]);
});

// 費用項目(貳~陸)有完整的單位數量單價,是真的項目,不可跟著大類列一起跳過
test('費用項目仍套用明細必填', () => {
  const r = run([day('2026-04-08', [row('貳', { 單位: null }), row('1')])]);
  expect(codes(r)).toContain('A6');
});

test('A8 有施工卻缺數量或金額', () => {
  const r = run([day('2026-04-08', [
    row('1', { 本日完成數量: 5, 本日完成金額: null, 累計完成數量: 5 }),
  ])]);
  expect(codes(r)).toContain('A8');
});

test('A8 沒施工的日子不觸發', () => {
  const r = run([day('2026-04-08', [row('1', { 本日完成數量: null, 本日完成金額: null })])]);
  expect(codes(r)).not.toContain('A8');
});

// 錯誤要指得出「哪天、哪個項次」——只說「有 3 項硬錯」等於要承辦人自己翻 80 頁
test('每則錯誤都帶得出日期與項次', () => {
  const r = run([day('2026-04-09', [row('7', { 單位: null })])]);
  const e = r.errors.find((x) => x.code === 'A6');
  expect(e.日期).toBe('2026-04-09');
  expect(e.項次).toBe('7');
  expect(e.訊息).toEqual(expect.any(String));
});

// ── B 算術一致性 ────────────────────────────────────────────
// 讀取器**不提供**「累計完成金額」與「完成百分比」(三家的 dailyRows 都只有 8 欄)。
// 累計金額依總覽 spec 由「逐日累加本日完成金額」推導,並與「累計完成數量×單價」
// 交叉核對——兩種算法對不上就是資料有問題。完成百分比則無從驗起,列入 skipped。

const 兩天 = (r1, r2, h1 = {}, h2 = {}) => [
  day('2026-04-08', [r1], h1), day('2026-04-09', [r2], h2),
];

test('B2 累計不等於前一日累計加本日完成', () => {
  const r = run(兩天(
    row('1', { 本日完成數量: 3, 本日完成金額: 300, 累計完成數量: 3 }),
    row('1', { 本日完成數量: 2, 本日完成金額: 200, 累計完成數量: 9 }), // 應為 5
  ));
  expect(codes(r)).toContain('B2');
  expect(r.errors.find((e) => e.code === 'B2').日期).toBe('2026-04-09');
});

test('B2 累計正確時不觸發', () => {
  const r = run(兩天(
    row('1', { 本日完成數量: 3, 本日完成金額: 300, 累計完成數量: 3 }),
    row('1', { 本日完成數量: 2, 本日完成金額: 200, 累計完成數量: 5 }),
  ));
  expect(codes(r)).not.toContain('B2');
});

// 兩種算法:逐日累加的本日完成金額 vs 累計完成數量×契約單價。
// 對不上代表廠商填的金額與數量兜不起來。
test('B3 累加金額與累計數量乘單價不符', () => {
  const r = run([day('2026-04-08', [
    row('1', { 本日完成數量: 3, 本日完成金額: 999, 累計完成數量: 3 }), // 3×100=300
  ])]);
  expect(codes(r)).toContain('B3');
});

test('B4 本日累計金額與各項加總不符', () => {
  const r = run([day('2026-04-08', [
    row('1', { 本日完成數量: 3, 本日完成金額: 300, 累計完成數量: 3 }),
  ], { 本日累計金額: 999 })]);
  expect(codes(r)).toContain('B4');
});

test('B4 相符時不觸發', () => {
  const r = run([day('2026-04-08', [
    row('1', { 本日完成數量: 3, 本日完成金額: 300, 累計完成數量: 3 }),
  ], { 本日累計金額: 300 })]);
  expect(codes(r)).not.toContain('B4');
});

// 摯東的讀取器不給「本日完成金額」(該欄整份皆 null),沒有這欄就推導不出累計金額,
// B3/B4/C2 全部驗不了。硬跑會把每一列都判成錯,把真正的問題淹掉。
test('本日完成金額整份皆空時,依賴它的檢查一併跳過並記錄', () => {
  const r = run(兩天(
    row('1', { 本日完成數量: 3, 本日完成金額: null, 累計完成數量: 3 }),
    row('1', { 本日完成數量: 2, 本日完成金額: null, 累計完成數量: 5 }),
  ));
  for (const c of ['B3', 'B4', 'C2']) {
    expect(codes(r)).not.toContain(c);
    expect(r.skipped.map((s) => s.code)).toContain(c);
  }
});

// 完成百分比不在任何一家的 targetFields 裡,這條永遠驗不了——
// 不能靜默當作通過,要明講「沒驗到」。
test('B5 完成百分比因來源不存在而恆列入 skipped', () => {
  const r = run([day('2026-04-08')]);
  expect(r.skipped.map((s) => s.code)).toContain('B5');
});

// ── C 範圍/合理性 ───────────────────────────────────────────

test('C1 累計完成數量超過契約數量', () => {
  const r = run([day('2026-04-08', [
    row('1', { 契約數量: 10, 本日完成數量: 12, 本日完成金額: 1200, 累計完成數量: 12 }),
  ])]);
  expect(codes(r)).toContain('C1');
});

test('C2 累計完成金額超過契約金額', () => {
  const r = run([day('2026-04-08', [
    row('1', { 契約數量: 100, 本日完成數量: 50, 本日完成金額: 5000, 累計完成數量: 50 }),
  ])]); // 專案契約金額 1000
  expect(codes(r)).toContain('C2');
});

test.each([
  ['本日完成數量', -1],
  ['本日完成金額', -100],
  ['累計完成數量', -5],
])('C3 %s 為負值', (欄, v) => {
  const r = run([day('2026-04-08', [row('1', { [欄]: v })])]);
  expect(codes(r)).toContain('C3');
});

// 實測三家給的是比例(0.75 / 0.477)而非 0~100 的百分數,兩種都要視為合法——
// 這條擋的是 -3 或 250 這種明顯壞掉的值。
test.each([[0.75], [75], [0], [100]])('C4 進度 %p 視為合法', (v) => {
  const r = run([day('2026-04-08', [row('1')], { 預定進度: v, 實際進度: v })]);
  expect(codes(r)).not.toContain('C4');
});

test.each([[-3], [250]])('C4 進度 %p 判硬錯', (v) => {
  const r = run([day('2026-04-08', [row('1')], { 實際進度: v })]);
  expect(codes(r)).toContain('C4');
});

// ── D 日期連續性 ────────────────────────────────────────────

test('D1 同一份出現重複的填報日期', () => {
  const r = run([day('2026-04-08'), day('2026-04-08')]);
  expect(codes(r)).toContain('D1');
});

test.each([['2026-04-07'], ['2027-01-01']])('D3 填報日期 %s 落在工期外', (d) => {
  const r = run([day(d)]);
  expect(codes(r)).toContain('D3');
});

// 假日不填是常態(金大 04/10 之後直接跳到 04/13),不能把週末當成漏填;
// 這條抓的是連續多個工作日整天沒資料。軟警告不擋。
test('D4 工期內連續多日無資料是軟警告', () => {
  const r = run([day('2026-04-08'), day('2026-04-30')]);
  expect(wcodes(r)).toContain('D4');
  expect(codes(r)).not.toContain('D4');
});

test('D4 只跳過週末不算跳空', () => {
  // 2026-04-10 是週五,下一個工作日是 04-13(週一)——金大實測的真實樣態
  const r = run([day('2026-04-10'), day('2026-04-13')]);
  expect(wcodes(r)).not.toContain('D4');
});

// ── E 契約表核對 ────────────────────────────────────────────
// 基準是 SP2 建好的契約詳細價目表(contract_items),不是日誌自己說的契約值。

const C2ITEMS = [
  { 項次: '1', 項目: '項目1', 單位: '式', 數量: 10, 單價: 100 },
  { 項次: '2', 項目: '項目2', 單位: 'M2', 數量: 20, 單價: 50 },
];
const runC = (days) => validateDailyLog({ days, contract: C2ITEMS, project: PROJECT });

test('E1 日誌出現契約表沒有的項次', () => {
  const r = runC([day('2026-04-08', [row('1'), row('99')])]);
  expect(r.errors.map((e) => e.code)).toContain('E1');
  expect(r.errors.find((e) => e.code === 'E1').項次).toBe('99');
});

// 契約表有、日誌整期都沒出現過:可能是漏做也可能是還沒做到,故軟警告
test('E2 契約項目整期未出現是軟警告', () => {
  const r = runC([day('2026-04-08', [row('1')])]);
  expect(r.warnings.map((e) => e.code)).toContain('E2');
  expect(r.warnings.find((e) => e.code === 'E2').項次).toBe('2');
});

test('E3 項目名稱與契約表不一致是軟警告', () => {
  const r = runC([day('2026-04-08', [row('1', { 工程項目: '不一樣的名稱' }), row('2')])]);
  expect(r.warnings.map((e) => e.code)).toContain('E3');
});

test.each([
  ['E4', { 單位: 'KG' }],
  ['E5', { 契約數量: 999 }],
  ['E6', { 契約單價: 999 }],
])('%s 與契約表不一致判硬錯', (code, patch) => {
  const r = runC([day('2026-04-08', [row('1', patch), row('2')])]);
  expect(r.errors.map((e) => e.code)).toContain(code);
});

// 名稱比對要吃掉空白差異,否則排版差異會製造一堆假警報(沿用 org-match 的教訓)
test('E3 只差空白視為一致', () => {
  const r = runC([day('2026-04-08', [row('1', { 工程項目: ' 項目1 ' }), row('2')])]);
  expect(r.warnings.map((e) => e.code)).not.toContain('E3');
});

// 日誌沒有「契約複價」欄位(三家的 dailyRows 都只有 8 欄),這條驗不了;
// 而契約表自身的複價一致性 SP2 寫入時已驗過。
test('E7 因日誌不提供契約複價而恆列入 skipped', () => {
  const r = runC([day('2026-04-08')]);
  expect(r.skipped.map((s) => s.code)).toContain('E7');
});

// ── F 跨天單調 ──────────────────────────────────────────────

test('F1 累計完成數量逐日變小', () => {
  const r = run(兩天(
    row('1', { 本日完成數量: 5, 本日完成金額: 500, 累計完成數量: 5 }),
    row('1', { 本日完成數量: 0, 本日完成金額: 0, 累計完成數量: 3 }),
  ));
  expect(codes(r)).toContain('F1');
});

// 累計完成金額沒有獨立來源(讀取器不給該欄),推導值是逐日累加的結果、天然不會
// 回退,拿它驗「不回退」等於自己驗自己。負的本日金額由 C3 擋。
test('F2 因累計完成金額無獨立來源而恆列入 skipped', () => {
  const r = run([day('2026-04-08')]);
  expect(r.skipped.map((s) => s.code)).toContain('F2');
});

test('F3 實際進度逐日變小是軟警告', () => {
  const r = run(兩天(row('1'), row('1'), { 實際進度: 20 }, { 實際進度: 15 }));
  expect(wcodes(r)).toContain('F3');
  expect(codes(r)).not.toContain('F3');
});

// 期末 = 這批日誌的最後一天(不是竣工日)。跨批次提交時等竣工才驗會太晚,
// 而每一批自己都該兜得起來。
test('F4 期末累計不等於各日本日完成的總和', () => {
  const r = run(兩天(
    row('1', { 本日完成數量: 3, 本日完成金額: 300, 累計完成數量: 3 }),
    row('1', { 本日完成數量: 2, 本日完成金額: 200, 累計完成數量: 5 }),
  ).map((d, i) => (i === 1
    ? { ...d, dailyRows: [{ ...d.dailyRows[0], 累計完成數量: 5, 本日完成數量: 99 }] }
    : d)));
  expect(codes(r)).toContain('F4');
});

// ── G 主檔一致 ──────────────────────────────────────────────

test.each([
  ['G1', { 工程名稱: '別的工程' }],
])('%s 與專案主檔不一致是軟警告', (code, patch) => {
  const r = run([day('2026-04-08', [row('1')], patch)]);
  expect(wcodes(r)).toContain(code);
  expect(codes(r)).not.toContain(code);
});

test('G1 只差空白視為一致', () => {
  const r = run([day('2026-04-08', [row('1')], { 工程名稱: ' 測試 工程 ' })]);
  expect(wcodes(r)).not.toContain('G1');
});

// ── H 進度落後 ──────────────────────────────────────────────

test('H1 實際進度落後預定超過 10 個百分點', () => {
  const r = run([day('2026-04-08', [row('1')], { 預定進度: 50, 實際進度: 30 })]);
  expect(wcodes(r)).toContain('H1');
});

test('H1 比例制的值也要判得出來', () => {
  // 實測晉林/摯東給的是 0.75 這種比例;0.50 vs 0.30 同樣是落後 20 個百分點
  const r = run([day('2026-04-08', [row('1')], { 預定進度: 0.5, 實際進度: 0.3 })]);
  expect(wcodes(r)).toContain('H1');
});

test('H1 進度正常時不觸發', () => {
  const r = run([day('2026-04-08', [row('1')], { 預定進度: 50, 實際進度: 48 })]);
  expect(wcodes(r)).not.toContain('H1');
});

// ── J 值域/字典 ─────────────────────────────────────────────

test('J1 天氣不在已知集合是軟警告', () => {
  const r = run([day('2026-04-08', [row('1')], { 天氣_上午: '好天氣' })]);
  expect(wcodes(r)).toContain('J1');
});

test.each([['晴'], ['陰'], ['多雲'], ['雨'], ['雷雨'], ['颱風']])('J1 %s 視為合法天氣', (w) => {
  const r = run([day('2026-04-08', [row('1')], { 天氣_上午: w, 天氣_下午: w })]);
  expect(wcodes(r)).not.toContain('J1');
});

test('J2 單位不在字典是軟警告', () => {
  const r = run([day('2026-04-08', [row('1', { 單位: 'XYZ' })])]);
  expect(wcodes(r)).toContain('J2');
});

// 金大實測項次 7、8 的單位被讀成 "RC"——那是讀取器把項目名稱吃進單位欄,
// 字典檢查正好抓得到這種讀取器缺陷
test('J2 抓得到讀取器把非單位字串放進單位欄', () => {
  const r = run([day('2026-04-08', [row('1', { 單位: 'RC' })])]);
  expect(wcodes(r)).toContain('J2');
});

test('J3 同一項次跨天單位不一致', () => {
  const r = run(兩天(row('1', { 單位: '式' }), row('1', { 單位: 'M2' })));
  expect(wcodes(r)).toContain('J3');
});

test.each([['星期三'], ['三']])('J4 星期 %s 與日期相符時不觸發', (w) => {
  const r = run([day('2026-04-08', [row('1')], { 星期: w })]); // 2026-04-08 是星期三
  expect(wcodes(r)).not.toContain('J4');
});

test('J4 星期與日期推算不符是軟警告', () => {
  const r = run([day('2026-04-08', [row('1')], { 星期: '星期一' })]);
  expect(wcodes(r)).toContain('J4');
});

// 晉林那份實測跑出 81 個「累計完成數量 1.0000000000000002 超過契約數量 1」——
// 全是浮點累加誤差造成的假警報。逐列比較一律要走與 approx 同一套容差,
// 否則承辦人會在 81 則假硬錯裡找不到真正的問題。
test('C1 浮點尾差不算超量', () => {
  const r = run([day('2026-04-08', [
    row('1', { 契約數量: 1, 本日完成數量: 1, 本日完成金額: 100, 累計完成數量: 1.0000000000000002 }),
  ])]);
  expect(codes(r)).not.toContain('C1');
});

test('C1 真的超量仍要抓到', () => {
  const r = run([day('2026-04-08', [
    row('1', { 契約數量: 266, 本日完成數量: 270, 本日完成金額: 27000, 累計完成數量: 270 }),
  ])]);
  expect(codes(r)).toContain('C1');
});

test('F1 浮點尾差不算回退', () => {
  const r = run(兩天(
    row('1', { 本日完成數量: 1, 本日完成金額: 100, 累計完成數量: 1.0000000000000002 }),
    row('1', { 本日完成數量: 0, 本日完成金額: 0, 累計完成數量: 1 }),
  ));
  expect(codes(r)).not.toContain('F1');
});

// ── 跨批次:前期累計要當成起點 ────────────────────────────────
// 施工日誌分多批提交,而累計欄位是跨批累積的。第二批的「累計完成數量 5」包含
// 第一批做的 3——驗證層若從 0 起算,B3(累加金額 vs 累計數量×單價)在每一批的
// 第一天都必然誤判,承辦人送第二批就會被擋死。

test('有前期累計時,第二批的累計對得起來就不判錯', () => {
  const r = validateDailyLog({
    days: [day('2026-05-06', [
      row('1', { 本日完成數量: 2, 本日完成金額: 200, 累計完成數量: 5 }),
    ])],
    contract: CONTRACT,
    project: PROJECT,
    prior: { 1: { 數量: 3, 金額: 300 } },
  });
  expect(r.errors.map((e) => e.code)).not.toContain('B3');
  expect(r.errors.map((e) => e.code)).not.toContain('B2');
});

test('有前期累計時,累計比前期還小仍要判回退', () => {
  const r = validateDailyLog({
    days: [day('2026-05-06', [
      row('1', { 本日完成數量: 0, 本日完成金額: 0, 累計完成數量: 1 }),
    ])],
    contract: CONTRACT,
    project: PROJECT,
    prior: { 1: { 數量: 3, 金額: 300 } },
  });
  expect(r.errors.map((e) => e.code)).toContain('F1');
});

test('沒有前期累計時視為從零開始', () => {
  const r = run([day('2026-04-08', [
    row('1', { 本日完成數量: 2, 本日完成金額: 200, 累計完成數量: 2 }),
  ])]);
  expect(codes(r)).not.toContain('B3');
});
