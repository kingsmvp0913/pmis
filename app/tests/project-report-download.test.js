process.env.JWT_SECRET = 'test-secret';

const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-repdl-'));
// ⚠️ 必須在 require 之前:report-workbook 在 module load 時就把資料根算好,
// 晚一步設定會把報表寫進正式 data/。
process.env.PMIS_DATA_DIR = TMP;

const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const db = require('../server/db');
const { workbookPath } = require('../server/report-workbook');
const { registerRoutes: registerAuthRoutes } = require('../server/auth');
const { registerRoutes: registerProjectRoutes } = require('../server/project-routes');

async function makeApp(name = '竹崎圍牆工程') {
  const mem = newDb();
  db._setPoolForTesting(new (mem.adapters.createPg()).Pool());
  await db.migrate();
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  registerProjectRoutes(app);
  const setup = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password1', display_name: '管理員' });
  const { rows } = await db.query(
    'INSERT INTO projects (name) VALUES ($1) RETURNING id', [name]);
  return { app, token: setup.body.token, id: rows[0].id };
}

// 把常駐 .xlsm 造出來(內容不重要,測的是取檔與命名,不是 Excel)
function putWorkbook(projectId, content = 'xlsm-bytes') {
  const dest = workbookPath(projectId);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
  return dest;
}

// Content-Disposition 的中文檔名只存在於 filename*(header 位元組限 Latin1),
// 只斷言 filename= 的話,實際下載到「????.xlsm」測試照樣綠。
// .xlsm 的 content-type superagent 不認得,預設會把 body 解成 {}。要拿到位元組
// 得自己收 chunk,否則斷言的是 '[object Object]' 而不是檔案內容。
const asBinary = (req) => req.buffer(true).parse((res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

const filenameStar = (res) => {
  const m = /filename\*=UTF-8''([^;]+)/i.exec(res.headers['content-disposition'] || '');
  return m ? decodeURIComponent(m[1]) : null;
};

afterEach(() => { db._setPoolForTesting(null); });
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

test('未帶 token 回 401', async () => {
  const { app, id } = await makeApp();
  await request(app).get(`/api/projects/${id}/report/download`).expect(401);
});

test('工程不存在回 404', async () => {
  const { app, token } = await makeApp();
  const res = await request(app).get('/api/projects/99999/report/download')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(404);
});

test('報表尚未建立回 409,並指出該先做什麼', async () => {
  const { app, token, id } = await makeApp();
  const res = await request(app).get(`/api/projects/${id}/report/download`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/工程基本資料/);
});

// 這條是本檔的重點:下載走 workbookPath 而非 ensureWorkbook。用了 ensureWorkbook
// 的話,按一下下載就會由公版範本複製出一份空報表——承辦人拿到空表卻以為 pipeline
// 跑過了,比 409 更糟,而且功能面完全看不出差別(兩種寫法都回 200)。
test('報表尚未建立時,下載不得把檔案生出來', async () => {
  const { app, token, id } = await makeApp();
  await request(app).get(`/api/projects/${id}/report/download`)
    .set('Authorization', `Bearer ${token}`);
  expect(fs.existsSync(workbookPath(id))).toBe(false);
});

test('報表存在時回 200,內容與工程名檔名正確', async () => {
  const { app, token, id } = await makeApp();
  putWorkbook(id, 'hello-workbook');
  const res = await asBinary(request(app).get(`/api/projects/${id}/report/download`)
    .set('Authorization', `Bearer ${token}`));
  expect(res.status).toBe(200);
  expect(res.body.toString()).toBe('hello-workbook');
  expect(filenameStar(res)).toBe('竹崎圍牆工程_監造報表.xlsm');
});

// 工程名是承辦人自由輸入的,`/` `:` 這類字元進了檔名會讓 Content-Disposition
// 被瀏覽器解成路徑,或整個下載失敗。
test('工程名含檔名非法字元時清掉再當檔名', async () => {
  const { app, token, id } = await makeApp('竹崎/圍牆:改善"工程"');
  putWorkbook(id);
  const res = await request(app).get(`/api/projects/${id}/report/download`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(filenameStar(res)).toBe('竹崎圍牆改善工程_監造報表.xlsm');
});
