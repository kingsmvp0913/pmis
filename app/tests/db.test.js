const { newDb } = require('pg-mem');
const db = require('../server/db');

function freshPool() {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  return new pg.Pool();
}

describe('db.migrate', () => {
  afterEach(() => db._setPoolForTesting(null));

  test('建立 users 與 settings 兩表', async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    const { rows } = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
    );
    const names = rows.map(r => r.table_name);
    expect(names).toContain('users');
    expect(names).toContain('settings');
  });

  test('建立四張主檔及其子表', async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    const { rows } = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public'"
    );
    const names = rows.map(r => r.table_name);
    for (const t of [
      'vendors', 'vendor_contacts', 'schools', 'school_contacts',
      'insurers', 'insurance_types', 'projects'
    ]) {
      expect(names).toContain(t);
    }
  });

  test('新主檔表重複 migrate 仍冪等', async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    await db.migrate();
    await db.query("INSERT INTO vendors (name) VALUES ('甲廠商')");
    const { rows } = await db.query('SELECT name FROM vendors');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('甲廠商');
  });

  test('重複呼叫 migrate 冪等、不報錯', async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    await expect(db.migrate()).resolves.toBeUndefined();
  });

  test('query 可插入並讀回 users 列', async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    await db.query(
      'INSERT INTO users (username, password_hash, display_name, role) VALUES ($1,$2,$3,$4)',
      ['admin', 'x', '管理員', 'admin']
    );
    const { rows } = await db.query('SELECT username, role, active FROM users WHERE username=$1', ['admin']);
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('admin');
    expect(rows[0].active).toBe(true);
  });
});
