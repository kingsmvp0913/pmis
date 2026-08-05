/**
 * project-attachments-routes.js — 工程層附件(決標公告、開工報告表)的落檔與存取
 *
 * Exports:
 *   registerRoutes(app)
 *   saveAttachment({projectId, kind, buffer, originalName, userId}) — 落檔 + 寫 DB,回 {id, file_path}
 *
 * 路由:
 *   GET    /api/projects/:id/attachments   清單
 *   GET    /api/attachments/:id/download   下載(還原原檔名)
 *   DELETE /api/attachments/:id            刪除(先 unlink 再刪列)
 *
 * 路徑沿用既有慣例 data/uploads/proj_<id>/,與施工日誌同目錄,靠 kind 欄區分;
 * 不另開 data/attachments/ 這個第四個根。safeResolve/relToData 直接沿用
 * history-routes 那份,不重寫——防路徑逃逸的規則只該有一處。
 */
const fs = require('fs');
const path = require('path');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { safeResolve, relToData, UPLOAD_DIR } = require('./history-routes');

const INT4_MAX = 2147483647;
// SERIAL(int4):非此形狀的 id 永遠比不到任何一列,且會讓 PostgreSQL 丟型別錯誤
// 而被 catch 成 500,讓承辦人以為系統壞了。
function isIdShape(id) {
  return /^[1-9][0-9]*$/.test(String(id)) && Number(id) <= INT4_MAX;
}

/**
 * 落檔 + 寫 DB。
 *
 * @param {boolean} [replace] true 時先清掉同工程同 kind 的舊附件(DB 列 + 磁碟檔)。
 *   開工報告表允許重傳修正版(OCR 讀錯、傳錯檔),累積多份的話下游得靠「id 最大
 *   的才算數」這種隱含規則,承辦人在附件清單也分不出哪一份有效。
 *   **只清同 kind**:決標公告是建案依據,不該被開工報告表流程動到。
 */
async function saveAttachment({ projectId, kind, buffer, originalName, userId, replace }) {
  if (!isIdShape(projectId)) throw new Error('projectId 不合法');
  if (replace) {
    const { rows: olds } = await query(
      'SELECT id, file_path FROM project_attachments WHERE project_id = $1 AND kind = $2',
      [projectId, kind]
    );
    for (const o of olds) {
      // 先 unlink 再刪列,順序與 DELETE 路由一致:反過來的話 unlink 失敗就
      // 再也找不到那個檔(孤兒)。
      const abs = safeResolve(o.file_path);
      if (abs) { try { fs.rmSync(abs, { force: true }); } catch { /* 檔案已不在也算成功 */ } }
      await query('DELETE FROM project_attachments WHERE id = $1', [o.id]);
    }
  }
  const dir = path.join(UPLOAD_DIR, `proj_${projectId}`);
  fs.mkdirSync(dir, { recursive: true });
  // 時間戳前綴防碰撞;原檔名另存 original_name 欄,下載時才能還原。
  const safe = String(originalName || 'file').replace(/[\\/:*?"<>|]/g, '_');
  const abs = path.join(dir, `${Date.now()}_${safe}`);
  fs.writeFileSync(abs, buffer);
  const rel = relToData(abs);
  const { rows } = await query(
    `INSERT INTO project_attachments (project_id, kind, file_path, original_name, uploaded_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, file_path`,
    [projectId, kind, rel, originalName || null, userId || null]
  );
  return rows[0];
}

function registerRoutes(app) {
  // 三支路由都必須有 try/catch:Express 4 不接 async handler 的 rejection,
  // DB 一斷線就變成 unhandled rejection 讓整個 process exit,而清單這支是每次
  // 開工程編輯頁都會打的——等於一次 DB 抖動就拖垮全站,而非只失敗一個請求。
  // 錯誤細節只進 console,回應維持固定字串,不把 SQL/路徑洩給前端。
  app.get('/api/projects/:id/attachments', verifyToken, async (req, res) => {
    try {
      if (!isIdShape(req.params.id)) return res.json([]);
      const { rows } = await query(
        `SELECT id, kind, original_name, file_path, uploaded_at
           FROM project_attachments WHERE project_id = $1 ORDER BY id DESC`,
        [req.params.id]
      );
      res.json(rows);
    } catch (err) {
      console.error('[attachments] 讀取附件清單失敗:', err);
      res.status(500).json({ error: '讀取附件清單失敗' });
    }
  });

  app.get('/api/attachments/:id/download', verifyToken, async (req, res) => {
    try {
      if (!isIdShape(req.params.id)) return res.status(404).json({ error: '找不到附件' });
      const { rows } = await query(
        'SELECT file_path, original_name FROM project_attachments WHERE id = $1',
        [req.params.id]
      );
      if (!rows[0]) return res.status(404).json({ error: '找不到附件' });
      const abs = safeResolve(rows[0].file_path);
      // null = 相對路徑逃出 DATA_DIR。屬資料損毀或惡意寫入,回 400 而非 500:
      // 這不是伺服器故障,且不該讓承辦人以為重試會有用。
      if (!abs) return res.status(400).json({ error: '附件路徑不合法' });
      if (!fs.existsSync(abs)) return res.status(404).json({ error: '附件檔案已遺失' });
      res.download(abs, rows[0].original_name || path.basename(abs));
    } catch (err) {
      console.error('[attachments] 下載附件失敗:', err);
      res.status(500).json({ error: '下載附件失敗' });
    }
  });

  app.delete('/api/attachments/:id', verifyToken, async (req, res) => {
    try {
      if (!isIdShape(req.params.id)) return res.status(404).json({ error: '找不到附件' });
      const { rows } = await query(
        'SELECT file_path FROM project_attachments WHERE id = $1', [req.params.id]
      );
      if (!rows[0]) return res.status(404).json({ error: '找不到附件' });
      // 先 unlink 再刪列:順序反過來的話,unlink 失敗就再也找不到那個檔(孤兒)。
      const abs = safeResolve(rows[0].file_path);
      if (abs) { try { fs.rmSync(abs, { force: true }); } catch { /* 檔案已不在也算成功 */ } }
      await query('DELETE FROM project_attachments WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      console.error('[attachments] 刪除附件失敗:', err);
      res.status(500).json({ error: '刪除附件失敗' });
    }
  });
}

module.exports = { registerRoutes, saveAttachment };
