/**
 * vendor-routes.js — 廠商主檔 + 聯絡人 + 批次匯入
 *
 * Exports:
 *   registerRoutes(app) — 掛載所有廠商路由(全走 verifyToken)
 *
 * 路由:
 *   GET    /api/vendors           list(支援 ?q= 名稱搜尋)
 *   GET    /api/vendors/:id       單筆(含 contacts)
 *   POST   /api/vendors           建立(可帶 contacts[])
 *   PUT    /api/vendors/:id       更新(可帶 contacts[],整批取代)
 *   DELETE /api/vendors/:id       刪除
 *   POST   /api/vendors/import    批次匯入(多行文字,去空行/去重/跳過已存在)
 */
const { query } = require('./db');
const { verifyToken } = require('./auth');

// 聯絡人整批取代:先刪舊、再插新;保證同廠商至多一位 is_primary
async function replaceContacts(vendorId, contacts) {
  await query('DELETE FROM vendor_contacts WHERE vendor_id = $1', [vendorId]);
  const list = Array.isArray(contacts) ? contacts : [];
  let primarySeen = false;
  for (const c of list) {
    let isPrimary = !!c.is_primary;
    if (isPrimary && primarySeen) isPrimary = false; // 只留第一位主要
    if (isPrimary) primarySeen = true;
    await query(
      `INSERT INTO vendor_contacts (vendor_id, name, phone, email, line_id, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [vendorId, c.name || null, c.phone || null, c.email || null, c.line_id || null, isPrimary]
    );
  }
}

async function loadContacts(vendorId) {
  const { rows } = await query(
    'SELECT id, name, phone, email, line_id, is_primary FROM vendor_contacts WHERE vendor_id = $1 ORDER BY id',
    [vendorId]
  );
  return rows;
}

function registerRoutes(app) {
  // list(?q= 名稱搜尋)
  app.get('/api/vendors', verifyToken, async (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      let rows;
      if (q) {
        ({ rows } = await query(
          'SELECT id, name, created_at FROM vendors WHERE name ILIKE $1 ORDER BY name',
          [`%${q}%`]
        ));
      } else {
        ({ rows } = await query('SELECT id, name, created_at FROM vendors ORDER BY name'));
      }
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 單筆(含 contacts)
  app.get('/api/vendors/:id', verifyToken, async (req, res) => {
    try {
      const { rows } = await query('SELECT id, name, created_at FROM vendors WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: '廠商不存在' });
      const vendor = rows[0];
      vendor.contacts = await loadContacts(vendor.id);
      res.json(vendor);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 建立
  app.post('/api/vendors', verifyToken, async (req, res) => {
    try {
      const name = (req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: '廠商名稱為必填' });
      const { rows } = await query('INSERT INTO vendors (name) VALUES ($1) RETURNING id', [name]);
      const id = rows[0].id;
      await replaceContacts(id, req.body.contacts);
      const { rows: v } = await query('SELECT id, name, created_at FROM vendors WHERE id = $1', [id]);
      v[0].contacts = await loadContacts(id);
      res.status(201).json(v[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 更新
  app.put('/api/vendors/:id', verifyToken, async (req, res) => {
    try {
      const name = (req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: '廠商名稱為必填' });
      const { rows } = await query('UPDATE vendors SET name = $1 WHERE id = $2 RETURNING id', [name, req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: '廠商不存在' });
      await replaceContacts(req.params.id, req.body.contacts);
      const { rows: v } = await query('SELECT id, name, created_at FROM vendors WHERE id = $1', [req.params.id]);
      v[0].contacts = await loadContacts(req.params.id);
      res.json(v[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 刪除
  app.delete('/api/vendors/:id', verifyToken, async (req, res) => {
    try {
      await query('DELETE FROM vendor_contacts WHERE vendor_id = $1', [req.params.id]);
      const { rows } = await query('DELETE FROM vendors WHERE id = $1 RETURNING id', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: '廠商不存在' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 批次匯入:去空行、去重(與自身及既有)、跳過已存在名稱
  app.post('/api/vendors/import', verifyToken, async (req, res) => {
    try {
      const text = req.body.text || '';
      const lines = String(text).split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);

      // 自身去重(保序)
      const seen = new Set();
      const unique = [];
      for (const name of lines) {
        if (seen.has(name)) continue;
        seen.add(name);
        unique.push(name);
      }

      // 既有名稱集合
      const { rows: existRows } = await query('SELECT name FROM vendors');
      const existing = new Set(existRows.map(r => r.name));

      let created = 0;
      let skipped = 0;
      for (const name of unique) {
        if (existing.has(name)) { skipped++; continue; }
        await query('INSERT INTO vendors (name) VALUES ($1)', [name]);
        existing.add(name);
        created++;
      }
      // 自身重複(去重時被移除者)一併計入略過;空行不計
      skipped += lines.length - unique.length;

      res.json({ created, skipped });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes };
