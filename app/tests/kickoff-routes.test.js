process.env.JWT_SECRET = 'test-secret';

const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const db = require('../server/db');

// OCR 不在測試中真的跑(spec §8),以固定輸出當 fixture
jest.mock('../server/kickoff-report', () => ({ readKickoffReport: jest.fn() }));
jest.mock('../server/award-notice', () => ({ readAwardNotice: jest.fn() }));
const { readKickoffReport } = require('../server/kickoff-report');
const { readAwardNotice } = require('../server/award-notice');

const { registerRoutes: registerAuthRoutes } = require('../server/auth');
const { registerRoutes: registerKickoffRoutes, fillProjectMasterFromKickoff } = require('../server/kickoff-routes');

const KICKOFF = {
  工程名稱: '南陽廁所整修', 契約編號: '1150113', 契約金額: 3122168,
  決標日期: '2026-03-18', 契約工期: { 天數: 150, 基準: '日曆天' },
  主辦機關: '雲林縣北港鎮南陽國民小學', 縣市: '雲林縣',
  契約規定開工日: '2026-03-18', 契約規定竣工日: '2026-08-14',
};
const AWARD = {
  工程名稱: '南陽廁所整修', 工程編號: '1150113', 契約金額: 3122168,
  決標日期: '115/03/18', 主辦機關: '雲林縣北港鎮南陽國民小學',
  履約地點: '雲林縣', 履約起迄: { 起: '115/03/18', 迄: '115/08/14' },
};

async function makeApp({ withAward = true } = {}) {
  const mem = newDb();
  db._setPoolForTesting(new (mem.adapters.createPg()).Pool());
  await db.migrate();
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  registerKickoffRoutes(app);
  const setup = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password1', display_name: '管理員' });
  const { rows } = await db.query(`INSERT INTO projects (name) VALUES ('南陽廁所整修') RETURNING id`);
  const id = rows[0].id;
  if (withAward) {
    await db.query(
      `INSERT INTO project_attachments (project_id, kind, file_path, original_name)
       VALUES ($1, 'award_notice', $2, 'a.pdf')`, [id, `uploads/proj_${id}/a.pdf`]);
  }
  return { app, token: setup.body.token, id };
}

beforeEach(() => jest.clearAllMocks());

test('未帶 token 回 401', async () => {
  const { app, id } = await makeApp();
  await request(app).post(`/api/projects/${id}/kickoff-report/parse`).expect(401);
});

test('沒帶檔案回 400', async () => {
  const { app, token, id } = await makeApp();
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/parse`)
    .set('Authorization', `Bearer ${token}`).expect(400);
  expect(res.body.error).toMatch(/開工報告表/);
});

// id 形狀不合法會讓 PostgreSQL 丟型別錯誤被 catch 成 500,
// 承辦人會以為系統壞了(沿用 project-basics-routes 的 isProjectIdShape)
test('工程不存在回 404', async () => {
  const { app, token } = await makeApp();
  await request(app).post('/api/projects/abc/kickoff-report/parse')
    .set('Authorization', `Bearer ${token}`)
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(404);
});

test('parse 回比對結果且不落檔', async () => {
  readKickoffReport.mockResolvedValue(KICKOFF);
  readAwardNotice.mockResolvedValue(AWARD);
  const { app, token, id } = await makeApp();
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/parse`)
    .set('Authorization', `Bearer ${token}`)
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(200);
  expect(res.body.hasAward).toBe(true);
  expect(res.body.rows.find((r) => r.欄位 === '工程名稱').狀態).toBe('match');
  // 純唯讀:parse 不得產生附件,否則有硬錯時會留下垃圾
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM project_attachments WHERE kind = 'kickoff_report'`);
  expect(rows[0].n).toBe(0);
});

// 2026-08-05 規格變更:原本「舊案補登只需工程名稱,沒有決標公告不得阻擋」已被
// 推翻——建工程的唯一入口改成上傳決標公告,沒有公告的工程一律重建。擋在 parse
// 而非 confirm:OCR 要跑數十秒,讓承辦人等完才說「這個工程不能歸檔」是白等。
test('無決標公告時 parse 直接擋下並要求以決標公告重建工程', async () => {
  readKickoffReport.mockResolvedValue(KICKOFF);
  const { app, token, id } = await makeApp({ withAward: false });
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/parse`)
    .set('Authorization', `Bearer ${token}`)
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(400);
  expect(res.body.error).toMatch(/決標公告/);
  expect(res.body.error).toMatch(/重新建立/);
  // 擋在 OCR 之前才有意義
  expect(readKickoffReport).not.toHaveBeenCalled();
});

// 「這個工程沒照規則建立,請重建」與「公告檔壞了」要做的事完全不同:後者的
// 工程本身是合法的,叫承辦人重建等於要他砍掉一個沒問題的案子。
test('決標公告已歸檔但讀不出來時,訊息指向檔案而非要求重建工程', async () => {
  readAwardNotice.mockRejectedValue(new Error('PDF 損毀'));
  const { app, token, id } = await makeApp();
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/parse`)
    .set('Authorization', `Bearer ${token}`)
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(400);
  expect(res.body.error).toMatch(/決標公告/);
  expect(res.body.error).not.toMatch(/重新建立工程/);
});

test('無決標公告時 confirm 也擋下', async () => {
  const { app, token, id } = await makeApp({ withAward: false });
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .field('values', JSON.stringify(KICKOFF))
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(400);
  expect(res.body.error).toMatch(/決標公告/);
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM project_attachments WHERE kind = 'kickoff_report'`);
  expect(rows[0].n).toBe(0);
});

// 3/24 份不是開工報告表。硬湊欄位會讓承辦人以為系統看懂了。
test('非開工報告表回 400 明確訊息', async () => {
  const err = new Error('此檔無法辨識為開工報告表(缺少必要欄位標籤),請確認上傳的是開工報告表');
  err.code = 'NOT_KICKOFF_REPORT';
  readKickoffReport.mockRejectedValue(err);
  // parse 現在先要有可讀的決標公告才會走到 OCR,否則會停在前一關而測不到這裡
  readAwardNotice.mockResolvedValue(AWARD);
  const { app, token, id } = await makeApp();
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/parse`)
    .set('Authorization', `Bearer ${token}`)
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(400);
  expect(res.body.error).toMatch(/無法辨識為開工報告表/);
});

// OCR 內部錯誤細節(路徑、驅動訊息)不得回給前端
test('OCR 失敗回 500 且不洩漏內部訊息', async () => {
  readKickoffReport.mockRejectedValue(new Error('OCR 驅動失敗: C:\\Windows\\...'));
  readAwardNotice.mockResolvedValue(AWARD); // 同上:先過決標公告這一關才輪到 OCR
  const { app, token, id } = await makeApp();
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/parse`)
    .set('Authorization', `Bearer ${token}`)
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(500);
  expect(res.body.error).not.toMatch(/Windows/);
});

// 有硬錯不得標記已核對(spec §5.1),且要一次列全
test('confirm 有硬錯回 400 並列出全部不符欄位', async () => {
  readAwardNotice.mockResolvedValue(AWARD);
  const { app, token, id } = await makeApp();
  const bad = { ...KICKOFF, 工程名稱: 'X', 契約編號: 'Y' };
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .field('values', JSON.stringify(bad))
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(400);
  expect(res.body.fields.sort()).toEqual(['契約編號', '工程名稱']);
  // 硬錯全是跨文件比對欄位:文案須維持指向決標公告,不得夾帶「表格」/「推導」字樣
  // (那是契約工期專屬的自洽性檢查,與本案無關)
  expect(res.body.error).toMatch(/決標公告/);
  expect(res.body.error).not.toMatch(/表格|推導/);
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM project_attachments WHERE kind = 'kickoff_report'`);
  expect(rows[0].n).toBe(0);
});

// 契約工期比的是開工報告表自身(表列工期 vs 開工/竣工日推導值),不是決標公告——
// 唯一硬錯是契約工期時,文案不得叫承辦人去對決標公告發文,那是不相干的動作。
test('confirm 唯一硬錯是契約工期時,訊息指向表格自身而非決標公告', async () => {
  readAwardNotice.mockResolvedValue(AWARD);
  const { app, token, id } = await makeApp();
  // 其餘欄位與 AWARD 一致(仍會 match),只讓契約工期的表列天數與推導值(150)兜不起來
  const bad = { ...KICKOFF, 契約工期: { 天數: 999, 基準: '日曆天' } };
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .field('values', JSON.stringify(bad))
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(400);
  expect(res.body.fields).toEqual(['契約工期']);
  expect(res.body.error).toMatch(/表格|開工報告表/);
  expect(res.body.error).not.toMatch(/決標公告/);
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM project_attachments WHERE kind = 'kickoff_report'`);
  expect(rows[0].n).toBe(0);
});

// 混合案例:跨文件欄位與契約工期同時硬錯,兩種問題的處理方式不同,
// 文案不得只講其中一邊而讓另一邊看起來像同一類問題。
test('confirm 硬錯同時含跨文件欄位與契約工期時,訊息同時涵蓋兩種情況', async () => {
  readAwardNotice.mockResolvedValue(AWARD);
  const { app, token, id } = await makeApp();
  const bad = { ...KICKOFF, 工程名稱: 'X', 契約工期: { 天數: 999, 基準: '日曆天' } };
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .field('values', JSON.stringify(bad))
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(400);
  expect(res.body.fields.sort()).toEqual(['契約工期', '工程名稱']);
  expect(res.body.error).toMatch(/決標公告/);
  expect(res.body.error).toMatch(/表格|開工報告表/);
});

// 無硬錯 → 歸檔。歸檔即代表已核對(不另設狀態欄)。
test('confirm 無硬錯時歸檔為 kickoff_report', async () => {
  readAwardNotice.mockResolvedValue(AWARD);
  const { app, token, id } = await makeApp();
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .field('values', JSON.stringify(KICKOFF))
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), '開工報告表.pdf').expect(200);
  expect(res.body.ok).toBe(true);
  const { rows } = await db.query(
    `SELECT kind, original_name FROM project_attachments WHERE project_id = $1 AND kind = 'kickoff_report'`,
    [id]);
  expect(rows).toHaveLength(1);
  expect(rows[0].original_name).toBe('開工報告表.pdf');
});

// 少填一欄不會被 hardErrors 抓到(那只認 diff),沒有這層就會歸檔一份空表
test('confirm 必填欄位留空時擋下', async () => {
  readAwardNotice.mockResolvedValue(AWARD);
  const { app, token, id } = await makeApp();
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .field('values', JSON.stringify({ ...KICKOFF, 縣市: null }))
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(400);
  expect(res.body.fields).toContain('縣市');
  // 逐欄原因要能標回那一列:只回欄位清單的話,前端只能套一句通用文案,而目前
  // 那句是「與決標公告不符」——必填漏填根本不是跨文件比對的問題,會指錯方向。
  expect(res.body.fieldMessages.縣市).toMatch(/必填/);
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM project_attachments WHERE kind = 'kickoff_report'`);
  expect(rows[0].n).toBe(0);
});

// 署名欄校名 21/24、臺中市格式無決標日,這兩欄空著仍須放行
test('confirm 學校與決標日留空仍可歸檔', async () => {
  readAwardNotice.mockResolvedValue({ ...AWARD, 主辦機關: null, 決標日期: null });
  const { app, token, id } = await makeApp();
  await request(app).post(`/api/projects/${id}/kickoff-report/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .field('values', JSON.stringify({ ...KICKOFF, 主辦機關: null, 決標日期: null }))
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(200);
});

// 刻意挑竣工日:它在跨文件比對裡是**提示級**(決標公告的履約起迄明載預估),
// 所以日曆上不存在的 2/30 不會被 hardErrors 攔到,只有值域這層擋得住。
// 換成契約金額之類的硬錯欄位,測試在舊行為下也會綠——那就測不到這層。
test('confirm 日曆上不存在的日期擋下', async () => {
  readAwardNotice.mockResolvedValue(AWARD);
  const { app, token, id } = await makeApp();
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .field('values', JSON.stringify({ ...KICKOFF, 契約規定竣工日: '2026-02-30' }))
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(400);
  expect(res.body.fields).toContain('契約規定竣工日');
});

// 明禮 160 工作天。承辦人已在日曆天欄位填入換算值,不得再以「工作天不推導」
// 把它擋在門外——那會讓這種工程永遠歸不了檔。
// 光看「有沒有歸檔成功」測不到這件事:工作天在舊行為下是 missing,而 missing
// 本來就不擋歸檔,兩種行為都會回 200。要驗的是這一格真的被驗算過(match)。
test('confirm 工作天案例經人工換算後照日曆天驗算', async () => {
  readAwardNotice.mockResolvedValue(AWARD);
  const { app, token, id } = await makeApp();
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .field('values', JSON.stringify({ ...KICKOFF, 契約工期: { 天數: 150, 基準: '工作天' } }))
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(200);
  expect(res.body.rows.find((r) => r.欄位 === '契約工期').狀態).toBe('match');
});

// 重傳修正版是常態(OCR 讀錯、上傳到錯的檔)。累積多份的話,下游要靠
// 「哪一份才算數」的隱含規則(目前是 id 最大),承辦人在附件清單看到兩份
// 開工報告表也分不出哪份有效。
test('confirm 重複歸檔時只保留最新一份', async () => {
  readAwardNotice.mockResolvedValue(AWARD);
  const { app, token, id } = await makeApp();
  const post = (name) => request(app).post(`/api/projects/${id}/kickoff-report/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .field('values', JSON.stringify(KICKOFF))
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), name).expect(200);
  await post('舊版.pdf');
  await post('修正版.pdf');
  const { rows } = await db.query(
    `SELECT original_name FROM project_attachments WHERE project_id = $1 AND kind = 'kickoff_report'`,
    [id]);
  expect(rows.map((r) => r.original_name)).toEqual(['修正版.pdf']);
});

// 覆蓋只針對開工報告表:決標公告是建案依據,不該被開工報告表流程動到
test('confirm 覆蓋不影響決標公告附件', async () => {
  readAwardNotice.mockResolvedValue(AWARD);
  const { app, token, id } = await makeApp();
  await request(app).post(`/api/projects/${id}/kickoff-report/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .field('values', JSON.stringify(KICKOFF))
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(200);
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM project_attachments WHERE project_id = $1 AND kind = 'award_notice'`,
    [id]);
  expect(rows[0].n).toBe(1);
});

// 提示級規則若不回傳,等於沒做:承辦人看不到就不會去確認。但也不能擋——
// 決標日本身可空、補辦決標也存在,判硬錯會擋住合法文件。
test('confirm 決標日晚於開工日仍歸檔,但回提示', async () => {
  readAwardNotice.mockResolvedValue({ ...AWARD, 決標日期: '115/03/19' });
  const { app, token, id } = await makeApp();
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .field('values', JSON.stringify({ ...KICKOFF, 決標日期: '2026-03-19' }))
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(200);
  expect(res.body.warnings.map((w) => w.欄位)).toEqual(['決標日']);
});

// 提示級不得阻擋:古坑平移 10 天是正常的
test('只有提示級差異時仍可歸檔', async () => {
  readAwardNotice.mockResolvedValue({ ...AWARD, 履約起迄: { 起: '115/03/08', 迄: '115/08/04' } });
  const { app, token, id } = await makeApp();
  await request(app).post(`/api/projects/${id}/kickoff-report/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .field('values', JSON.stringify(KICKOFF))
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(200);
});

// values 是前端送來的 JSON 字串,壞掉不得變成 500
test('values 非合法 JSON 回 400', async () => {
  const { app, token, id } = await makeApp();
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .field('values', '{壞掉')
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(400);
  expect(res.body.error).toMatch(/確認值/);
});

// 2026-08-05 補強:歸檔成功卻不寫工程主檔,承辦人核對完九欄仍卡在下一關
// (施工日誌要求 start_date 非空)。規則與決標公告的 seed 同一條鐵則:只補空缺。
describe('confirm 歸檔後補寫工程主檔(只補空缺)', () => {
  test('主檔諸欄皆空時,歸檔後都被補上且值正確', async () => {
    readAwardNotice.mockResolvedValue(AWARD);
    const { app, token, id } = await makeApp();
    const res = await request(app).post(`/api/projects/${id}/kickoff-report/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .field('values', JSON.stringify(KICKOFF))
      .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(200);
    // 回應的 updated 要與實際寫入的欄位一致
    expect(res.body.updated.sort()).toEqual(
      ['award_amount', 'contract_completion_date', 'duration_basis', 'duration_days',
        'project_no', 'start_date'].sort());
    const { rows } = await db.query(
      `SELECT project_no, award_amount, start_date, contract_completion_date,
              duration_days, duration_basis
         FROM projects WHERE id = $1`, [id]);
    expect(rows[0].project_no).toBe('1150113');
    expect(Number(rows[0].award_amount)).toBe(3122168);
    expect(rows[0].start_date.toISOString().slice(0, 10)).toBe('2026-03-18');
    expect(rows[0].contract_completion_date.toISOString().slice(0, 10)).toBe('2026-08-14');
    // 契約工期是**開工報告表獨有**的欄位(決標公告不含),不回寫的話承辦人要在
    // 「監造報表基本資料」把剛核對完的同一個數字再打一次
    expect(rows[0].duration_days).toBe(150);
    expect(rows[0].duration_basis).toBe('日曆天');
  });

  // 天數與基準是分開的兩欄:OCR 判不出基準時(24 份有 17 份兩個詞同時出現)
  // 天數仍要存得住,不可因為基準是 null 就整組不寫。
  test('基準判不出來時,天數照樣回寫', async () => {
    const { id } = await makeApp();
    const before = { project_no: null, award_amount: null, start_date: null,
      contract_completion_date: null, duration_days: null, duration_basis: null };
    const updated = await fillProjectMasterFromKickoff(id, {
      契約工期: { 天數: 90, 基準: null },
    }, before);
    expect(updated).toEqual(['duration_days']);
    const { rows } = await db.query(
      'SELECT duration_days, duration_basis FROM projects WHERE id = $1', [id]);
    expect(rows[0].duration_days).toBe(90);
    expect(rows[0].duration_basis).toBeNull();
  });

  // 讀壞的工期(kickoff-values 對 '_J50_'、'一』一一' 一律回 null)不可寫成 0 或 NaN
  test('工期天數不是有限正數時存 null,不寫進主檔', async () => {
    const { id } = await makeApp();
    const before = { project_no: null, award_amount: null, start_date: null,
      contract_completion_date: null, duration_days: null, duration_basis: null };
    const updated = await fillProjectMasterFromKickoff(id, {
      契約工期: { 天數: null, 基準: '日曆天' },
    }, before);
    expect(updated).toEqual(['duration_basis']);
    const { rows } = await db.query('SELECT duration_days FROM projects WHERE id = $1', [id]);
    expect(rows[0].duration_days).toBeNull();
  });

  // 承辦人可能已透過「寫入監造報表」填過 award_amount——那個值權威性高於開工
  // 報告表這份快照,不得被覆蓋。其餘仍是空的三欄要照樣補上。
  test('主檔已有值時不被覆蓋,其餘空欄仍被補,updated 不列已有值的欄位', async () => {
    readAwardNotice.mockResolvedValue(AWARD);
    const { app, token, id } = await makeApp();
    await db.query('UPDATE projects SET award_amount = $1 WHERE id = $2', [9999999, id]);
    const res = await request(app).post(`/api/projects/${id}/kickoff-report/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .field('values', JSON.stringify(KICKOFF))
      .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(200);
    expect(res.body.updated).not.toContain('award_amount');
    expect(res.body.updated.sort()).toEqual(
      ['contract_completion_date', 'duration_basis', 'duration_days',
        'project_no', 'start_date'].sort());
    const { rows } = await db.query('SELECT award_amount FROM projects WHERE id = $1', [id]);
    expect(Number(rows[0].award_amount)).toBe(9999999);
  });
});

// confirm 走不到這個情境(契約編號/金額/開工/竣工日皆是 validateValues 的
// REQUIRED,驗證通過時四欄必有值)——但 fillProjectMasterFromKickoff 本身要對
// 「值讀不到」保持防禦,COALESCE(既有值, null) 不得把主檔既有值清成 null。
test('fillProjectMasterFromKickoff:candidate 為 null 時不清空主檔既有值', async () => {
  const { id } = await makeApp();
  await db.query(`UPDATE projects SET project_no = '既有編號', award_amount = 500 WHERE id = $1`, [id]);
  const before = { project_no: '既有編號', award_amount: 500, start_date: null, contract_completion_date: null };
  const updated = await fillProjectMasterFromKickoff(id, {
    契約編號: null, 契約金額: null, 契約規定開工日: '2026-03-18', 契約規定竣工日: null,
  }, before);
  expect(updated).toEqual(['start_date']);
  const { rows } = await db.query(
    `SELECT project_no, award_amount, start_date, contract_completion_date
       FROM projects WHERE id = $1`, [id]);
  expect(rows[0].project_no).toBe('既有編號');
  expect(Number(rows[0].award_amount)).toBe(500);
  expect(rows[0].start_date.toISOString().slice(0, 10)).toBe('2026-03-18');
  expect(rows[0].contract_completion_date).toBeNull();
});
