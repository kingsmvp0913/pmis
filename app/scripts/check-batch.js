#!/usr/bin/env node
/**
 * check-batch.js — 用問題包裡的系統資料重跑一批施工日誌,印出硬錯數(JSON)
 *
 *   node scripts/check-batch.js <批次目錄> [--out 結果.json]
 *
 * 佇列 workflow 在 Claude 動手前、動手後各跑一次:**硬錯沒有變少就不算修好**。這是
 * 不靠 Claude 自述的客觀把關(施工日誌是廠商給的,內容可能夾帶對 Claude 的指令)。
 * 走的是正式流程同一條路(parseFiles → flatten → priorCum → validateDailyLog),
 * 讀取器取 repo 裡 samples/ 的版本,依 系統資料/工程.json 的「讀取器」比對 meta.vendorKey 或別名。
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-batch';
const fs = require('fs');
const path = require('path');
const { _internal: { parseFiles, flatten, priorCum, 最早日 } } = require('../server/daily-log-routes');
const { validateDailyLog } = require('../server/daily-log-validate');

const SAMPLES = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples');

function parseCsv(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const cells = (line) => (line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || [])
    .slice(0, -1).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
  const head = cells(lines.shift() || '');
  return lines.map((l) => Object.fromEntries(cells(l).map((v, i) => [head[i], v])));
}
const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

function findParser(key) {
  for (const f of fs.readdirSync(SAMPLES).filter((n) => n.endsWith('.pmisparser.js'))) {
    const mod = require(path.join(SAMPLES, f));
    const meta = mod.meta || {};
    if (meta.vendorKey === key || (meta.aliases || []).includes(key)) return { mod, file: f };
  }
  return null;
}

async function checkBatch(dir) {
  const sys = (n) => path.join(dir, '系統資料', n);
  const info = JSON.parse(fs.readFileSync(sys('工程.json'), 'utf8'));
  const found = findParser(info.讀取器);
  if (!found) return { 讀取失敗: `repo 裡找不到「${info.讀取器}」的讀取器` };
  const filetypes = require('../server/parsers/filetypes');
  // 與 registry.getParser 包的一樣:注入 filetypes
  const parser = { meta: found.mod.meta, parseAll: (p) => found.mod.parseAll(p, { filetypes }) };
  const contract = parseCsv(sys('契約項目.csv')).map((r) => ({
    項次: r.項次, 項目: r.項目, 單位: r.單位, 數量: Number(r.數量), 單價: Number(r.單價),
  }));
  const openings = parseCsv(sys('期初累計.csv')).map((r) => ({ 項次: r.項次, 數量: numOrNull(r.期初累計數量) }));
  const records = parseCsv(sys('已寫入日誌.csv')).map((r) => ({
    日期: r.日期, 項次: r.項次, 本日完成數量: numOrNull(r.本日完成數量),
  }));
  const srcDir = path.join(dir, '原始檔案');
  const files = fs.readdirSync(srcDir).sort().map((n) => ({
    // multer 的 originalname 是 latin1 解讀的 UTF-8,正式流程會轉回來
    originalname: Buffer.from(n, 'utf8').toString('latin1'),
    buffer: fs.readFileSync(path.join(srcDir, n)),
  }));
  let days;
  try {
    ({ days } = await parseFiles(files, parser));
  } catch (err) {
    return { 讀取器: found.file, 讀取失敗: err.message };
  }
  const rows = flatten(days, contract);
  const result = validateDailyLog({
    days, contract, project: info.project || {}, prior: priorCum(records, 最早日(rows), contract, openings, days),
  });
  const 代碼 = {};
  for (const e of result.errors) 代碼[e.code] = (代碼[e.code] || 0) + 1;
  return { 讀取器: found.file, 天數: days.length, 硬錯: result.errors.length, 代碼 };
}

/** after 比 before 好才算修好:讀不動→讀得動,或硬錯變少且仍讀得動。 */
function improved(before, after) {
  if (after.讀取失敗) return false;
  if (before.讀取失敗) return true;
  return after.硬錯 < before.硬錯;
}

if (require.main === module) {
  const [dir, flag, out] = process.argv.slice(2);
  checkBatch(dir).then((r) => {
    const text = JSON.stringify(r);
    if (flag === '--out' && out) fs.writeFileSync(out, text);
    console.log(text);
  }).catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { checkBatch, improved, parseCsv };
