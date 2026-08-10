const { compareKickoff, hardErrors, validateValues } = require('../server/kickoff-compare');

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

// validateValues 收的是承辦人確認後的值(extractFields 形狀),回傳的欄位一律用
// 比對表上的中文標籤,前端才標得到對應那一列(koResultCells 以標籤為鍵)。
const VALUES = KICKOFF;
// 不手排 Unicode 順序(本檔既有測試已因此踩過一次),兩邊都 sort 再比
const REQUIRED_LABELS = ['工程名稱', '契約編號', '契約金額', '縣市', '契約工期', '契約規定開工日', '契約規定竣工日'].sort();
const 欄位s = (errs) => errs.map((e) => e.欄位).sort();

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
  const r = find(rows, '契約工期');
  expect(r.狀態).toBe('diff');
  expect(r.級別).toBe('hard');
  expect(hardErrors(rows).map((x) => x.欄位)).toContain('契約工期');
});

// 明禮是 160 工作天。由日期推導出的是日曆天,硬比必然假警報。
// 2026-08-10 規格變更:工作天不再要求承辦人換算成日曆天。
//
// 舊行為是「工期欄只收日曆天,工作天的案子刻意留空、警示請自行換算」——換算是
// 一個容易算錯又無從查核的人工步驟。現在工期天數與基準是分開的兩欄,而開工報告表
// 上的竣工日本來就是廠商/機關算好的,系統要做的是**驗算而不是重算**:
// 工作天扣掉假日,必然 ≤ 同一段期間的日曆天數。
test('工作天 ≤ 同期間的日曆天 → 合理,放行', () => {
  // KICKOFF 的開工→竣工推導是 150 日曆天;120 個工作天配 150 個日曆天(扣掉週末)合理
  const rows = compareKickoff(
    { ...KICKOFF, 契約工期: { 天數: 120, 基準: '工作天' } }, AWARD, { confirmed: true });
  expect(find(rows, '契約工期').狀態).toBe('match');
  expect(hardErrors(rows)).toEqual([]);
});

test('工作天多於同期間的日曆天 → 這份表自己填錯了,判硬錯', () => {
  const rows = compareKickoff(
    { ...KICKOFF, 契約工期: { 天數: 160, 基準: '工作天' } }, AWARD, { confirmed: true });
  expect(find(rows, '契約工期').狀態).toBe('diff');
  expect(hardErrors(rows).map((r) => r.欄位)).toContain('契約工期');
});

// 解析階段(OCR 讀到的值)與確認階段走同一套判斷:不再需要區分,
// 因為兩邊的「工作天」現在是同一個意思,不像舊版那樣一個是原值一個是換算值。
test('解析階段與確認階段的工作天判定一致', () => {
  const k = { ...KICKOFF, 契約工期: { 天數: 120, 基準: '工作天' } };
  expect(find(compareKickoff(k, AWARD), '契約工期').狀態)
    .toBe(find(compareKickoff(k, AWARD, { confirmed: true }), '契約工期').狀態);
});

// 日曆天維持原本的等值驗算:表上兩個數字互相矛盾就是這份文件自己填錯,
// 沒有「預估值」這種正常解釋可以開脫。
test('日曆天仍要求與推導值相等', () => {
  const rows = compareKickoff(
    { ...KICKOFF, 契約工期: { 天數: 140, 基準: '日曆天' } }, AWARD, { confirmed: true });
  expect(hardErrors(rows).map((r) => r.欄位)).toContain('契約工期');
});

// 古坑:整體平移 10 天,兩邊工期都是 180。判硬錯會逼承辦人去請廠商
// 修正一份正確的文件(spec §5.3)。契約工期需同步改成與新日期自洽的 180,
// 否則這份「開工報告表」會變成自己內部就對不起來(150 vs 推導 180),
// 那本來就該判契約工期硬錯——不是在測「日期差異不進硬錯」了。
test('開工日竣工日只是提示,不進硬錯', () => {
  const rows = compareKickoff(
    {
      ...KICKOFF,
      契約規定開工日: '2026-07-15',
      契約規定竣工日: '2027-01-10',
      契約工期: { 天數: 180, 基準: '日曆天' },
    },
    { ...AWARD, 履約起迄: { 起: '115/07/05', 迄: '115/12/31' } }
  );
  expect(find(rows, '契約規定開工日').級別).toBe('hint');
  expect(find(rows, '契約規定開工日').狀態).toBe('diff');
  expect(hardErrors(rows)).toEqual([]);
});

// 只動開工日、竣工日沿用基準值(2026-08-14)時,契約工期須同步改成與新開工日
// 自洽的 31 天,否則又是同一種「表內自己對不起來」的資料矛盾(見上一測試的說明)。
test('提示欄位顯示差幾天', () => {
  const rows = compareKickoff(
    { ...KICKOFF, 契約規定開工日: '2026-07-15', 契約工期: { 天數: 31, 基準: '日曆天' } },
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

// 元長國小真實案例(工程名稱字串直接引用 kickoff-report.test.js:239 釘住的真值):
// OCR 把開工報告表上「114-116年」的半形連字號讀成中文數字「一」,且前後夾著
// 空白。只在 org-match.test.js 驗證 normalizeOrgName 不夠——compareKickoff 是
// 承辦人實際會看到判定結果的那一層,如果日後有人在 eqText 或 cleanValue 動了
// 手腳,只測 normalizeOrgName 不會抓到,要在這個端到端層級也釘住一次。
test('元長國小真實案例:OCR 把連字號讀成「一」不影響工程名稱比對', () => {
  const rows = compareKickoff(
    { ...KICKOFF, 工程名稱: '元長國小辦理 「 114 一 116 年公立國民中小學老舊廁所整修工程計畫 」' },
    { ...AWARD, 工程名稱: '元長國小辦理「114-116年公立國民中小學老舊廁所整修工程計畫」' }
  );
  expect(find(rows, '工程名稱').狀態).toBe('match');
});

// ── 必填與值域(validateValues)──────────────────────────────
// 為何另立一層:hardErrors 只認 'diff',missing 一律放行(那是「沒得比」,
// 不是「填錯」),所以在這層之前,九欄全空也照樣歸檔成功,SP2 接到的會是
// 一份空的工程基本資料。必填看的是「開工報告表值本身有沒有」,與比對狀態無關。

test('七個必填欄位為空時一次列全', () => {
  const errs = validateValues({});
  expect(欄位s(errs)).toEqual(REQUIRED_LABELS);
});

// 署名欄校名 21/24(3 份被印章蓋掉尾字)、臺中市格式整份無決標日——
// 這兩欄不是每份文件都有,列必填會讓合法文件永遠歸不了檔
test('學校與決標日留空不擋', () => {
  const errs = validateValues({ ...VALUES, 主辦機關: null, 決標日期: null });
  expect(errs).toEqual([]);
});

test('必填齊全時無錯', () => {
  expect(validateValues(VALUES)).toEqual([]);
});

// 前端金額欄是 <input type=number>,瀏覽器擋不住負號與小數,後端不驗就直接歸檔。
// 決標金額在 DB 是整數元,小數點進來就與決標公告永遠比不相等。
test.each([[0], [-1], [3122168.5]])('契約金額 %p 判硬錯', (金額) => {
  const errs = validateValues({ ...VALUES, 契約金額: 金額 });
  expect(欄位s(errs)).toEqual(['契約金額']);
  expect(errs[0].級別).toBe('hard');
});

test.each([[0], [-30]])('契約工期 %p 判硬錯', (天數) => {
  const errs = validateValues({ ...VALUES, 契約工期: { 天數, 基準: '日曆天' } });
  expect(欄位s(errs)).toEqual(['契約工期']);
});

// 日期填反時 deriveDuration 回 null,契約工期只會顯示 missing(沒得比),
// 承辦人看到的是「工期讀不到」而不是「日期填反了」——兩者要做的事不同。
test('竣工日早於開工日判硬錯', () => {
  const errs = validateValues({
    ...VALUES, 契約規定開工日: '2026-08-14', 契約規定竣工日: '2026-03-18',
  });
  expect(欄位s(errs)).toEqual(['契約規定竣工日']);
});

// 前端 <input type=date> 送不出 2/30,但 confirm 收的是 JSON,繞得過去。
// rocToISO 已擋掉民國字串的不存在日期,ISO 這條路徑同樣要擋。
test('日曆上不存在的日期判硬錯', () => {
  const errs = validateValues({ ...VALUES, 契約規定開工日: '2026-02-30' });
  expect(欄位s(errs)).toEqual(['契約規定開工日']);
});

// 決標之後才會開工。反過來多半是承辦人把兩個日期填顛倒,但決標日本身可空、
// 也有補辦決標的例外,判硬錯會擋住合法文件,故只提示。
test('決標日晚於開工日只提示不擋', () => {
  const errs = validateValues({ ...VALUES, 決標日期: '2026-03-19', 契約規定開工日: '2026-03-18' });
  expect(欄位s(errs)).toEqual(['決標日']);
  expect(errs[0].級別).toBe('hint');
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
