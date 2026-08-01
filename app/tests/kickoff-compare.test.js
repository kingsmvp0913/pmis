const { compareKickoff, hardErrors } = require('../server/kickoff-compare');

const AWARD = {
  工程名稱: '114年南陽國小北棟教室廁所整修工程',
  工程編號: '1150113',
  契約金額: 3122168,
  決標日期: '115/03/18',
  主辦機關: '雲林縣北港鎮南陽國民小學',
  履約地點: '雲林縣',
  履約起迄: { 起: '115/03/18', 迄: '115/08/14' },
};
const KICKOFF = {
  工程名稱: '114年南陽國小北棟教室廁所整修工程',
  契約編號: '1150113',
  契約金額: 3122168,
  決標日期: '2026-03-18',
  契約工期: { 天數: 150, 基準: '日曆天' },
  主辦機關: '雲林縣北港鎮南陽國民小學',
  縣市: '雲林縣',
  契約規定開工日: '2026-03-18',
  契約規定竣工日: '2026-08-14',
};
const find = (rows, 欄位) => rows.find((r) => r.欄位 === 欄位);

test('全部相符時無硬錯', () => {
  const rows = compareKickoff(KICKOFF, AWARD);
  expect(hardErrors(rows)).toEqual([]);
  expect(find(rows, '工程名稱').狀態).toBe('match');
});

// 契約編號格式各機關自訂(1150113 / A1150608 / ywjh11504 / 114-17),
// 數值化會把 '0123' 誤判等於 '123'(沿用 SP1 commit edca759)
test('契約編號不做數值正規化', () => {
  const rows = compareKickoff({ ...KICKOFF, 契約編號: '0123' }, { ...AWARD, 工程編號: '123' });
  expect(find(rows, '契約編號').狀態).toBe('diff');
});

// 同一份文件內即混用臺/台,不正規化就是純假警報
test('臺台正規化後視為相符', () => {
  const rows = compareKickoff(
    { ...KICKOFF, 主辦機關: '雲林縣立臺西國民中學', 縣市: '臺西縣' },
    { ...AWARD, 主辦機關: '雲林縣立台西國民中學', 履約地點: '台西縣' }
  );
  expect(find(rows, '學校').狀態).toBe('match');
  expect(find(rows, '縣市').狀態).toBe('match');
});

// 契約工期是開工報告表的內部自洽性檢查:表上明載值 vs 表上日期推導值,
// **不與決標公告比**(SP1 §4.3 已用 27 組推翻「履約起迄推工期」)
test('契約工期比的是表內自洽,不是決標公告', () => {
  const rows = compareKickoff(KICKOFF, AWARD);
  const r = find(rows, '契約工期');
  expect(r.狀態).toBe('match');
  expect(r.決標公告值).toBe('（表內推導）150');
});

test('契約工期表上值與推導值不符判硬錯', () => {
  const rows = compareKickoff({ ...KICKOFF, 契約工期: { 天數: 140, 基準: '日曆天' } }, AWARD);
  expect(find(rows, '契約工期').狀態).toBe('diff');
});

// 明禮是 160 工作天。由日期推導出的是日曆天,硬比必然假警報。
test('工作天不推導,狀態為 missing 不判硬錯', () => {
  const rows = compareKickoff({ ...KICKOFF, 契約工期: { 天數: 160, 基準: '工作天' } }, AWARD);
  const r = find(rows, '契約工期');
  expect(r.狀態).toBe('missing');
  expect(hardErrors(rows)).toEqual([]);
});

// 古坑:整體平移 10 天,兩邊工期都是 180。判硬錯會逼承辦人去請廠商
// 修正一份正確的文件(spec §5.3)。
test('開工日竣工日只是提示,不進硬錯', () => {
  const rows = compareKickoff(
    { ...KICKOFF, 契約規定開工日: '2026-07-15', 契約規定竣工日: '2027-01-10' },
    { ...AWARD, 履約起迄: { 起: '115/07/05', 迄: '115/12/31' } }
  );
  expect(find(rows, '契約規定開工日').級別).toBe('hint');
  expect(find(rows, '契約規定開工日').狀態).toBe('diff');
  expect(hardErrors(rows)).toEqual([]);
});

test('提示欄位顯示差幾天', () => {
  const rows = compareKickoff(
    { ...KICKOFF, 契約規定開工日: '2026-07-15' },
    { ...AWARD, 履約起迄: { 起: '115/07/05', 迄: '115/12/31' } }
  );
  expect(find(rows, '契約規定開工日').差異天數).toBe(10);
});

// 鹿場 B1150513 整份無履約起迄日期
test('決標公告缺履約起迄時提示欄位為 missing', () => {
  const rows = compareKickoff(KICKOFF, { ...AWARD, 履約起迄: { 起: null, 迄: null } });
  expect(find(rows, '契約規定開工日').狀態).toBe('missing');
});

// 舊案補登只需工程名稱(spec §8),沒有歸檔的決標公告時不得阻擋歸檔
test('無決標公告時全部欄位 no_award 且無硬錯', () => {
  const rows = compareKickoff(KICKOFF, null);
  expect(rows.every((r) => r.狀態 === 'no_award' || r.欄位 === '契約工期')).toBe(true);
  expect(hardErrors(rows)).toEqual([]);
});

// 三態不可壓成布林:'missing'(沒得比)與 'diff'(比出來不同)
// 對承辦人是兩件不同的事
test('開工報告表讀不到的欄位是 missing 不是 diff', () => {
  const rows = compareKickoff({ ...KICKOFF, 契約金額: null }, AWARD);
  expect(find(rows, '契約金額').狀態).toBe('missing');
  expect(hardErrors(rows)).toEqual([]);
});

// 逐條修正會讓承辦人來回發文好幾次
test('硬錯一次列全', () => {
  const rows = compareKickoff(
    { ...KICKOFF, 工程名稱: 'X', 契約編號: 'Y', 契約金額: 1 },
    AWARD
  );
  // 注意:['契約金額','契約編號','工程名稱'].sort() 在 JS 中恆為
  // ['契約編號','契約金額','工程名稱'](編 U+7DE8 < 金 U+91D1),與 brief 原字面
  // 期望值順序矛盾且無法靠實作滿足(排序發生在測試碼內、不受 hardErrors 回傳
  // 順序影響)。已用 node 實測確認,改為實際排序結果,語意不變(仍驗證這三欄
  // 且僅這三欄列為硬錯)。見 task-6-report.md。
  expect(hardErrors(rows).map((r) => r.欄位).sort()).toEqual(['契約編號', '契約金額', '工程名稱']);
});
