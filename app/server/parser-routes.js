/**
 * parser-routes.js — 廠商讀取檔(plugin parser)安裝 / 查詢 / 移除
 *
 * Exports:
 *   registerRoutes(app) — 掛載讀取檔路由(全走 verifyToken;安裝/移除限 admin)
 *
 * 路由:
 *   GET    /api/vendors/:id/parser   讀取檔狀態(installed/version/targetFields/installedAt)
 *   POST   /api/vendors/:id/parser   admin 上傳安裝(multipart 單檔;vendorKey 須等於此廠商 id)
 *   DELETE /api/vendors/:id/parser   admin 移除
 *
 * 安全:
 *   上傳的 JS 於安裝時會被 require 執行(selfTest / 驗證),因此:
 *     - 安裝 / 移除限 admin(requireAdmin gate)。
 *     - 讀取檔僅落地 / 載入於受控 PARSER_DIR。
 *     - vendorKey 必為純數字廠商 id,寫檔前驗證(registry 內),防路徑逃逸。
 */
const multer = require('multer');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const registry = require('./parsers/registry');

// 讀取檔上傳存記憶體(不落地暫存於此;registry.install 自行處理暫存與驗證)。
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

async function vendorExists(id) {
  const { rows } = await query('SELECT id FROM vendors WHERE id = $1', [id]);
  return !!rows[0];
}

function registerRoutes(app) {
  // 讀取檔狀態
  app.get('/api/vendors/:id/parser', verifyToken, async (req, res) => {
    try {
      if (!(await vendorExists(req.params.id))) {
        return res.status(404).json({ error: '廠商不存在' });
      }
      res.json(registry.status(String(req.params.id)));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 安裝(admin,multipart 單檔)
  app.post('/api/vendors/:id/parser', verifyToken, requireAdmin, upload.single('parser'), async (req, res) => {
    try {
      if (!(await vendorExists(req.params.id))) {
        return res.status(404).json({ error: '廠商不存在' });
      }
      if (!req.file || !req.file.buffer || !req.file.buffer.length) {
        return res.status(400).json({ error: '請上傳讀取檔' });
      }
      const result = registry.install(req.file.buffer, String(req.params.id));
      if (!result.ok) {
        return res.status(400).json({ error: result.error });
      }
      res.status(201).json(result.status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 移除(admin)
  app.delete('/api/vendors/:id/parser', verifyToken, requireAdmin, async (req, res) => {
    try {
      if (!(await vendorExists(req.params.id))) {
        return res.status(404).json({ error: '廠商不存在' });
      }
      const result = registry.remove(String(req.params.id));
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
