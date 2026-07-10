/**
 * school-routes.js — 學校主檔 + 聯絡人
 *
 * Exports:
 *   registerRoutes(app) — 掛載所有學校路由(全走 verifyToken)
 *
 * 路由:
 *   GET    /api/schools           list(支援 ?q= 名稱搜尋)
 *   GET    /api/schools/:id       單筆(含 contacts)
 *   POST   /api/schools           建立(name/county,可帶 contacts[])
 *   PUT    /api/schools/:id       更新(可帶 contacts[],整批取代)
 *   DELETE /api/schools/:id       刪除
 */
const { query } = require('./db');
const { verifyToken } = require('./auth');

async function replaceContacts(schoolId, contacts) {
  await query('DELETE FROM school_contacts WHERE school_id = $1', [schoolId]);
  const list = Array.isArray(contacts) ? contacts : [];
  let primarySeen = false;
  for (const c of list) {
    let isPrimary = !!c.is_primary;
    if (isPrimary && primarySeen) isPrimary = false;
    if (isPrimary) primarySeen = true;
    await query(
      `INSERT INTO school_contacts (school_id, name, phone, email, line_id, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [schoolId, c.name || null, c.phone || null, c.email || null, c.line_id || null, isPrimary]
    );
  }
}

async function loadContacts(schoolId) {
  const { rows } = await query(
    'SELECT id, name, phone, email, line_id, is_primary FROM school_contacts WHERE school_id = $1 ORDER BY id',
    [schoolId]
  );
  return rows;
}

function registerRoutes(app) {
  app.get('/api/schools', verifyToken, async (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      let rows;
      if (q) {
        ({ rows } = await query(
          'SELECT id, name, county FROM schools WHERE name ILIKE $1 ORDER BY name',
          [`%${q}%`]
        ));
      } else {
        ({ rows } = await query('SELECT id, name, county FROM schools ORDER BY name'));
      }
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/schools/:id', verifyToken, async (req, res) => {
    try {
      const { rows } = await query('SELECT id, name, county FROM schools WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: '學校不存在' });
      const school = rows[0];
      school.contacts = await loadContacts(school.id);
      res.json(school);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/schools', verifyToken, async (req, res) => {
    try {
      const name = (req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: '學校名稱為必填' });
      const county = (req.body.county || '').trim() || null;
      const { rows } = await query(
        'INSERT INTO schools (name, county) VALUES ($1, $2) RETURNING id',
        [name, county]
      );
      const id = rows[0].id;
      await replaceContacts(id, req.body.contacts);
      const { rows: s } = await query('SELECT id, name, county FROM schools WHERE id = $1', [id]);
      s[0].contacts = await loadContacts(id);
      res.status(201).json(s[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/schools/:id', verifyToken, async (req, res) => {
    try {
      const name = (req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: '學校名稱為必填' });
      const county = (req.body.county || '').trim() || null;
      const { rows } = await query(
        'UPDATE schools SET name = $1, county = $2 WHERE id = $3 RETURNING id',
        [name, county, req.params.id]
      );
      if (!rows[0]) return res.status(404).json({ error: '學校不存在' });
      await replaceContacts(req.params.id, req.body.contacts);
      const { rows: s } = await query('SELECT id, name, county FROM schools WHERE id = $1', [req.params.id]);
      s[0].contacts = await loadContacts(req.params.id);
      res.json(s[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/schools/:id', verifyToken, async (req, res) => {
    try {
      await query('DELETE FROM school_contacts WHERE school_id = $1', [req.params.id]);
      const { rows } = await query('DELETE FROM schools WHERE id = $1 RETURNING id', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: '學校不存在' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes };
