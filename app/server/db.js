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
