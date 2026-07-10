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
const multer = require('multer');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const registry = require('./parsers/registry');

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
