/**
 * insurer-routes.js — 保險公司主檔 + 險種(insurance_types)
 *
 * Exports:
 *   registerRoutes(app) — 掛載所有保險公司路由(全走 verifyToken)
 *
 * 路由:
 *   GET    /api/insurers            list(?q= 名稱搜尋)
 *   GET    /api/insurers/:id        單筆(含 types)
 *   POST   /api/insurers            建立(name,可帶 types[]={name})
 *   PUT    /api/insurers/:id        更新(可帶 types[],整批取代)
 *   DELETE /api/insurers/:id        刪除
 *   GET    /api/insurers/:id/types  該保險公司的險種(供前端連動)
 */
const { query } = require('./db');
const { verifyToken } = require('./auth');

async function replaceTypes(insurerId, types) {
  await query('DELETE FROM insurance_types WHERE insurer_id = $1', [insurerId]);
  const list = Array.isArray(types) ? types : [];
  for (const t of list) {
    const name = (typeof t === 'string' ? t : (t && t.name) || '').trim();
    if (!name) continue;
    await query('INSERT INTO insurance_types (insurer_id, name) VALUES ($1, $2)', [insurerId, name]);
  }
}

async function loadTypes(insurerId) {
  const { rows } = await query(
    'SELECT id, name FROM insurance_types WHERE insurer_id = $1 ORDER BY id',
    [insurerId]
  );
  return rows;
}

function registerRoutes(app) {
  app.get('/api/insurers', verifyToken, async (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      let rows;
      if (q) {
        ({ rows } = await query(
          'SELECT id, name FROM insurers WHERE name ILIKE $1 ORDER BY name',
          [`%${q}%`]
        ));
      } else {
        ({ rows } = await query('SELECT id, name FROM insurers ORDER BY name'));
      }
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/insurers/:id', verifyToken, async (req, res) => {
    try {
      const { rows } = await query('SELECT id, name FROM insurers WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: '保險公司不存在' });
      const insurer = rows[0];
      insurer.types = await loadTypes(insurer.id);
      res.json(insurer);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 供前端「工程」頁險種下拉連動
  app.get('/api/insurers/:id/types', verifyToken, async (req, res) => {
    try {
      const { rows } = await query('SELECT id FROM insurers WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: '保險公司不存在' });
      res.json(await loadTypes(req.params.id));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/insurers', verifyToken, async (req, res) => {
    try {
      const name = (req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: '保險公司名稱為必填' });
      const { rows } = await query('INSERT INTO insurers (name) VALUES ($1) RETURNING id', [name]);
      const id = rows[0].id;
      await replaceTypes(id, req.body.types);
      const { rows: v } = await query('SELECT id, name FROM insurers WHERE id = $1', [id]);
      v[0].types = await loadTypes(id);
      res.status(201).json(v[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/insurers/:id', verifyToken, async (req, res) => {
    try {
      const name = (req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: '保險公司名稱為必填' });
      const { rows } = await query('UPDATE insurers SET name = $1 WHERE id = $2 RETURNING id', [name, req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: '保險公司不存在' });
      await replaceTypes(req.params.id, req.body.types);
      const { rows: v } = await query('SELECT id, name FROM insurers WHERE id = $1', [req.params.id]);
      v[0].types = await loadTypes(req.params.id);
      res.json(v[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/insurers/:id', verifyToken, async (req, res) => {
    try {
      await query('DELETE FROM insurance_types WHERE insurer_id = $1', [req.params.id]);
      const { rows } = await query('DELETE FROM insurers WHERE id = $1 RETURNING id', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: '保險公司不存在' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes };
