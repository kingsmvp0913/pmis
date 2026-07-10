test('jest 環境可運作', () => {
  expect(1 + 1).toBe(2);
});

test('pg-mem 可載入並建記憶體資料庫', () => {
  const { newDb } = require('pg-mem');
  const db = newDb();
  expect(typeof db.adapters.createPg).toBe('function');
});
