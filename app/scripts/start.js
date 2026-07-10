#!/usr/bin/env node
/**
 * start.js — 讀 data/config.json → 設定環境變數 → 開瀏覽器 → 啟動 PMIS server
 *
 * 供 啟動.bat 呼叫(把設定檔解析與啟動流程放在 node,.bat 只要一行)。
 * 一律用 __dirname 求專案根,禁止寫死絕對路徑。
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');           // C:\pmis
const CONFIG_PATH = path.join(ROOT, 'data', 'config.json');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error('找不到 data/config.json,請先雙擊「安裝.bat」完成安裝。');
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch {
  console.error('data/config.json 損毀,請重新雙擊「安裝.bat」。');
  process.exit(1);
}
if (!cfg.JWT_SECRET) {
  console.error('config.json 缺少 JWT_SECRET,請重新雙擊「安裝.bat」。');
  process.exit(1);
}

const port = cfg.PORT || 4141;
process.env.JWT_SECRET = cfg.JWT_SECRET;
process.env.PORT = String(port);
if (cfg.DATABASE_URL) process.env.DATABASE_URL = cfg.DATABASE_URL;

// 開啟預設瀏覽器(Windows;失敗不致命)
try {
  spawn('cmd', ['/c', 'start', '', `http://localhost:${port}`], { detached: true, stdio: 'ignore' });
} catch { /* 無瀏覽器可開時略過 */ }

// 啟動 server(env 已就緒 → createApp + migrate + listen)
const { createApp } = require(path.join(ROOT, 'app', 'server', 'index.js'));
const { migrate } = require(path.join(ROOT, 'app', 'server', 'db.js'));
const app = createApp();
migrate()
  .then(() => app.listen(port, () => console.log(`PMIS 已啟動:http://localhost:${port}(關閉此視窗即停止)`)))
  .catch((err) => {
    console.error('啟動失敗(資料庫連線或初始化錯誤):' + err.message);
    console.error('請確認 PostgreSQL 已啟動,且 data/config.json 的 DATABASE_URL 帳密正確。');
    process.exit(1);
  });
