const { newDb } = require('pg-mem');
const db = require('../server/db');

async function freshDb() {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  db._setPoolForTesting(new pg.Pool());
  await db.migrate();
}

describe('project_attachments 資料表', () => {
  // 附件必須與工程同生共死:工程刪掉還留著附件列,下載端點會指向不存在的檔,
  // 且沒有任何畫面能看到它們(孤兒列)。
  test('建表後可插入,且 project_id 為外鍵並隨工程 CASCADE', async () => {
    await freshDb();
    const { rows: p } = await db.query(
      `INSERT INTO projects (name) VALUES ('測試工程') RETURNING id`
    );
    await db.query(
      `INSERT INTO project_attachments (project_id, kind, file_path, original_name)
       VALUES ($1, 'award_notice', 'uploads/proj_1/123_a.pdf', 'a.pdf')`,
      [p[0].id]
    );
    const { rows: before } = await db.query('SELECT * FROM project_attachments');
    expect(before).toHaveLength(1);
    expect(before[0].kind).toBe('award_notice');

    await db.query('DELETE FROM projects WHERE id = $1', [p[0].id]);
    const { rows: after } = await db.query('SELECT * FROM project_attachments');
    expect(after).toHaveLength(0);
  });

  // migrate() 每次啟動都會跑;不冪等的話第二次啟動就炸,而那只會在正式環境重啟時發現。
  test('重跑 migrate 不炸且不重複建表', async () => {
    await freshDb();
    await expect(db.migrate()).resolves.not.toThrow();
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'project_attachments'`
    );
    const cols = rows.map((r) => r.column_name).sort();
    expect(cols).toEqual(
      ['file_path', 'id', 'kind', 'original_name', 'project_id', 'uploaded_at', 'uploaded_by'].sort()
    );
  });
});
