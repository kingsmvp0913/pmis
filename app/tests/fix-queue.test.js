/**
 * 自動修正佇列:承辦人按「送出辨識問題」→ 推進私人 GitHub repo;右上角標籤讀 狀態/。
 * 用記憶體裡的假 GitHub(只實作用到的幾支 API),驗證的是會讓承辦人看錯或重送的那幾件事。
 */
const fixQueue = require('../server/fix-queue');

function fakeGitHub() {
  const commits = { c0: { files: {} } };
  let head = 'c0';
  let n = 0;
  const blobs = {};
  const trees = {};
  const gh = { commits, rejectNextRef: 0, calls: [] };
  gh.headFiles = () => commits[head].files;
  gh.commitCount = () => Object.keys(commits).length - 1;
  gh.put = (p, obj) => { commits[head].files[p] = Buffer.from(JSON.stringify(obj)); };
  gh.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(url.replace(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+/, ''));
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    gh.calls.push(`${method} ${u}`);
    const ok = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
    const fail = (status) => ({ ok: false, status, text: async () => JSON.stringify({ message: 'x' }) });
    if (method === 'GET' && u === '/git/ref/heads/main') return ok({ object: { sha: head } });
    if (method === 'GET' && u.startsWith('/git/commits/')) return ok({ tree: { sha: `t-${u.split('/').pop()}` } });
    if (method === 'POST' && u === '/git/blobs') { const sha = `b${++n}`; blobs[sha] = Buffer.from(body.content, 'base64'); return ok({ sha }); }
    if (method === 'POST' && u === '/git/trees') { const sha = `t${++n}`; trees[sha] = body; return ok({ sha }); }
    if (method === 'POST' && u === '/git/commits') {
      const sha = `c${++n}`;
      const files = { ...commits[body.parents[0]].files };
      for (const e of trees[body.tree].tree) files[e.path] = blobs[e.sha];
      commits[sha] = { files, parent: body.parents[0] };
      return ok({ sha });
    }
    if (method === 'PATCH' && u === '/git/refs/heads/main') {
      if (gh.rejectNextRef > 0) { gh.rejectNextRef--; return fail(422); }
      if (commits[body.sha].parent !== head) return fail(422);
      head = body.sha;
      return ok({});
    }
    if (method === 'GET' && u.startsWith('/contents/')) {
      const p = u.slice('/contents/'.length).replace(/\?ref=main$/, '');
      const files = commits[head].files;
      if (files[p]) return ok({ content: files[p].toString('base64') });
      const kids = Object.keys(files).filter((f) => f.startsWith(`${p}/`) && !f.slice(p.length + 1).includes('/'));
      if (!kids.length) return fail(404);
      return ok(kids.map((f) => ({ type: 'file', path: f, name: f.split('/').pop() })));
    }
    throw new Error(`fake GitHub 沒實作:${method} ${u}`);
  };
  return gh;
}

let gh;
let now;
const orig = { ...fixQueue._deps };
beforeEach(() => {
  gh = fakeGitHub();
  now = Date.parse('2026-11-11T10:00:00Z');
  Object.assign(fixQueue._deps, { fetch: gh.fetch, now: () => now, hasCommit: async () => false });
  process.env.PMIS_QUEUE_REPO = 'me/pmis-queue';
  process.env.PMIS_GITHUB_TOKEN = 'tok';
  fixQueue._resetCache();
});
afterAll(() => {
  Object.assign(fixQueue._deps, orig);
  delete process.env.PMIS_QUEUE_REPO;
  delete process.env.PMIS_GITHUB_TOKEN;
});

const entries = (extra = {}) => ({
  '辨識問題列表.csv': '﻿"級別","代碼"\r\n"硬錯","F1"',
  '原始檔案/石龜.pdf': Buffer.from('%PDF-1.4 fake'),
  '系統資料/契約項目.csv': '項次',
  ...extra,
});

test('沒設定佇列 repo 或權杖時不啟用,前端只留下載', async () => {
  delete process.env.PMIS_GITHUB_TOKEN;
  expect(fixQueue.enabled()).toBe(false);
  expect(await fixQueue.readStatuses()).toEqual({ enabled: false, items: [] });
});

test('送出時問題包與「排隊中」狀態在同一個 commit,Actions 一啟動就讀得到兩者', async () => {
  const r = await fixQueue.submitBatch('20261111-0001', entries(), { 工程: '石龜國小跑道', 工程id: 7 });
  expect(r.重複).toBe(false);
  expect(r.批號).toMatch(/^20261111-0001-[0-9a-f]{6}$/);
  expect(gh.commitCount()).toBe(1);
  const files = gh.headFiles();
  expect(files[`待修正/${r.批號}/原始檔案/石龜.pdf`].toString()).toBe('%PDF-1.4 fake');
  expect(files[`待修正/${r.批號}/系統資料/契約項目.csv`].toString()).toBe('項次');
  const status = JSON.parse(files[`狀態/${r.批號}.json`]);
  expect(status).toMatchObject({ 批號: r.批號, 狀態: '排隊中', 工程: '石龜國小跑道', 工程id: 7 });
});

// 兩台電腦的流水號各自編:同一天都會有 20261111-0001,不加指紋就互相覆蓋
test('不同內容即使本機批號相同也不會撞名', async () => {
  const a = await fixQueue.submitBatch('20261111-0001', entries());
  const b = await fixQueue.submitBatch('20261111-0001', entries({ '辨識問題列表.csv': '"硬錯","B2"' }));
  expect(a.批號).not.toBe(b.批號);
});

test('同一批重按送出不會再建一批(Actions 不會把同一件事修兩次)', async () => {
  const a = await fixQueue.submitBatch('20261111-0001', entries());
  // 系統資料每次匯出都可能多一筆已寫入日誌,不算「不同的問題」
  const b = await fixQueue.submitBatch('20261111-0002', entries({ '系統資料/契約項目.csv': '項次,改' }));
  expect(b).toEqual({ 批號: a.批號, 重複: true });
  expect(gh.commitCount()).toBe(1);
});

test('上次沒修成的同一批可以重送', async () => {
  const a = await fixQueue.submitBatch('20261111-0001', entries());
  gh.put(`狀態/${a.批號}.json`, { ...JSON.parse(gh.headFiles()[`狀態/${a.批號}.json`]), 狀態: '沒修成' });
  const b = await fixQueue.submitBatch('20261112-0001', entries());
  expect(b.重複).toBe(false);
});

test('別人同時推進佇列(ref 被拒)時重抓 main 再試,不讓承辦人看到失敗', async () => {
  gh.rejectNextRef = 1;
  const r = await fixQueue.submitBatch('20261111-0001', entries());
  expect(gh.headFiles()[`狀態/${r.批號}.json`]).toBeDefined();
});

describe('readStatuses', () => {
  const put = (批號, s) => gh.put(`狀態/${批號}.json`, { 批號, 摘要: [], 需要決定: [], commit: null, ...s });

  test('處理中超過 1 小時沒更新改顯示「處理逾時」,不讓承辦人一直乾等', async () => {
    put('A', { 狀態: '處理中', 更新時間: '2026-11-11T08:30:00Z' });
    put('B', { 狀態: '處理中', 更新時間: '2026-11-11T09:30:00Z' });
    const { items } = await fixQueue.readStatuses();
    expect(Object.fromEntries(items.map((i) => [i.批號, i.狀態]))).toEqual({ A: '處理逾時', B: '處理中' });
  });

  test('已修好的批次標出本機是否已含那個 commit,重開更新後標籤才收掉', async () => {
    put('A', { 狀態: '已修好', 更新時間: '2026-11-11T09:00:00Z', commit: 'abc' });
    put('B', { 狀態: '已修好', 更新時間: '2026-11-11T09:10:00Z', commit: 'def' });
    fixQueue._deps.hasCommit = async (sha) => sha === 'abc';
    const { items } = await fixQueue.readStatuses();
    expect(Object.fromEntries(items.map((i) => [i.批號, i.已套用]))).toEqual({ A: true, B: false });
  });

  test('5 分鐘內重複查詢不再打 GitHub', async () => {
    put('A', { 狀態: '排隊中', 更新時間: '2026-11-11T09:00:00Z' });
    await fixQueue.readStatuses();
    const calls = gh.calls.length;
    now += 4 * 60 * 1000;
    await fixQueue.readStatuses();
    expect(gh.calls.length).toBe(calls);
    now += 2 * 60 * 1000;
    await fixQueue.readStatuses();
    expect(gh.calls.length).toBeGreaterThan(calls);
  });

  test('佇列還沒有任何一批時回空清單,不是錯誤', async () => {
    expect(await fixQueue.readStatuses()).toMatchObject({ enabled: true, items: [] });
  });
});
