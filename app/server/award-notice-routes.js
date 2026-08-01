/**
 * award-notice-routes.js — 不綁工程的決標公告解析端點
 *
 * 路由:
 *   POST /api/award-notice/parse  multipart 上傳決標公告 → 解析 5 值 + 廠商/學校比對
 *
 * 為何不沿用 project-basics-routes 的 POST /api/projects/:id/award-notice:
 * 那支要求工程已存在(先 findProject 再解析),而新增工程的當下還沒有 id。
 * 兩支並存:這支給建檔流程,那支給既有工程的逐欄裁決。
 *
 * 本端點純唯讀:不落庫、不寫檔。
 */
const multer = require('multer');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { readAwardNotice } = require('./award-notice');
const { findByName, extractCounty } = require('./org-match');

// 只讀不存,走記憶體即可。
const upload = multer({ storage: multer.memoryStorage() });

function registerRoutes(app) {
  app.post('/api/award-notice/parse', verifyToken, upload.single('award_notice'),
    async (req, res) => {
      try {
        if (!req.file || !req.file.buffer || !req.file.buffer.length) {
          return res.status(400).json({ error: '請上傳決標公告 PDF' });
        }
        const parsed = await readAwardNotice(req.file.buffer);

        const { rows: vendors } = await query('SELECT id, name FROM vendors');
        const { rows: schools } = await query('SELECT id, name FROM schools');
        const v = findByName(vendors, parsed.承包廠商);
        const s = findByName(schools, parsed.主辦機關);

        res.json({
          parsed,
          // id 為 null 時前端顯示「建立並綁定」;name 照原樣帶回供建檔用。
          vendorMatch: { name: parsed.承包廠商 || null, id: v ? v.id : null },
          // county 先抽好一起回:建立時不必再算,前端也能預選下拉。
          schoolMatch: {
            name: parsed.主辦機關 || null,
            id: s ? s.id : null,
            county: extractCounty(parsed.主辦機關),
          },
        });
      } catch (err) {
        if (err.code === 'SCANNED_PDF') return res.status(400).json({ error: err.message });
        console.error('[award-notice] 決標公告解析失敗:', err);
        res.status(500).json({ error: '決標公告解析失敗,請稍後重試;若持續失敗請聯絡系統管理員' });
      }
    });
}

module.exports = { registerRoutes };
