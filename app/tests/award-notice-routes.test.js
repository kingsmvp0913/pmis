process.env.JWT_SECRET = 'test-secret';

const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const db = require('../server/db');

jest.mock('../server/award-notice', () => ({ readAwardNotice: jest.fn() }));
const { readAwardNotice } = require('../server/award-notice');
const { registerRoutes: registerAuthRoutes } = require('../server/auth');
const { registerRoutes: registerAwardRoutes } = require('../server/award-notice-routes');

async function makeApp() {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  db._setPoolForTesting(new pg.Pool());
  await db.migrate();
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  registerAwardRoutes(app);
  const setup = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password1', display_name: '管理員' });
  await db.query(`INSERT INTO vendors (name) VALUES ('晉林土木包工業')`);
  return { app, token: setup.body.token };
}

const PARSED = {
  工程名稱: '114年南陽國小北棟教室廁所整修工程',
  主辦機關: '雲林縣北港鎮南陽國民小學',
  承包廠商: '晉林土木包工業',
  契約金額: '3122168',
  工程編號: '1150113',
};

beforeEach(() => jest.clearAllMocks());

test('未帶 token 回 401', async () => {
  const { app } = await makeApp();
  await request(app).post('/api/award-notice/parse').expect(401);
});

test('沒帶檔案回 400', async () => {
  const { app, token } = await makeApp();
  const res = await request(app).post('/api/award-notice/parse')
    .set('Authorization', `Bearer ${token}`).expect(400);
  expect(res.body.error).toMatch(/決標公告/);
});

// 廠商已存在就直接給 id,承辦人不必再按一次建立。
test('廠商已存在時回既有 id', async () => {
  readAwardNotice.mockResolvedValue(PARSED);
  const { app, token } = await makeApp();
  const res = await request(app).post('/api/award-notice/parse')
    .set('Authorization', `Bearer ${token}`)
    .attach('award_notice', Buffer.from('%PDF-1.4'), 'a.pdf')
    .expect(200);
  expect(res.body.parsed.工程編號).toBe('1150113');
  expect(res.body.vendorMatch.id).toEqual(expect.any(Number));
  expect(res.body.vendorMatch.name).toBe('晉林土木包工業');
});

// 學校不存在時 id 必須是 null(而非省略),前端據此決定要不要顯示「建立並綁定」。
// county 先抽好一起回,建立時就不必再算一次,也讓前端能預選下拉。
test('學校不存在時 id 為 null 並附上抽出的縣市', async () => {
  readAwardNotice.mockResolvedValue(PARSED);
  const { app, token } = await makeApp();
  const res = await request(app).post('/api/award-notice/parse')
    .set('Authorization', `Bearer ${token}`)
    .attach('award_notice', Buffer.from('%PDF-1.4'), 'a.pdf')
    .expect(200);
  expect(res.body.schoolMatch).toEqual({
    name: '雲林縣北港鎮南陽國民小學', id: null, county: '雲林縣',
    address: null, contact: { name: null, phone: null },
  });
});

// 聯絡人與地址要跟著 match 一起回,前端才能在「建立並綁定」的同一次請求寫進去,
// 或對既有學校/廠商呼叫 /seed。分兩次請求拿等於讓承辦人多等一趟。
test('聯絡人與地址隨 match 一起回,廠商側的姓名為 null', async () => {
  readAwardNotice.mockResolvedValue({
    ...PARSED,
    機關聯絡人: '楊豐安',
    機關電話: '(05) 7832106 # 204',
    機關地址: '651 雲林縣 北港鎮 光明路59號',
    廠商電話: '(0978) 557892',
    廠商地址: '630 雲林縣 斗南鎮 新興街322號1樓',
  });
  const { app, token } = await makeApp();
  const res = await request(app).post('/api/award-notice/parse')
    .set('Authorization', `Bearer ${token}`)
    .attach('award_notice', Buffer.from('%PDF-1.4'), 'a.pdf')
    .expect(200);
  expect(res.body.schoolMatch.address).toBe('651 雲林縣 北港鎮 光明路59號');
  expect(res.body.schoolMatch.contact).toEqual({ name: '楊豐安', phone: '(05) 7832106 # 204' });
  expect(res.body.vendorMatch.address).toBe('630 雲林縣 斗南鎮 新興街322號1樓');
  // 決標公告沒有廠商聯絡人姓名(28/28),不得為了「補齊」而拿廠商名稱去頂
  expect(res.body.vendorMatch.contact).toEqual({ name: null, phone: '(0978) 557892' });
});

// 掃描件是「這份檔案不能用」,屬 400 且訊息本來就寫給承辦人看;
// 回 500 會讓承辦人以為系統壞了而去找管理員。
test('掃描件回 400 並原樣帶出訊息', async () => {
  const err = new Error('此決標公告為掃描件,無法解析');
  err.code = 'SCANNED_PDF';
  readAwardNotice.mockRejectedValue(err);
  const { app, token } = await makeApp();
  const res = await request(app).post('/api/award-notice/parse')
    .set('Authorization', `Bearer ${token}`)
    .attach('award_notice', Buffer.from('%PDF-1.4'), 'a.pdf')
    .expect(400);
  expect(res.body.error).toMatch(/掃描件/);
});

// 內部細節(檔案路徑、解析器結構)不得外洩給前端。
test('其他解析失敗回 500 且不外洩內部訊息', async () => {
  readAwardNotice.mockRejectedValue(new Error('ENOENT /some/internal/path.pdf'));
  const { app, token } = await makeApp();
  const res = await request(app).post('/api/award-notice/parse')
    .set('Authorization', `Bearer ${token}`)
    .attach('award_notice', Buffer.from('%PDF-1.4'), 'a.pdf')
    .expect(500);
  expect(res.body.error).not.toMatch(/ENOENT|internal/);
});
