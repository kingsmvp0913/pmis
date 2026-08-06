/**
 * firm-routes.js — 事務所主檔(監造/設計單位共用同一份清單)
 *
 * Exports:
 *   registerRoutes(app) — 掛載所有事務所路由(全走 verifyToken)
 *
 * 路由:
 *   GET    /api/firms            list(依 name 排序)
 *   GET    /api/firms/:id        單筆
 *   POST   /api/firms            建立(name,不可與既有同名)
 *   PUT    /api/firms/:id        更新(name,不可與既有同名)
 *   DELETE /api/firms/:id        刪除;有工程正在使用該名稱時回 409(帶 ?force=1 強制刪除)
 */
const { query } = require('./db');
const { verifyToken } = require('./auth');

// 公文用的發文資訊。全部選填——既有事務所資料沒有這些值,不能因此擋住儲存。
const DOC_FIELDS = ['address', 'phone', 'fax', 'contact', 'email'];
const RETURNING = 'id, name, ' + DOC_FIELDS.join(', ') + ', created_at';

function docValues(body) {
  return DOC_FIELDS.map((f) => {
    const v = body[f];
    return v == null || String(v).trim() === '' ? null : String(v).trim();
  });
}

function registerRoutes(app) {
  app.get('/api/firms', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(`SELECT ${RETURNING} FROM firms ORDER BY name`);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/firms/:id', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(`SELECT ${RETURNING} FROM firms WHERE id = $1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: '事務所不存在' });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/firms', verifyToken, async (req, res) => {
    try {
      const name = (req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: '事務所名稱為必填' });
      const { rows: dup } = await query('SELECT id FROM firms WHERE name = $1', [name]);
      if (dup[0]) return res.status(400).json({ error: '已有同名事務所' });
      const { rows } = await query(
        `INSERT INTO firms (name, ${DOC_FIELDS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${RETURNING}`,
        [name, ...docValues(req.body)]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/firms/:id', verifyToken, async (req, res) => {
    try {
      const name = (req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: '事務所名稱為必填' });
      const { rows: dup } = await query(
        'SELECT id FROM firms WHERE name = $1 AND id != $2', [name, req.params.id]
      );
      if (dup[0]) return res.status(400).json({ error: '已有同名事務所' });
      // 整份取代語意:body 沒帶到的欄位會被 SET 成 NULL。呼叫端(views/firms.js)
      // 須送齊六欄——GET 已回傳全部欄位可供前端帶入表單。
      const { rows } = await query(
        `UPDATE firms SET name = $1, ${DOC_FIELDS.map((f, i) => `${f} = $${i + 2}`).join(', ')}
         WHERE id = $${DOC_FIELDS.length + 2} RETURNING ${RETURNING}`,
        [name, ...docValues(req.body), req.params.id]
      );
      if (!rows[0]) return res.status(404).json({ error: '事務所不存在' });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 刪除:projects.supervisor_firm / designer_firm 存的是名稱字串而非外鍵,
  // 刪掉事務所不會破壞既有工程資料的參照完整性,但那些工程的欄位值會變成
  // 「清單裡沒有的名稱」。故不可靜默刪除——先查有幾筆工程在用,沒有 ?force=1
  // 就回 409 讓前端跟承辦人確認。
  app.delete('/api/firms/:id', verifyToken, async (req, res) => {
    try {
      const { rows } = await query('SELECT id, name FROM firms WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: '事務所不存在' });
      const { name } = rows[0];
      const { rows: usage } = await query(
        'SELECT COUNT(*)::int AS count FROM projects WHERE supervisor_firm = $1 OR designer_firm = $1',
        [name]
      );
      const count = usage[0].count;
      const force = req.query.force === '1' || req.query.force === 'true';
      if (count > 0 && !force) {
        return res.status(409).json({
          error: `有 ${count} 筆工程正在使用「${name}」,確定仍要刪除?`,
          count,
        });
      }
      await query('DELETE FROM firms WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes };
