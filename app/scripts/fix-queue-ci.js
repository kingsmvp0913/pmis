#!/usr/bin/env node
/**
 * fix-queue-ci.js — 自動修正 workflow 用的佇列狀態檔處理(見 docs/自動修正流程.md)
 *
 *   node fix-queue-ci.js list     <佇列目錄>                      印出 待修正/ 底下的批號(一行一個)
 *   node fix-queue-ci.js mark     <佇列目錄> <狀態> [批號...]      把指定批次(預設全部)的 狀態/<批號>.json 改成 <狀態>
 *   node fix-queue-ci.js finalize <佇列目錄> <批號...> --commit <sha|-> --tests <pass|fail|skip> [--reason <沒過的原因>]
 *
 * finalize 讀 Claude 寫的 結果/<批號>.json({狀態, 摘要[], 需要決定[], 放寬規則[], 原因}),配上 workflow
 * 自己跑的把關結果(範圍/危險寫法檢查、全套測試、那批硬錯有沒有變少)寫回狀態檔,然後刪掉
 * 待修正/<批號>/ 與 結果/。**把關以 workflow 為準**:Claude 說修好了但把關沒過,一律「沒修成」,不 push。
 * 狀態檔超過 30 天的順手清掉,佇列不會無限長。
 */
const fs = require('fs');
const path = require('path');

const FINAL = new Set(['已修好', '需要決定', '沒修成']);
const KEEP_DAYS = 30;

function batches(queue) {
  const dir = path.join(queue, '待修正');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

const statusPath = (queue, b) => path.join(queue, '狀態', `${b}.json`);

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeStatus(queue, b, patch, now) {
  const p = statusPath(queue, b);
  const cur = readJson(p, { 批號: b, 摘要: [], 需要決定: [], commit: null });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ...cur, ...patch, 更新時間: now.toISOString() }, null, 2));
}

function mark(queue, state, now = new Date(), only = null) {
  for (const b of batches(queue)) if (!only || only.includes(b)) writeStatus(queue, b, { 狀態: state }, now);
}

// 結果檔是 Claude 寫的(它讀過廠商檔案),會顯示在使用者畫面上:只收字串、限筆數與長度
const lines = (v) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string').slice(0, 10).map((x) => x.slice(0, 300));
const text = (v) => (typeof v === 'string' ? v.slice(0, 500) : '');

function finalize(queue, list, { commit, tests, reason }, now = new Date()) {
  for (const b of list) {
    const r = readJson(path.join(queue, '結果', `${b}.json`), null);
    let 狀態 = r && FINAL.has(r.狀態) ? r.狀態 : '沒修成';
    let 原因 = r ? text(r.原因) : 'Claude 沒有寫出處理結果(可能逾時或中途失敗)';
    const 改了程式 = commit && commit !== '-';
    if (改了程式 && tests !== 'pass') {
      狀態 = '沒修成';
      原因 = `${reason || '修改後全套測試沒過'},沒有推上去${原因 ? `;${原因}` : ''}`;
    } else if (狀態 === '已修好' && !(改了程式 && tests === 'pass')) {
      // 「已修好」只認實際推上去的 commit:把關步驟自己當掉時 Claude 的自述不可當真
      狀態 = '沒修成';
      原因 = `${reason || '沒有可推上去的修改'},沒有推上去${原因 ? `;${原因}` : ''}`;
    }
    writeStatus(queue, b, {
      狀態,
      摘要: lines(r && r.摘要),
      需要決定: lines(r && r.需要決定),
      放寬規則: lines(r && r.放寬規則),
      原因,
      commit: 改了程式 && tests === 'pass' ? commit : null,
    }, now);
    fs.rmSync(path.join(queue, '待修正', b), { recursive: true, force: true });
  }
  fs.rmSync(path.join(queue, '結果'), { recursive: true, force: true });
  const dir = path.join(queue, '狀態');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const s = readJson(path.join(dir, f), null);
      if (s && FINAL.has(s.狀態) && now - Date.parse(s.更新時間) > KEEP_DAYS * 86400000) fs.rmSync(path.join(dir, f));
    }
  }
}

if (require.main === module) {
  const [cmd, queue, ...rest] = process.argv.slice(2);
  const opt = (name) => { const i = rest.indexOf(`--${name}`); return i < 0 ? null : rest[i + 1]; };
  if (cmd === 'list') console.log(batches(queue).join('\n'));
  else if (cmd === 'mark') mark(queue, rest[0], new Date(), rest.length > 1 ? rest.slice(1) : null);
  else if (cmd === 'finalize') {
    const list = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));
    finalize(queue, list, { commit: opt('commit'), tests: opt('tests'), reason: opt('reason') });
  } else {
    console.error('用法見檔頭');
    process.exit(2);
  }
}

module.exports = { batches, mark, finalize };
