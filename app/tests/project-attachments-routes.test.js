process.env.JWT_SECRET = 'test-secret';

const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-att-'));
process.env.PMIS_DATA_DIR = TMP;

const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const db = require('../server/db');
const { registerRoutes: registerAuthRoutes } = require('../server/auth');
const {
  registerRoutes: registerAttachmentRoutes, saveAttachment,
} = require('../server/project-attachments-routes');

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

async function makeApp() {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  db._setPoolForTesting(new pg.Pool());
  await db.migrate();
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  registerAttachmentRoutes(app);
  const setup = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password1', display_name: '管理員' });
  const { rows } = await db.query(`INSERT INTO projects (name) VALUES ('測試工程') RETURNING id`);
  return { app, token: setup.body.token, projectId: rows[0].id };
}

// DB 只存相對路徑:存絕對路徑的話,換機器或改 PMIS_DATA_DIR 後全部失效。
test('saveAttachment 落檔於 uploads/proj_<id>/ 且 DB 存相對路徑', async () => {
  const { projectId } = await makeApp();
  const r = await saveAttachment({
    projectId, kind: 'award_notice',
    buffer: Buffer.from('%PDF-1.4 hello'), originalName: '決標公告.pdf', userId: null,
  });
  expect(r.file_path).toMatch(new RegExp(`^uploads/proj_${projectId}/\\d+_決標公告\\.pdf$`));
  expect(fs.existsSync(path.join(TMP, r.file_path))).toBe(true);
});

test('清單回該工程的附件', async () => {
  const { app, token, projectId } = await makeApp();
  await saveAttachment({
    projectId, kind: 'award_notice',
    buffer: Buffer.from('x'), originalName: 'a.pdf', userId: null,
  });
  const res = await request(app).get(`/api/projects/${projectId}/attachments`)
    .set('Authorization', `Bearer ${token}`).expect(200);
  expect(res.body).toHaveLength(1);
  expect(res.body[0].original_name).toBe('a.pdf');
});

// 下載檔名必須還原成原檔名。既有 submission 下載會吐出帶 timestamp 前綴的檔名,
// 是已知瑕疵;新表存了 original_name 就不該重蹈。
test('下載回原檔名而非帶 timestamp 前綴的磁碟檔名', async () => {
  const { app, token, projectId } = await makeApp();
  const r = await saveAttachment({
    projectId, kind: 'award_notice',
    buffer: Buffer.from('%PDF-1.4'), originalName: '決標公告.pdf', userId: null,
  });
  const res = await request(app).get(`/api/attachments/${r.id}/download`)
    .set('Authorization', `Bearer ${token}`).expect(200);
  // Node 的 HTTP header 只能傳 ASCII/Latin1 位元組,不存在能讓用戶端 res.headers 拿回
  // 原始多位元組中文字元的合法傳輸方式(實測 res.download 底層 content-disposition
  // 套件會把非 ASCII 檔名編碼成 RFC 6266 的 filename*=UTF-8''<percent-encoded>,直接用
  // toContain('決標公告.pdf') 比對字面中文字串必敗,與實作對錯無關,是 brief 測試碼本身
  // 對 Node header 傳輸限制的認知落差)。改為解碼 filename* 還原後比對,並確認沒有洩漏
  // 帶時間戳的磁碟檔名——這才是本測試「回原檔名而非磁碟檔名」的真正意圖。
  const cd = res.headers['content-disposition'];
  const match = cd.match(/filename\*=UTF-8''([^;]+)/);
  expect(decodeURIComponent(match[1])).toBe('決標公告.pdf');
  expect(cd).not.toMatch(/\d{10,}_/);
});

// 路徑逃逸:DB 若被寫入 ../../ 的相對路徑,下載端點不得讀到 DATA_DIR 之外。
test('檔案路徑逃逸回 400,不得讀到 DATA_DIR 之外', async () => {
  const { app, token, projectId } = await makeApp();
  const { rows } = await db.query(
    `INSERT INTO project_attachments (project_id, kind, file_path, original_name)
     VALUES ($1, 'award_notice', '../../etc/passwd', 'x') RETURNING id`,
    [projectId]
  );
  await request(app).get(`/api/attachments/${rows[0].id}/download`)
    .set('Authorization', `Bearer ${token}`).expect(400);
});

test('不存在的附件回 404', async () => {
  const { app, token } = await makeApp();
  await request(app).get('/api/attachments/99999/download')
    .set('Authorization', `Bearer ${token}`).expect(404);
});

// 只刪 DB 列會留下磁碟孤兒檔——既有 DELETE /api/projects/:id 就有這個坑,別複製它。
test('刪除連同磁碟檔一起清掉', async () => {
  const { app, token, projectId } = await makeApp();
  const r = await saveAttachment({
    projectId, kind: 'award_notice',
    buffer: Buffer.from('x'), originalName: 'a.pdf', userId: null,
  });
  const abs = path.join(TMP, r.file_path);
  expect(fs.existsSync(abs)).toBe(true);
  await request(app).delete(`/api/attachments/${r.id}`)
    .set('Authorization', `Bearer ${token}`).expect(200);
  expect(fs.existsSync(abs)).toBe(false);
  const { rows } = await db.query('SELECT * FROM project_attachments WHERE id = $1', [r.id]);
  expect(rows).toHaveLength(0);
});

// 開工報告表可以重傳修正版,舊的必須連磁碟檔一起消失:只刪 DB 列會留孤兒檔,
// 只換 DB 列而不刪檔則是同一個坑的另一種寫法(見上一則)。
test('replace 覆蓋同 kind 舊附件並清掉舊磁碟檔', async () => {
  const { projectId } = await makeApp();
  const old = await saveAttachment({
    projectId, kind: 'kickoff_report',
    buffer: Buffer.from('舊'), originalName: '舊版.pdf', userId: null,
  });
  const oldAbs = path.join(TMP, old.file_path);
  const fresh = await saveAttachment({
    projectId, kind: 'kickoff_report',
    buffer: Buffer.from('新'), originalName: '修正版.pdf', userId: null, replace: true,
  });
  expect(fs.existsSync(oldAbs)).toBe(false);
  expect(fs.existsSync(path.join(TMP, fresh.file_path))).toBe(true);
  const { rows } = await db.query(
    `SELECT original_name FROM project_attachments WHERE project_id = $1 AND kind = 'kickoff_report'`,
    [projectId]);
  expect(rows.map((r) => r.original_name)).toEqual(['修正版.pdf']);
});

// 覆蓋範圍必須限縮在同一個 kind:開工報告表重傳不該動到決標公告,
// 那是建案依據,洗掉就再也對不回去了。
test('replace 不動其他 kind 的附件', async () => {
  const { projectId } = await makeApp();
  await saveAttachment({
    projectId, kind: 'award_notice',
    buffer: Buffer.from('公告'), originalName: '決標公告.pdf', userId: null,
  });
  await saveAttachment({
    projectId, kind: 'kickoff_report',
    buffer: Buffer.from('開工'), originalName: 'k.pdf', userId: null, replace: true,
  });
  const { rows } = await db.query(
    `SELECT kind FROM project_attachments WHERE project_id = $1 ORDER BY kind`, [projectId]);
  expect(rows.map((r) => r.kind)).toEqual(['award_notice', 'kickoff_report']);
});

test('未帶 token 一律 401', async () => {
  const { app, projectId } = await makeApp();
  await request(app).get(`/api/projects/${projectId}/attachments`).expect(401);
});

// 為什麼這則重要:Express 4 不會接住 async handler 拋出的 rejection,少了 try/catch
// 就是一個 unhandled rejection,Node 預設會讓「整個 process exit 1」——不是這一個請求
// 失敗而已,是全站掛掉。而清單這支是每次開工程編輯頁 loadAttachments() 都會打的,
// 等於一次 DB 抖動(連線池耗盡、DB 重啟)就足以打掉伺服器。這則測試釘住的是
// 「DB 故障時降級成 500,伺服器還活著」,不是 500 這個數字本身。
// 註:路由模組是以 const { query } = require('./db') 解構取得 function 參考的,
// 對 db.query 做 spy 攔不到;要在底層的 pool 上動手才會真的生效。
test('DB 故障時三支路由都回 500 而非讓 process 崩潰', async () => {
  const { app, token, projectId } = await makeApp();
  const r = await saveAttachment({
    projectId, kind: 'award_notice',
    buffer: Buffer.from('x'), originalName: 'a.pdf', userId: null,
  });
  const spy = jest.spyOn(db.getPool(), 'query');
  const err = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    spy.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));
    const list = await request(app).get(`/api/projects/${projectId}/attachments`)
      .set('Authorization', `Bearer ${token}`).expect(500);
    // 對外只給固定字串;SQL 片段、連線字串不該外洩給前端。
    expect(list.body.error).not.toMatch(/connection terminated/);

    spy.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));
    await request(app).get(`/api/attachments/${r.id}/download`)
      .set('Authorization', `Bearer ${token}`).expect(500);

    spy.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));
    await request(app).delete(`/api/attachments/${r.id}`)
      .set('Authorization', `Bearer ${token}`).expect(500);
  } finally {
    spy.mockRestore();
    err.mockRestore();
  }
});
