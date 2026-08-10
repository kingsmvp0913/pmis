/**
 * db.js — PostgreSQL connection pool + schema migration
 *
 * Exports:
 *   getPool()              → pg.Pool singleton
 *   migrate()              → Promise<void>, CREATE TABLE IF NOT EXISTS (idempotent)
 *   query(text, params)    → Promise<{ rows }>, thin wrapper over pool.query
 *   _setPoolForTesting(p)  → inject a pg-mem pool in tests
 */
const { Pool } = require('pg');

let _pool = null;

/**
 * Returns the pg.Pool singleton.
 * In production, reads DATABASE_URL from env.
 * In tests, use _setPoolForTesting() to inject a pg-mem pool.
 */
function getPool() {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL;
  _pool = new Pool(connectionString ? { connectionString } : undefined);
  return _pool;
}

/**
 * Thin query wrapper — always use this instead of pool.query directly
 * so tests can inject a mock pool transparently.
 *
 * @param {string} text    SQL text with $1/$2 placeholders
 * @param {any[]}  [params] Query parameters
 * @returns {Promise<{ rows: any[] }>}
 */
async function query(text, params) {
  return getPool().query(text, params);
}

/**
 * Creates the base application tables if they don't exist.
 * Safe to call multiple times (idempotent via IF NOT EXISTS + existence probe).
 * 同時做欄位級冪等異動(見 ALTERS)。
 *
 * @returns {Promise<void>}
 */
async function migrate() {
  // Run each statement separately so pg-mem handles them without issues
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name  TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user',
      active        BOOLEAN NOT NULL DEFAULT true,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    )`,

    `CREATE TABLE IF NOT EXISTS vendors (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS vendor_contacts (
      id         SERIAL PRIMARY KEY,
      vendor_id  INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
      name       TEXT,
      phone      TEXT,
      email      TEXT,
      line_id    TEXT,
      is_primary BOOLEAN NOT NULL DEFAULT false
    )`,

    `CREATE TABLE IF NOT EXISTS schools (
      id     SERIAL PRIMARY KEY,
      name   TEXT NOT NULL,
      county TEXT
    )`,

    `CREATE TABLE IF NOT EXISTS school_contacts (
      id         SERIAL PRIMARY KEY,
      school_id  INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
      name       TEXT,
      phone      TEXT,
      email      TEXT,
      line_id    TEXT,
      is_primary BOOLEAN NOT NULL DEFAULT false
    )`,

    `CREATE TABLE IF NOT EXISTS insurers (
      id   SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS insurance_types (
      id         SERIAL PRIMARY KEY,
      insurer_id INTEGER NOT NULL REFERENCES insurers(id) ON DELETE CASCADE,
      name       TEXT NOT NULL
    )`,

    // 事務所主檔:監造/設計單位共用同一份清單——實務上都是建築師事務所,
    // 常常同一家。projects.supervisor_firm / designer_firm 仍存名稱字串(不是 FK),
    // 因為「寫入監造報表」要把名稱寫進 Excel 儲存格,這裡只是提供下拉選項與去重。
    `CREATE TABLE IF NOT EXISTS firms (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS projects (
      id                       SERIAL PRIMARY KEY,
      project_no               TEXT,
      name                     TEXT NOT NULL,
      vendor_id                INTEGER REFERENCES vendors(id),
      school_id                INTEGER REFERENCES schools(id),
      start_date               DATE,
      contract_completion_date DATE,
      actual_completion_date   DATE,
      award_amount             NUMERIC,
      insurer_id               INTEGER REFERENCES insurers(id),
      insurance_type_id        INTEGER REFERENCES insurance_types(id),
      insurance_start          DATE,
      insurance_end            DATE,
      design_fee_type          TEXT,
      design_fee_amount        NUMERIC,
      design_fee_pct           NUMERIC,
      created_at               TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS submission_history (
      id                SERIAL PRIMARY KEY,
      project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      period            TEXT,
      type              TEXT NOT NULL DEFAULT 'monthly',
      daily_log_path    TEXT,
      official_doc_path TEXT,
      report_path       TEXT,
      deadline          DATE,
      submitted_at      TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )`,

    // 工程層一次性文件(決標公告、開工報告表)。刻意不塞進 submission_history——
    // 那張表的語意是「每月/督導繳交週期」,綁著 period/deadline/繳交狀態計算,
    // 混入工程層文件會污染那套邏輯。
    // 契約詳細價目表的項目清單(SP2)。**這不是權威來源**——權威是 .xlsm 內
    // 該分頁。存在的唯一目的:重傳新版時要能依「項目名稱」比出改了什麼,以及
    // 日後 SP3 把已填施工進度搬到新位置。只剩列位置可比對的話,而列位置正是
    // 重傳時會位移的東西。
    `CREATE TABLE IF NOT EXISTS contract_items (
      id         SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      seq        INTEGER NOT NULL,
      item_no    TEXT NOT NULL,
      name       TEXT NOT NULL,
      unit       TEXT,
      quantity   NUMERIC NOT NULL,
      unit_price NUMERIC NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    // 已寫入每日施工紀錄的逐日逐項數量(SP3)。權威仍是 .xlsm 內該分頁;
    // 這張表的用途是**跨批次比對**——施工日誌分多次提交,且「後面才發現前面錯了」
    // 是真實流程,覆蓋前要能說出哪一天的哪一項從多少改成多少。
    `CREATE TABLE IF NOT EXISTS daily_records (
      id         SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      log_date   DATE NOT NULL,
      item_no    TEXT NOT NULL,
      qty        NUMERIC,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS project_attachments (
      id            SERIAL PRIMARY KEY,
      project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL,
      file_path     TEXT NOT NULL,
      original_name TEXT,
      uploaded_by   INTEGER REFERENCES users(id),
      uploaded_at   TIMESTAMPTZ DEFAULT NOW()
    )`,
  ];

  // Build set of tables that already exist so we can skip them.
  // This makes migrate() idempotent even in pg-mem, which has limited
  // support for IF NOT EXISTS with DEFAULT constraints on re-run.
  const { rows: existingRows } = await query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
  );
  const existing = new Set(existingRows.map(r => r.table_name));

  // Extract table name from "CREATE TABLE IF NOT EXISTS <name>" DDL
  const tableNameRe = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/i;

  for (const sql of statements) {
    const match = sql.match(tableNameRe);
    if (match && existing.has(match[1])) {
      continue; // table already exists, skip
    }
    try {
      await query(sql);
    } catch (err) {
      // Ignore "table already exists" (pg code 42P07)
      if (err.code !== '42P07') throw err;
    }
  }

  // 欄位級異動(冪等)。刻意不用 ADD COLUMN IF NOT EXISTS——pg-mem 支援不一致,
  // 且既有建表段已採「先查 information_schema 再決定跑不跑」的手法,沿用同一套。
  const ALTERS = [
    ['projects', 'supervisor_firm', 'TEXT'], // 監造單位,空則吊 settings 預設
    ['projects', 'designer_firm', 'TEXT'],   // 設計單位,空則吊 settings 預設
    // 決標公告 28/28 都有「機關地址」與「廠商地址」,但原本無處可存。
    // 放在主檔而非聯絡人表:地址屬於機構本身,同一機構的多個聯絡人共用一個地址。
    ['schools', 'address', 'TEXT'],
    ['vendors', 'address', 'TEXT'],
    // SP4 公文:發文資訊綁事務所——兩家事務所共用同一組電話/傳真/聯絡人/信箱,
    // 只有名稱與地址不同(見 spec 2026-08-06-SP4-公文-design §2),存全域設定
    // 會讓其中一家的地址永遠是錯的。
    ['firms', 'address', 'TEXT'],
    ['firms', 'phone', 'TEXT'],
    ['firms', 'fax', 'TEXT'],
    ['firms', 'contact', 'TEXT'],
    ['firms', 'email', 'TEXT'],
    // 公文文號一律人工輸入整串:樣本裡連「銘第」vs「墩字第」都不一致,
    // 拆欄位等於把一個不成立的格式寫死。
    ['submission_history', 'our_doc_no', 'TEXT'],
    ['submission_history', 'our_doc_date', 'DATE'],
    ['submission_history', 'vendor_doc_no', 'TEXT'],
    ['submission_history', 'vendor_doc_date', 'DATE'],
    ['submission_history', 'copies', 'TEXT'],
    // 這一天這一項的數量是哪裡來的:'parser'(讀取器直接讀文字層)或
    // 'ocr_confirmed'(掃描件 OCR 預填、承辦人逐格確認過)。空值視為 'parser'
    // ——升級前既有的資料都是那條路來的。
    // 分得出來才回答得了「這個數字為什麼跟日誌對不起來」:OCR 那條路實測
    // 1.7% 的格會讀成另一個合法數字,而 39 條驗證一條都攔不住(值本身自洽、
    // 累計也自洽)。事後查帳只剩這個欄位能指出該回頭看哪幾天的紙本。
    ['daily_records', 'source', 'TEXT'],
  ];
  const { rows: colRows } = await query(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'"
  );
  const haveCol = new Set(colRows.map((r) => `${r.table_name}.${r.column_name}`));
  for (const [table, col, type] of ALTERS) {
    if (haveCol.has(`${table}.${col}`)) continue;
    try {
      await query(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    } catch (err) {
      if (err.code !== '42701') throw err; // 42701 = duplicate_column
    }
  }

  // settings 表原本存的監造/設計單位「系統預設」是自由字串,新增 firms 主檔後
  // 若不補進去,升級後下拉選單會找不到承辦人原本設定的那家事務所、工程層存的
  // 名稱也對不上任何選項。用「name 是否已存在」判斷要不要插入,重跑不會重複。
  const { rows: seedRows } = await query(
    "SELECT value FROM settings WHERE key IN ('supervisor_firm', 'designer_firm')"
  );
  const { rows: firmRows } = await query('SELECT name FROM firms');
  const firmNames = new Set(firmRows.map((r) => r.name));
  const seedNames = new Set(
    seedRows.map((r) => (r.value || '').trim()).filter((v) => v.length > 0)
  );
  for (const name of seedNames) {
    if (firmNames.has(name)) continue;
    await query('INSERT INTO firms (name) VALUES ($1)', [name]);
    firmNames.add(name);
  }
}

/**
 * Test-only: inject a pre-built pool (e.g. from pg-mem).
 * Pass null to reset to default behaviour.
 *
 * @param {object|null} pool
 */
function _setPoolForTesting(pool) {
  _pool = pool;
}

module.exports = { getPool, migrate, query, _setPoolForTesting };
