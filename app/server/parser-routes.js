/**
 * parser-routes.js — 廠商讀取檔(plugin parser)安裝 / 查詢 / 移除 / 批次
 *
 * Exports:
 *   registerRoutes(app) — 掛載讀取檔路由(全走 verifyToken;安裝/移除限 admin)
 *
 * 路由:
 *   GET    /api/parsers              所有廠商 × 讀取器狀態總覽 + 孤兒讀取器(登入即可看)
 *   POST   /api/parsers/bulk         admin 批次上傳(multipart 多檔 files);依 meta.vendorKey
 *                                    名稱自動歸位到同名廠商;部分成功個別回報
 *   GET    /api/vendors/:id/parser   讀取檔狀態(以該廠商名稱為 key)
 *   POST   /api/vendors/:id/parser   admin 上傳安裝(multipart 單檔;vendorKey 須等於此廠商名稱)
 *   DELETE /api/vendors/:id/parser   admin 移除(以該廠商名稱為 key)
 *
 * 安全:
 *   上傳的 JS 於安裝時會被載入執行(selfTest / 驗證),因此:
 *     - 安裝 / 移除限 admin(requireAdmin gate)。
 *     - 讀取檔僅落地 / 載入於受控 PARSER_DIR。
 *     - vendorKey = 廠商名稱;寫檔前做檔名安全化並驗證(registry 內),防路徑逃逸。
 */
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const registry = require('./parsers/registry');

// 內建讀取器目錄(隨程式碼樹一起發佈,非落地目錄)。相對本檔求出,禁止寫死絕對路徑。
const BUNDLED_DIR = path.join(__dirname, 'parsers', 'vendors', 'samples');
const BUNDLED_SUFFIX = '.pmisparser.js';

/**
 * 內建讀取器的 meta 快取。
 *
 * `registry.inspect` 每呼叫一次就寫一份暫存檔 + `Module._compile` 一次
 * (刻意繞過 require cache,見 registry.js 的說明)。列清單要對整個目錄做,
 * 實測 33 支光是 inspect 就 570ms,而且**隨廠商增加線性成長**——承辦人每次
 * 打開那頁都要重付一次,全跑測試時還會把那三支測試推過 5 秒的 timeout。
 *
 * 這個目錄是隨程式碼樹一起發佈的,只有更新 app 才會變,快取安全。key 帶
 * mtime 與 size,檔案一改就自動失效——開發時換掉讀取器不必重啟。
 *
 * ⚠️ 只快取 BUNDLED_DIR(唯讀)。**不可以拿來快取 registry.status**:
 * 那個看的是 PARSER_DIR 的安裝狀態,會被 install/remove 當場改掉。
 */
const bundledMetaCache = new Map();

function bundledMeta(abs, file) {
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = bundledMetaCache.get(file);
  if (hit && hit.key === key) return hit.meta;
  let meta = null;
  try {
    const ins = registry.inspect(fs.readFileSync(abs));
    if (ins.ok && ins.meta && ins.meta.vendorKey) meta = ins.meta;
  } catch { meta = null; }
  bundledMetaCache.set(file, { key, meta });
  return meta;
}

// 僅接受 samples 目錄下的單一 basename,擋路徑逃逸(.. / 路徑分隔 / 子目錄)。
// 回傳解析後的絕對路徑,不合法或不存在回 null。
function resolveBundledFile(file) {
  if (typeof file !== 'string' || !file) return null;
  // 必為 <name>.pmisparser.js 的純 basename(path.basename 去掉任何目錄成分後須與原字串相同)
  if (path.basename(file) !== file) return null;
  if (!file.endsWith(BUNDLED_SUFFIX)) return null;
  if (file === '.' || file === '..' || file.includes('..')) return null;
  const abs = path.join(BUNDLED_DIR, file);
  // 再確認解析結果確實落在 BUNDLED_DIR 內(雙重防護)
  if (path.dirname(abs) !== BUNDLED_DIR) return null;
  if (!fs.existsSync(abs)) return null;
  return abs;
}

// 讀取檔上傳存記憶體(不落地暫存於此;registry.install/inspect 自行處理暫存與驗證)。
const upload = multer({ storage: multer.memoryStorage() });

// admin gate:查 users 表該 req.userId 的 role,非 admin(見 auth.js 建管理員時存 'admin')回 403。
function requireAdmin(req, res, next) {
  query('SELECT role FROM users WHERE id = $1', [req.userId])
    .then(({ rows }) => {
      if (!rows[0] || rows[0].role !== 'admin') {
        return res.status(403).json({ error: '需要管理員權限' });
      }
      next();
    })
    .catch(err => res.status(500).json({ error: err.message }));
}

// 由 id 取廠商名稱(廠商鍵);不存在回 null。
async function vendorNameById(id) {
  const { rows } = await query('SELECT name FROM vendors WHERE id = $1', [id]);
  return rows[0] ? rows[0].name : null;
}

function registerRoutes(app) {
  // ── 總覽:所有廠商 × 讀取器狀態 + 孤兒讀取器 ──
  app.get('/api/parsers', verifyToken, async (req, res) => {
    try {
      const { rows: vendors } = await query('SELECT id, name FROM vendors ORDER BY name');
      // 已安裝讀取器:meta.vendorKey(名稱) → 包裝物件
      const installed = registry.loadAll();
      const matchedKeys = new Set();

      const vendorList = vendors.map((v) => {
        const st = registry.status(v.name);
        if (st.installed) matchedKeys.add(v.name);
        return {
          vendorId: v.id,
          vendorName: v.name,
          installed: st.installed,
          version: st.version || null,
          targetFields: st.targetFields || null,
          installedAt: st.installedAt || null,
        };
      });

      // 孤兒:已安裝但 meta.vendorKey 對不到任何廠商名稱
      const orphans = [];
      for (const [key, mod] of installed) {
        if (matchedKeys.has(key)) continue;
        orphans.push({
          vendorKey: key,
          version: (mod.meta && mod.meta.version) || null,
          targetFields: (mod.meta && mod.meta.targetFields) || null,
        });
      }

      res.json({ vendors: vendorList, orphans });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 批次安裝(admin,multipart 多檔 files)──
  app.post('/api/parsers/bulk', verifyToken, requireAdmin, upload.array('files'), async (req, res) => {
    try {
      const files = req.files || [];
      if (!files.length) {
        return res.status(400).json({ error: '請上傳讀取檔' });
      }

      const results = [];
      for (const f of files) {
        const entry = { filename: f.originalname, vendorKey: null, matchedVendorId: null, ok: false, error: null };
        // 1) 檢視 + 驗證(結構 + selfTest);讀 meta.vendorKey(廠商名稱)
        const ins = registry.inspect(f.buffer);
        if (!ins.ok) {
          entry.error = ins.error;
          results.push(entry);
          continue;
        }
        const vendorKey = String(ins.meta.vendorKey);
        entry.vendorKey = vendorKey;
        // 2) 查 vendors 表有無同名廠商
        const { rows } = await query('SELECT id FROM vendors WHERE name = $1', [vendorKey]);
        if (!rows[0]) {
          entry.error = 'unmatched:查無同名廠商';
          results.push(entry);
          continue;
        }
        entry.matchedVendorId = rows[0].id;
        // 3) 安裝(以名稱為 key)
        const inst = registry.install(f.buffer, vendorKey);
        if (!inst.ok) {
          entry.error = inst.error;
          results.push(entry);
          continue;
        }
        entry.ok = true;
        results.push(entry);
      }

      res.status(200).json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 內建讀取器清單(登入即可看)──
  // 掃 samples 目錄下所有 *.pmisparser.js,回每支的 meta + 是否已建廠商 / 已安裝。
  app.get('/api/parsers/bundled', verifyToken, async (req, res) => {
    try {
      let files = [];
      if (fs.existsSync(BUNDLED_DIR)) {
        files = fs.readdirSync(BUNDLED_DIR).filter(f => f.endsWith(BUNDLED_SUFFIX));
      }
      const metas = [];
      for (const f of files) {
        const abs = resolveBundledFile(f);
        if (!abs) continue; // 只回白名單通過者
        const meta = bundledMeta(abs, f);
        if (meta) metas.push({ file: f, meta });
      }
      // 廠商一次查完,不要在迴圈裡逐支查:33 支就是 33 趟 round-trip。
      const keys = metas.map((m) => String(m.meta.vendorKey));
      const { rows } = keys.length
        ? await query('SELECT name FROM vendors WHERE name = ANY($1::text[])', [keys])
        : { rows: [] };
      const 已建廠商 = new Set(rows.map((r) => r.name));
      const list = metas.map(({ file, meta }) => {
        const vendorKey = String(meta.vendorKey);
        return {
          file,
          vendorKey,
          version: meta.version || null,
          targetFields: meta.targetFields || null,
          vendorExists: 已建廠商.has(vendorKey),
          installed: registry.status(vendorKey).installed,
        };
      });
      res.json(list);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 一鍵安裝內建讀取器(admin)──
  // body { file:'<basename>.pmisparser.js' };驗證白名單→安裝→必要時自動建同名廠商。
  app.post('/api/parsers/install-bundled', verifyToken, requireAdmin, async (req, res) => {
    try {
      const abs = resolveBundledFile(req.body && req.body.file);
      if (!abs) {
        return res.status(400).json({ error: '無效的內建讀取器檔名' });
      }
      const src = fs.readFileSync(abs);
      const ins = registry.inspect(src);
      if (!ins.ok || !ins.meta || !ins.meta.vendorKey) {
        return res.status(400).json({ error: ins.error || '內建讀取器驗證失敗' });
      }
      const vendorKey = String(ins.meta.vendorKey);

      const inst = registry.install(src, vendorKey);
      if (!inst.ok) {
        return res.status(400).json({ error: inst.error });
      }

      // 自動建廠商:無同名則以 vendorKey 為 name 新增,讓一鍵裝完即可用。
      let vendorCreated = false;
      const { rows } = await query('SELECT id FROM vendors WHERE name = $1', [vendorKey]);
      if (!rows[0]) {
        await query('INSERT INTO vendors (name) VALUES ($1)', [vendorKey]);
        vendorCreated = true;
      }

      res.status(200).json({ ok: true, vendorKey, vendorCreated, status: inst.status });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 單家讀取檔狀態(以廠商名稱為 key)──
  app.get('/api/vendors/:id/parser', verifyToken, async (req, res) => {
    try {
      const name = await vendorNameById(req.params.id);
      if (name === null) {
        return res.status(404).json({ error: '廠商不存在' });
      }
      res.json(registry.status(name));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 單家安裝(admin,multipart 單檔;vendorKey 須等於此廠商名稱)──
  app.post('/api/vendors/:id/parser', verifyToken, requireAdmin, upload.single('parser'), async (req, res) => {
    try {
      const name = await vendorNameById(req.params.id);
      if (name === null) {
        return res.status(404).json({ error: '廠商不存在' });
      }
      if (!req.file || !req.file.buffer || !req.file.buffer.length) {
        return res.status(400).json({ error: '請上傳讀取檔' });
      }
      const result = registry.install(req.file.buffer, name);
      if (!result.ok) {
        return res.status(400).json({ error: result.error });
      }
      res.status(201).json(result.status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 單家移除(admin,以廠商名稱為 key)──
  app.delete('/api/vendors/:id/parser', verifyToken, requireAdmin, async (req, res) => {
    try {
      const name = await vendorNameById(req.params.id);
      if (name === null) {
        return res.status(404).json({ error: '廠商不存在' });
      }
      const result = registry.remove(name);
      if (!result.ok) {
        return res.status(400).json({ error: result.error });
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes };
