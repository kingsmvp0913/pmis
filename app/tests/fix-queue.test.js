/**
 * 自動修正佇列:承辦人按「送出辨識問題」→ 推進私人 GitHub repo;右上角標籤讀 狀態/。
 * 用記憶體裡的假 GitHub(只實作用到的幾支 API),驗證的是會讓承辦人看錯或重送的那幾件事。
 */
const fixQueue = require('../server/fix-queue');

function fakeGitHub() {
  const commits = { c0: { files: {} } };
  let head = null;   // 佇列分支一開始不存在,第一次送件才建
  let n = 0;
  const blobs = {};
  const trees = {};
  const gh = { commits, rejectNextRef: 0, calls: [] };
  gh.headFiles = () => commits[head].files;
  gh.dispatches = 0;
  gh.failDispatch = false;
  gh.repoInfo = { private: true, permissions: { push: true } };
  gh.commitCount = () => Object.keys(commits).length - 1;
  gh.put = (p, obj) => {
    if (!head) { head = 'c0'; }
    commits[head].files[p] = Buffer.from(JSON.stringify(obj));
  };
  gh.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(url.replace(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+/, ''));
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    gh.calls.push(`${method} ${u}`);
    const ok = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
    const fail = (status) => ({ ok: false, status, text: async () => JSON.stringify({ message: 'x' }) });
    if (method === 'GET' && u === '') {
      return opts.headers.Authorization === 'Bearer bad' ? fail(401) : ok(gh.repoInfo);
    }
    if (method === 'POST' && u === '/dispatches') {
      if (gh.failDispatch) return fail(403);
      gh.dispatches++;
      return { ok: true, status: 204, text: async () => '' };
    }
    if (method === 'GET' && u === '/git/ref/heads/fix-queue') return head ? ok({ object: { sha: head } }) : fail(404);
    if (method === 'POST' && u === '/git/refs') {
      if (head) return fail(422);
      head = body.sha;
      return ok({});
    }
    if (method === 'GET' && u.startsWith('/git/commits/')) return ok({ tree: { sha: `t-${u.split('/').pop()}` } });
    if (method === 'POST' && u === '/git/blobs') { const sha = `b${++n}`; blobs[sha] = Buffer.from(body.content, 'base64'); return ok({ sha }); }
    if (method === 'POST' && u === '/git/trees') { const sha = `t${++n}`; trees[sha] = body; return ok({ sha }); }
    if (method === 'POST' && u === '/git/commits') {
      const sha = `c${++n}`;
      const files = body.parents.length ? { ...commits[body.parents[0]].files } : {};
      for (const e of trees[body.tree].tree) files[e.path] = blobs[e.sha];
      commits[sha] = { files, parent: body.parents[0] || null };
      return ok({ sha });
    }
    if (method === 'PATCH' && u === '/git/refs/heads/fix-queue') {
      if (gh.rejectNextRef > 0) { gh.rejectNextRef--; return fail(422); }
      if (commits[body.sha].parent !== head) return fail(422);
      head = body.sha;
      return ok({});
    }
    if (method === 'GET' && u.startsWith('/contents/')) {
      const p = u.slice('/contents/'.length).replace(/\?ref=fix-queue$/, '');
      if (!head) return fail(404);
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
  process.env.PMIS_QUEUE_REPO = 'me/pmis';
  process.env.PMIS_GITHUB_TOKEN = 'tok';
  delete process.env.PMIS_INSTALL_ID;   // activate 會設它;別讓前一支測試的值漏到下一支
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
  // 還沒貼啟用碼但找得到 repo → 前端會跳啟用視窗
  expect(await fixQueue.readStatuses()).toEqual({ enabled: false, 可啟用: true, items: [] });
  delete process.env.PMIS_QUEUE_REPO;
  fixQueue._deps.originUrl = () => '';
  fixQueue._resetCache();
  // 直接下載 ZIP、沒有 git 的那種:跳視窗也啟用不了,不跳
  expect((await fixQueue.readStatuses()).可啟用).toBe(false);
  fixQueue._deps.originUrl = () => 'https://github.com/me/pmis.git';
  fixQueue._resetCache();
  expect((await fixQueue.readStatuses()).可啟用).toBe(true);
});

test('送出時問題包與「排隊中」狀態在同一個 commit,Actions 一啟動就讀得到兩者', async () => {
  const r = await fixQueue.submitBatch('20261111-0001', entries(), { 工程: '石龜國小跑道', 工程id: 7 });
  expect(r.重複).toBe(false);
  // 推到佇列分支不會觸發 main 上的 workflow,要另外叫醒
  expect(r.已通知).toBe(true);
  expect(gh.dispatches).toBe(1);
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
  expect(b).toMatchObject({ 批號: a.批號, 重複: true });
  expect(gh.commitCount()).toBe(1);
});

// 通知沒送到或那一輪掛了:重按送出要能再叫醒,不然這批永遠卡在排隊
test('同一批還在排隊/處理中時重按送出,會再叫醒一次 workflow', async () => {
  await fixQueue.submitBatch('20261111-0001', entries());
  const r = await fixQueue.submitBatch('20261111-0002', entries());
  expect(r).toMatchObject({ 重複: true, 已通知: true });
  expect(gh.dispatches).toBe(2);
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

test('佇列分支還不存在時,第一次送件建一個沒有歷史的分支', async () => {
  const r = await fixQueue.submitBatch('20261111-0001', entries());
  expect(Object.keys(gh.headFiles()).every((f) => f.startsWith('待修正/') || f.startsWith('狀態/'))).toBe(true);
  expect(gh.headFiles()[`狀態/${r.批號}.json`]).toBeDefined();
});

test('叫醒 workflow 失敗不算送件失敗(問題包已在佇列,下次送件會一起處理)', async () => {
  gh.failDispatch = true;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  const r = await fixQueue.submitBatch('20261111-0001', entries());
  expect(r).toMatchObject({ 重複: false, 已通知: false });
  console.warn.mockRestore();
});

// 佇列分支在程式 repo 裡:改私人之前先貼啟用碼是必經的一段,這段時間不能送出施工日誌
test('repo 還公開時拒絕送出,也不跳啟用視窗', async () => {
  gh.repoInfo = { private: false, permissions: { push: true } };
  await expect(fixQueue.submitBatch('20261111-0001', entries())).rejects.toThrow(/公開/);
  expect(gh.commitCount()).toBe(0);
  expect(await fixQueue.readStatuses()).toEqual({ enabled: false, 已啟用: true, 可啟用: false, items: [] });
});

describe('activate', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  let dir;
  let synced;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-activate-'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ JWT_SECRET: 'keep' }));
    fixQueue._deps.configPath = () => path.join(dir, 'config.json');
    synced = null;
    fixQueue._deps.syncGitAuth = (t) => { synced = t; };
    delete process.env.PMIS_GITHUB_TOKEN;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const TOKEN = 'github_pat_' + 'A'.repeat(30);

  test('權杖驗過可寫才存進 config(保留其他設定),並立即生效、同步 git pull 憑證', async () => {
    expect(await fixQueue.activate(` ${TOKEN} `)).toEqual({ enabled: true, repo: 'me/pmis' });
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    expect(cfg).toEqual({ JWT_SECRET: 'keep', GITHUB_TOKEN: TOKEN, INSTALL_ID: expect.stringMatching(/^[0-9a-f]{16}$/) });
    // 安裝代號只產生一次:重新啟用(換權杖)不能換掉,否則看不到自己先前送的批次
    const id = cfg.INSTALL_ID;
    await fixQueue.activate(TOKEN);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).INSTALL_ID).toBe(id);
    expect(process.env.PMIS_GITHUB_TOKEN).toBe(TOKEN);
    expect(synced).toBe(TOKEN);
    expect(fixQueue.enabled()).toBe(true);
  });

  test.each([
    ['貼不完整', 'github_pat_abc', /格式不對/],
    ['過期或無效', 'ghp_' + 'b'.repeat(30), null],
  ])('%s → 不存、講清楚原因', async (_, tok, re) => {
    if (!re) {
      // fake 只把 Bearer bad 當無效;換成 bad 走 401
      fixQueue._deps.fetch = (url, o) => gh.fetch(url, { ...o, headers: { ...o.headers, Authorization: 'Bearer bad' } });
    }
    await expect(fixQueue.activate(tok)).rejects.toThrow(re || /無效或已過期/);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).GITHUB_TOKEN).toBeUndefined();
    expect(synced).toBeNull();
  });

  test('權杖只有讀取權限 → 擋下,提醒 Contents 要選 Read and write', async () => {
    gh.repoInfo = { permissions: { push: false } };
    await expect(fixQueue.activate(TOKEN)).rejects.toThrow(/Read and write/);
  });
});

describe('readStatuses', () => {
  const put = (批號, s) => gh.put(`狀態/${批號}.json`, { 批號, 來源: '', 摘要: [], 需要決定: [], commit: null, ...s });

  // 狀態檔所有電腦共用:看得到別校的工程名稱,也處理不了它的「需要決定」
  test('只顯示這台電腦送的批次', async () => {
    process.env.PMIS_INSTALL_ID = 'mine';
    put('A', { 來源: 'mine', 狀態: '排隊中', 更新時間: '2026-11-11T09:50:00Z' });
    put('B', { 來源: 'other', 狀態: '需要決定', 更新時間: '2026-11-11T09:50:00Z' });
    const { items } = await fixQueue.readStatuses();
    expect(items.map((i) => i.批號)).toEqual(['A']);
    delete process.env.PMIS_INSTALL_ID;
  });

  test('送件時帶上這台的安裝代號', async () => {
    process.env.PMIS_INSTALL_ID = 'mine';
    const r = await fixQueue.submitBatch('20261111-0001', entries());
    expect(JSON.parse(gh.headFiles()[`狀態/${r.批號}.json`]).來源).toBe('mine');
    delete process.env.PMIS_INSTALL_ID;
  });

  test('排隊中超過 1 小時(通知沒送到)也顯示處理逾時;正常處理中 2 小時不算逾時', async () => {
    put('Q', { 狀態: '排隊中', 更新時間: '2026-11-11T08:30:00Z' });
    put('P', { 狀態: '處理中', 更新時間: '2026-11-11T08:00:00Z' });
    const { items } = await fixQueue.readStatuses();
    expect(Object.fromEntries(items.map((i) => [i.批號, i.狀態]))).toEqual({ Q: '處理逾時', P: '處理中' });
  });

  test('處理中超過 5 小時沒更新改顯示「處理逾時」,不讓承辦人一直乾等', async () => {
    put('A', { 狀態: '處理中', 更新時間: '2026-11-11T04:30:00Z' });
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
