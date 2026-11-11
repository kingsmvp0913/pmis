/**
 * fix-queue.js — 辨識問題自動修正佇列(程式 repo 的 fix-queue 分支,repo 為私人)
 *
 *   submitBatch(批號, entries, meta)  問題包一次 commit 推進 待修正/<批號>/,寫 狀態/<批號>.json = 排隊中,
 *                                     再發 repository_dispatch 叫醒 main 上的 workflow
 *   readStatuses()                    讀 狀態/ 底下每一批的狀態(5 分鐘快取),附「本機是否已含修正」
 *   activate(權杖)                    驗證權杖可寫這個 repo → 存進 data/config.json → 立即生效
 *
 * 佇列放在程式 repo 的分支(不另開 repo):workflow 才能用 GitHub 內建的權杖讀寫程式,
 * 使用者那邊只要一組權杖。推到非預設分支不會觸發 main 上的 workflow(GitHub 會去那個分支找
 * workflow,而佇列分支只有資料),所以送完再發 repository_dispatch。
 *
 * 設定:`PMIS_GITHUB_TOKEN`(承辦人在啟用視窗貼一次,存 data/config.json 的 GITHUB_TOKEN);
 * repo 預設取本機 git origin,可用 `PMIS_QUEUE_REPO` 覆寫。沒權杖時 enabled() 回 false。
 * 處理端見 docs/自動修正流程.md。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');

const API = 'https://api.github.com';
const ROOT = path.resolve(__dirname, '..', '..');
const BRANCH = 'fix-queue';
const CACHE_MS = 5 * 60 * 1000;
// 太久沒動靜 = Actions 掛了、被取消,或叫醒的通知沒送到;一直顯示原狀態承辦人會乾等。
// 處理中要涵蓋一整輪(Claude 最多 100 分鐘 + 把關兩台主機 + 排隊);排隊中正常幾分鐘內就會開始。
const STALE_MS = { 處理中: 5 * 60 * 60 * 1000, 排隊中: 60 * 60 * 1000 };
// 狀態檔是所有電腦共用的:每台用自己的安裝代號只看自己送的(start.js 從 config 帶入,啟用時產生)
const installId = () => process.env.PMIS_INSTALL_ID || '';

const deps = {
  fetch: (...args) => fetch(...args),
  // 本機 HEAD 是否已含某 commit:`git merge-base --is-ancestor` 成立回 0
  hasCommit: (sha) => new Promise((resolve) => {
    execFile('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: ROOT, windowsHide: true },
      (err) => resolve(err ? (err.code === 1 ? false : null) : true));
  }),
  originUrl: () => {
    try {
      return execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: ROOT, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return '';
    }
  },
  syncGitAuth: (t) => require('../scripts/git-auth').syncGitAuth(t, ROOT),
  configPath: () => path.join(process.env.PMIS_DATA_DIR ? path.resolve(process.env.PMIS_DATA_DIR) : path.join(ROOT, 'data'), 'config.json'),
  now: () => Date.now(),
};

let originRepo;
function repo() {
  if (process.env.PMIS_QUEUE_REPO) return process.env.PMIS_QUEUE_REPO;
  if (originRepo === undefined) {
    const m = /github\.com[/:]([\w.-]+\/[\w.-]+?)(\.git)?$/.exec(deps.originUrl());
    originRepo = m ? m[1] : '';
  }
  return originRepo;
}
const token = () => process.env.PMIS_GITHUB_TOKEN || '';
const enabled = () => /^[\w.-]+\/[\w.-]+$/.test(repo()) && !!token();

async function gh(method, url, body, tok = token()) {
  const res = await deps.fetch(`${API}/repos/${repo()}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${tok}`,
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
 * 時 ref 更新會被拒(非快轉),重抓再試。佇列分支還不存在(第一次送件)就建一個沒有歷史的。
 */
async function commitFiles(files, message) {
  for (let attempt = 0; ; attempt++) {
    let head = null;
    try {
      head = (await gh('GET', `/git/ref/heads/${BRANCH}`)).object.sha;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    const base = head ? await gh('GET', `/git/commits/${head}`) : null;
    const tree = [];
    for (const [p, content] of Object.entries(files)) {
      const blob = await gh('POST', '/git/blobs', { content: toBuffer(content).toString('base64'), encoding: 'base64' });
      tree.push({ path: p, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const newTree = await gh('POST', '/git/trees', base ? { base_tree: base.tree.sha, tree } : { tree });
    const commit = await gh('POST', '/git/commits', { message, tree: newTree.sha, parents: head ? [head] : [] });
    try {
      if (head) await gh('PATCH', `/git/refs/heads/${BRANCH}`, { sha: commit.sha });
      else await gh('POST', '/git/refs', { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
      return commit.sha;
    } catch (err) {
      if (err.status !== 422 || attempt >= 2) throw err;
    }
  }
}

async function listStatusFiles() {
  try {
    const list = await gh('GET', `/contents/${enc('狀態')}?ref=${BRANCH}`);
    return (Array.isArray(list) ? list : []).filter((f) => f.type === 'file' && f.name.endsWith('.json'));
  } catch (err) {
    if (err.status === 404) return [];   // 還沒有任何一批(或分支還沒建)
    throw err;
  }
}

async function readStatusFile(file) {
  const data = await gh('GET', `/contents/${enc(file.path)}?ref=${BRANCH}`);
  return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
}

/**
 * @param {string} batch   本機批號(YYYYMMDD-NNNN);流水號是各台電腦自己編的,
 *                         佇列裡另加指紋才不會兩台撞號
 * @param {object} entries 相對路徑 → 內容(與下載 ZIP 同一份)
 * @param {object} meta    { 工程, 工程id }
 */
// 佇列分支在程式 repo 裡:repo 還公開時送進去的施工日誌人人看得到,一律不送。
// 承辦人要在改私人「之前」先貼啟用碼(否則改私人後就拉不到更新),所以會有一段「已啟用但還公開」。
let visibility = null;
async function isPrivate() {
  if (visibility && deps.now() - visibility.at < CACHE_MS) return visibility.private;
  const info = await gh('GET', '');
  visibility = { at: deps.now(), private: !!(info && info.private) };
  return visibility.private;
}

async function submitBatch(batch, entries, meta = {}) {
  if (!(await isPrivate())) {
    const err = new Error('程式 repo 還是公開的,為了不讓施工日誌外流,暫時不能送出;請先用「下載辨識問題」');
    err.status = 400;
    throw err;
  }
  const 指紋 = fingerprint(entries);
  for (const f of await listStatusFiles()) {
    const s = await readStatusFile(f).catch(() => null);
    if (s && s.指紋 === 指紋 && s.狀態 !== '沒修成') {
      // 上次的通知沒送到或那一輪掛了:重按送出要能再叫醒一次,不然這批永遠卡在排隊
      const 未結 = s.狀態 === '排隊中' || s.狀態 === '處理中';
      return { 批號: s.批號, 重複: true, 已通知: 未結 ? await dispatch() : undefined };
    }
  }
  const 批號 = `${batch}-${指紋.slice(0, 6)}`;
  const files = {};
  for (const [name, content] of Object.entries(entries)) files[`待修正/${批號}/${name}`] = content;
  files[`狀態/${批號}.json`] = JSON.stringify({
    批號, 指紋, 來源: installId(), 工程: meta.工程 || '', 工程id: meta.工程id == null ? null : meta.工程id,
    狀態: '排隊中', 更新時間: new Date(deps.now()).toISOString(), 摘要: [], 需要決定: [], commit: null,
  }, null, 2);
  await commitFiles(files, `送出辨識問題 ${批號}`);
  cache = null;
  return { 批號, 重複: false, 已通知: await dispatch() };
}

// 叫醒 main 上的 workflow。失敗不算送件失敗:問題包已在佇列,重按送出或下一次送件會再叫醒
async function dispatch() {
  try {
    await gh('POST', '/dispatches', { event_type: 'fix-queue' });
    return true;
  } catch (err) {
    console.warn('[fix-queue] 通知 workflow 失敗(重按送出或下一次送件會再叫醒):', err.message);
    return false;
  }
}

let cache = null;

async function readStatuses({ force = false } = {}) {
  // 可啟用:找得到 GitHub 位置(直接下載 ZIP 的沒有 git,跳啟用視窗也沒用)
  if (!enabled()) return { enabled: false, 可啟用: !!repo(), items: [] };
  if (!force && cache && deps.now() - cache.at < CACHE_MS) return cache.data;
  // 已貼啟用碼但 repo 還公開:只用來拉更新,送出按鈕與啟用視窗都不出現
  if (!(await isPrivate())) {
    const data = { enabled: false, 已啟用: true, 可啟用: false, items: [] };
    cache = { at: deps.now(), data };
    return data;
  }
  const items = [];
  for (const f of await listStatusFiles()) {
    const s = await readStatusFile(f).catch(() => null);
    if (!s || !s.批號) continue;
    // 別台電腦送的不顯示(看得到別校的工程名稱,也處理不了它的「需要決定」)
    if ((s.來源 || '') !== installId()) continue;
    let 狀態 = s.狀態;
    if (STALE_MS[狀態] && deps.now() - Date.parse(s.更新時間) > STALE_MS[狀態]) 狀態 = '處理逾時';
    // 已修好 / 需要決定 的批次帶 commit:本機重開拉到它之後,標籤就不再提醒重啟
    const 已套用 = s.commit ? await deps.hasCommit(s.commit) : null;
    items.push({ ...s, 狀態, 已套用 });
  }
  items.sort((a, b) => String(b.更新時間).localeCompare(String(a.更新時間)));
  const data = { enabled: true, items, 查詢時間: new Date(deps.now()).toISOString() };
  cache = { at: deps.now(), data };
  return data;
}

/**
 * 啟用:先確認這組權杖真的能寫這個 repo(貼錯、過期、權限沒勾當場就講),
 * 再存進 data/config.json(start.js 下次啟動會讀)並立即生效,包括 git pull 用的憑證。
 */
async function activate(newToken) {
  const t = String(newToken || '').trim();
  if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(t)) {
    const err = new Error('啟用碼格式不對,請確認整串都有貼上(開頭是 github_pat_)');
    err.status = 400;
    throw err;
  }
  if (!repo()) {
    const err = new Error('找不到這份程式的 GitHub 位置(這份可能是直接下載的,沒有 git)');
    err.status = 400;
    throw err;
  }
  let info;
  try {
    info = await gh('GET', '', null, t);
  } catch (err) {
    const e = new Error(err.status === 401 ? '啟用碼無效或已過期' : `無法用這組啟用碼連到 GitHub(${err.status || err.message})`);
    e.status = 400;
    throw e;
  }
  if (!info || !info.permissions || !info.permissions.push) {
    const err = new Error('這組啟用碼沒有寫入權限,建立時 Contents 要選 Read and write');
    err.status = 400;
    throw err;
  }
  const p = deps.configPath();
  const cfg = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  cfg.GITHUB_TOKEN = t;
  if (!cfg.INSTALL_ID) cfg.INSTALL_ID = crypto.randomBytes(8).toString('hex');
  process.env.PMIS_INSTALL_ID = cfg.INSTALL_ID;
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  process.env.PMIS_GITHUB_TOKEN = t;
  deps.syncGitAuth(t);
  cache = null;
  return { enabled: true, repo: repo() };
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
  // 重開後前端看到 enabled=false 就跳出啟用視窗;貼一次就好,權杖不回傳給前端。
  // 這組權杖能寫程式 repo,只准管理員設定(同 parser-routes 的 requireAdmin 判準)
  app.put('/api/auto-fix/activate', verifyToken, async (req, res) => {
    try {
      const { query } = require('./db');
      const { rows } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
      if (!rows[0] || rows[0].role !== 'admin') return res.status(403).json({ error: '需要管理員權限' });
      res.json(await activate(req.body && req.body.token));
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error('[fix-queue] 啟用失敗:', err);
      res.status(500).json({ error: '啟用失敗,請稍後再試' });
    }
  });
}

module.exports = {
  registerRoutes, enabled, submitBatch, readStatuses, activate, fingerprint, BRANCH,
  _deps: deps, _resetCache: () => { cache = null; originRepo = undefined; visibility = null; },
};
