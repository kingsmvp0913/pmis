#!/usr/bin/env node
/**
 * setup.js — PMIS 一鍵安裝編排(建 DB → migrate → 視需要建管理員)
 *
 * Exports:
 *   buildConfig(overrides?) → { DATABASE_URL, JWT_SECRET, PORT }  純函式,無 I/O
 *
 * 主流程(直接執行時):
 *   1. 讀/建 data/config.json(含 JWT_SECRET / DATABASE_URL / PORT)
 *   2. 若目標資料庫不存在則 CREATE DATABASE
 *   3. 對目標資料庫跑 migrate()
 *
 * 一律用 __dirname 求專案根,禁止寫死絕對路徑。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');           // C:\pmis
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const DEFAULT_DB_NAME = 'pmis';
const DEFAULT_PORT = 4141;

/**
 * 產生設定物件(純函式,可測試)。overrides 逐欄覆寫。
 * @param {{DATABASE_URL?:string, JWT_SECRET?:string, PORT?:number}} [overrides]
 */
function buildConfig(overrides = {}) {
  return {
    DATABASE_URL: overrides.DATABASE_URL
      || process.env.DATABASE_URL
      || `postgres://postgres:postgres@localhost:5432/${DEFAULT_DB_NAME}`,
    JWT_SECRET: overrides.JWT_SECRET
      || crypto.randomBytes(32).toString('hex'),
    PORT: overrides.PORT || Number(process.env.PORT) || DEFAULT_PORT,
  };
}

// 讀既有 config;不存在則以 buildConfig 產生並寫檔(JWT_SECRET 落地後不再變)
function ensureConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const cfg = buildConfig();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

// 從 DATABASE_URL 拆出 DB 名,並回傳連到 postgres 系統庫的 URL(用來 CREATE DATABASE)
function splitDbUrl(databaseUrl) {
  const u = new URL(databaseUrl);
  const dbName = u.pathname.replace(/^\//, '');
  u.pathname = '/postgres';
  return { adminUrl: u.toString(), dbName };
}

// 目標 DB 不存在則建立
async function ensureDatabase(databaseUrl) {
  const { Client } = require('pg');
  const { adminUrl, dbName } = splitDbUrl(databaseUrl);
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rows.length === 0) {
      // 資料庫名來自本機 config,非使用者輸入;用識別字引號避免注入疑慮
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      console.log(`[OK] 已建立資料庫 ${dbName}`);
    } else {
      console.log(`[OK] 資料庫 ${dbName} 已存在`);
    }
  } finally {
    await client.end();
  }
}

async function main() {
  console.log('=== PMIS 一鍵安裝 ===');
  const cfg = ensureConfig();
  console.log('[OK] 設定檔就緒:' + CONFIG_PATH);

  await ensureDatabase(cfg.DATABASE_URL);

  // 對目標 DB 跑 migrate
  process.env.DATABASE_URL = cfg.DATABASE_URL;
  const db = require(path.join(ROOT, 'app', 'server', 'db.js'));
  await db.migrate();
  console.log('[OK] 資料表 migration 完成');

  console.log('安裝完成。可執行 .\\start.ps1 啟動(首次啟動會導向建立管理員)。');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[FAIL] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { buildConfig };
