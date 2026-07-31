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

test('未帶 token 一律 401', async () => {
  const { app, projectId } = await makeApp();
  await request(app).get(`/api/projects/${projectId}/attachments`).expect(401);
});
