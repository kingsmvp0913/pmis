/**
 * school-routes.js — 學校主檔 + 聯絡人
 *
 * Exports:
 *   registerRoutes(app) — 掛載所有學校路由(全走 verifyToken)
 *
 * 路由:
 *   GET    /api/schools           list(支援 ?q= 名稱搜尋)
 *   GET    /api/schools/:id       單筆(含 contacts)
 *   POST   /api/schools           建立(name/county/address,可帶 contacts[])
 *   PUT    /api/schools/:id       更新(可帶 contacts[],整批取代)
 *   POST   /api/schools/:id/seed  只補空缺(決標公告解析後自動呼叫)
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
          'SELECT id, name, county, address FROM schools WHERE name ILIKE $1 ORDER BY name',
          [`%${q}%`]
        ));
      } else {
        ({ rows } = await query('SELECT id, name, county, address FROM schools ORDER BY name'));
      }
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/schools/:id', verifyToken, async (req, res) => {
    try {
      const { rows } = await query('SELECT id, name, county, address FROM schools WHERE id = $1', [req.params.id]);
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
      const address = (req.body.address || '').trim() || null;
      const { rows } = await query(
        'INSERT INTO schools (name, county, address) VALUES ($1, $2, $3) RETURNING id',
        [name, county, address]
      );
      const id = rows[0].id;
      await replaceContacts(id, req.body.contacts);
      const { rows: s } = await query('SELECT id, name, county, address FROM schools WHERE id = $1', [id]);
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
      const address = (req.body.address || '').trim() || null;
      const { rows } = await query(
        'UPDATE schools SET name = $1, county = $2, address = $3 WHERE id = $4 RETURNING id',
        [name, county, address, req.params.id]
      );
      if (!rows[0]) return res.status(404).json({ error: '學校不存在' });
      await replaceContacts(req.params.id, req.body.contacts);
      const { rows: s } = await query('SELECT id, name, county, address FROM schools WHERE id = $1', [req.params.id]);
      s[0].contacts = await loadContacts(req.params.id);
      res.json(s[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 決標公告解析後自動呼叫:**只補空缺,絕不覆蓋**。
  //
  // 承辦人手動維護過的聯絡人與地址,權威性高於公告上的值(公告是決標當下的快照,
  // 承辦人可能已經更新過)。因此聯絡人只在「這所學校一筆聯絡人都沒有」時才補,
  // 地址只在原本是空的時候才填。已經有值就整個不動。
  //
  // 冪等:重複解析同一份公告不會長出第二筆聯絡人。
  app.post('/api/schools/:id/seed', verifyToken, async (req, res) => {
    try {
      const { rows } = await query('SELECT id, address FROM schools WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: '學校不存在' });
      const id = rows[0].id;
      const seeded = { contact: false, address: false };

      const c = req.body.contact || {};
      const cname = (c.name || '').trim() || null;
      const cphone = (c.phone || '').trim() || null;
      if (cname || cphone) {
        const { rows: has } = await query(
          'SELECT id FROM school_contacts WHERE school_id = $1 LIMIT 1', [id]
        );
        if (!has[0]) {
          await query(
            `INSERT INTO school_contacts (school_id, name, phone, email, line_id, is_primary)
             VALUES ($1, $2, $3, NULL, NULL, true)`,
            [id, cname, cphone]
          );
          seeded.contact = true;
        }
      }

      const address = (req.body.address || '').trim() || null;
      if (address && !(rows[0].address || '').trim()) {
        await query('UPDATE schools SET address = $1 WHERE id = $2', [address, id]);
        seeded.address = true;
      }

      const { rows: s } = await query('SELECT id, name, county, address FROM schools WHERE id = $1', [id]);
      s[0].contacts = await loadContacts(id);
      s[0].seeded = seeded;
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
