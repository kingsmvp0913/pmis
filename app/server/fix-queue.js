/**
 * fix-queue.js — 辨識問題自動修正佇列(私人 GitHub repo)
 *
 *   submitBatch(批號, entries, meta)  問題包一次 commit 推進 待修正/<批號>/,並寫 狀態/<批號>.json = 排隊中
 *   readStatuses()                    讀 狀態/ 底下每一批的狀態(5 分鐘快取),附「本機是否已含修正」
 *
 * 設定:`PMIS_QUEUE_REPO`(帳號/repo)與 `PMIS_GITHUB_TOKEN`,由 start.js 從 data/config.json 帶入。
 * 沒設定時 enabled() 回 false,前端只留原本的「下載辨識問題」。
 *
 * 處理端(佇列 repo 的 GitHub Actions)見 docs/自動修正流程.md。狀態檔只放文字摘要,
 * 原始檔處理完就從佇列刪掉。
 */
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const API = 'https://api.github.com';
const ROOT = path.resolve(__dirname, '..', '..');
const CACHE_MS = 5 * 60 * 1000;
// 處理中太久沒動靜 = Actions 掛了或被取消;一直顯示「處理中」承辦人會乾等。
const STALE_MS = 60 * 60 * 1000;

const deps = {
  fetch: (...args) => fetch(...args),
  // 本機 HEAD 是否已含某 commit:`git merge-base --is-ancestor` 成立回 0
  hasCommit: (sha) => new Promise((resolve) => {
    execFile('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: ROOT, windowsHide: true },
      (err) => resolve(err ? (err.code === 1 ? false : null) : true));
  }),
  now: () => Date.now(),
};

const repo = () => process.env.PMIS_QUEUE_REPO || '';
const token = () => process.env.PMIS_GITHUB_TOKEN || '';
const enabled = () => /^[\w.-]+\/[\w.-]+$/.test(repo()) && !!token();

async function gh(method, url, body) {
  const res = await deps.fetch(`${API}/repos/${repo()}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(`GitHub ${method} ${url} → ${res.status} ${(data && data.message) || ''}`.trim());
    err.status = res.status;
    throw err;
  }
  return data;
}

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const toBuffer = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8'));

/** 同一份原始檔 + 同一份問題清單 = 同一批,重按「送出」不重複建立。 */
function fingerprint(entries) {
  const h = crypto.createHash('sha256');
  for (const name of Object.keys(entries).filter((n) => !n.startsWith('系統資料/')).sort()) {
    h.update(name).update('\0').update(toBuffer(entries[name])).update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * 一次 commit 推多個檔案(Git Data API)。別人同時推(另一台電腦送件、Actions 寫狀態)
 * 時 ref 更新會被拒(非快轉),重抓 main 再試。
 */
async function commitFiles(files, message) {
  for (let attempt = 0; ; attempt++) {
    const ref = await gh('GET', '/git/ref/heads/main');
    const base = await gh('GET', `/git/commits/${ref.object.sha}`);
    const tree = [];
    for (const [p, content] of Object.entries(files)) {
      const blob = await gh('POST', '/git/blobs', { content: toBuffer(content).toString('base64'), encoding: 'base64' });
      tree.push({ path: p, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const newTree = await gh('POST', '/git/trees', { base_tree: base.tree.sha, tree });
    const commit = await gh('POST', '/git/commits', { message, tree: newTree.sha, parents: [ref.object.sha] });
    try {
      await gh('PATCH', '/git/refs/heads/main', { sha: commit.sha });
      return commit.sha;
    } catch (err) {
      if (err.status !== 422 || attempt >= 2) throw err;
    }
  }
}

async function listStatusFiles() {
  try {
    const list = await gh('GET', `/contents/${enc('狀態')}?ref=main`);
    return (Array.isArray(list) ? list : []).filter((f) => f.type === 'file' && f.name.endsWith('.json'));
  } catch (err) {
    if (err.status === 404) return [];   // 還沒有任何一批
    throw err;
  }
}

async function readStatusFile(file) {
  const data = await gh('GET', `/contents/${enc(file.path)}?ref=main`);
  return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
}

/**
 * @param {string} batch   本機批號(YYYYMMDD-NNNN);流水號是各台電腦自己編的,
 *                         佇列裡另加指紋才不會兩台撞號
 * @param {object} entries 相對路徑 → 內容(與下載 ZIP 同一份)
 * @param {object} meta    { 工程, 工程id }
 */
async function submitBatch(batch, entries, meta = {}) {
  const 指紋 = fingerprint(entries);
  for (const f of await listStatusFiles()) {
    const s = await readStatusFile(f).catch(() => null);
    if (s && s.指紋 === 指紋 && s.狀態 !== '沒修成') return { 批號: s.批號, 重複: true };
  }
  const 批號 = `${batch}-${指紋.slice(0, 6)}`;
  const files = {};
  for (const [name, content] of Object.entries(entries)) files[`待修正/${批號}/${name}`] = content;
  files[`狀態/${批號}.json`] = JSON.stringify({
    批號, 指紋, 工程: meta.工程 || '', 工程id: meta.工程id == null ? null : meta.工程id,
    狀態: '排隊中', 更新時間: new Date(deps.now()).toISOString(), 摘要: [], 需要決定: [], commit: null,
  }, null, 2);
  await commitFiles(files, `送出辨識問題 ${批號}`);
  cache = null;
  return { 批號, 重複: false };
}

let cache = null;

async function readStatuses({ force = false } = {}) {
  if (!enabled()) return { enabled: false, items: [] };
  if (!force && cache && deps.now() - cache.at < CACHE_MS) return cache.data;
  const items = [];
  for (const f of await listStatusFiles()) {
    const s = await readStatusFile(f).catch(() => null);
    if (!s || !s.批號) continue;
    let 狀態 = s.狀態;
    if (狀態 === '處理中' && deps.now() - Date.parse(s.更新時間) > STALE_MS) 狀態 = '處理逾時';
    // 已修好 / 需要決定 的批次帶 commit:本機重開拉到它之後,標籤就不再提醒重啟
    const 已套用 = s.commit ? await deps.hasCommit(s.commit) : null;
    items.push({ ...s, 狀態, 已套用 });
  }
  items.sort((a, b) => String(b.更新時間).localeCompare(String(a.更新時間)));
  const data = { enabled: true, items, 查詢時間: new Date(deps.now()).toISOString() };
  cache = { at: deps.now(), data };
  return data;
}

function registerRoutes(app) {
  const { verifyToken } = require('./auth');
  // 前端每 5 分鐘問一次;真正打 GitHub 的頻率由上面的快取壓在 5 分鐘一次。
  app.get('/api/auto-fix/status', verifyToken, async (req, res) => {
    try {
      res.json(await readStatuses());
    } catch (err) {
      console.error('[fix-queue] 讀取自動修正狀態失敗:', err.message);
      res.json({ enabled: true, items: [], error: '暫時查不到自動修正狀態' });
    }
  });
}

module.exports = {
  registerRoutes, enabled, submitBatch, readStatuses, fingerprint,
  _deps: deps, _resetCache: () => { cache = null; },
};
