/**
 * 啟用碼能寫程式 repo:只准管理員設定。DB 只 mock 角色查詢,activate 本身由 fix-queue.test.js 驗。
 */
process.env.JWT_SECRET = 'test-secret';
jest.mock('../server/db', () => ({ query: jest.fn() }));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { query } = require('../server/db');
const fixQueue = require('../server/fix-queue');

function makeApp() {
  const app = express();
  app.use(express.json());
  fixQueue.registerRoutes(app);
  return app;
}
const bearer = (userId) => `Bearer ${jwt.sign({ userId }, 'test-secret')}`;
afterEach(() => jest.restoreAllMocks());

test('非管理員不能設定啟用碼,activate 根本不會被呼叫', async () => {
  query.mockResolvedValue({ rows: [{ role: 'user' }] });
  const activate = jest.spyOn(fixQueue, 'activate');
  const res = await request(makeApp()).put('/api/auto-fix/activate')
    .set('Authorization', bearer(2)).send({ token: 'github_pat_x' }).expect(403);
  expect(res.body.error).toMatch(/管理員/);
  expect(activate).not.toHaveBeenCalled();
});

test('沒登入回 401', async () => {
  await request(makeApp()).put('/api/auto-fix/activate').send({ token: 'x' }).expect(401);
});

test('管理員貼錯格式時回 400 與原因', async () => {
  query.mockResolvedValue({ rows: [{ role: 'admin' }] });
  const res = await request(makeApp()).put('/api/auto-fix/activate')
    .set('Authorization', bearer(1)).send({ token: 'abc' }).expect(400);
  expect(res.body.error).toMatch(/格式不對/);
});
