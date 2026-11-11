#!/usr/bin/env node
/**
 * fix-queue-gate.js — 自動修正推上去之前的固定檢查(不靠 Claude 自述)
 *
 *   node scripts/fix-queue-gate.js <repo 目錄> <base commit> [head,預設 HEAD]
 *
 * 施工日誌與承辦人說明都會被 Claude 讀,裡面若夾帶指令,最壞是 Claude 改出有問題的
 * 程式。讀取器會在使用者的伺服器裡執行,所以這裡擋兩件事:
 *   1. 只能動讀取器、驗證規則、測試、缺陷登記與讀取器 SKILL(使用者 2026-11-11 定的範圍)
 *   2. 新增的程式碼不得出現能碰系統、網路、動態執行的寫法——讀取器本來就不准 require 任何東西
 * 通過印 `ok`(exit 0),否則逐條印原因(exit 1)。
 */
const { execFileSync } = require('child_process');

const ALLOWED = [
  /^app\/server\/parsers\/vendors\/samples\/[^/]+\.pmisparser\.js$/,
  /^app\/server\/daily-log-validate\.js$/,
  /^app\/tests\/[^/]+\.test\.js$/,
  /^app\/tests\/fixtures\/[^/]+$/,
  /^docs\/來源資料缺陷\.md$/,
  /^\.claude\/skills\/gen-vendor-parser\/SKILL\.md$/,
];

// 正式程式(讀取器、驗證規則):這些在使用者電腦的伺服器裡跑
const FORBIDDEN_CODE = [
  [/\brequire\s*\(/, 'require'],
  [/\bimport\s*\(|^\s*import\s/, 'import'],
  [/\bprocess\s*[.[]/, 'process'],
  [/\b(globalThis|global)\s*[.[]/, '全域物件'],
  [/\bfetch\s*\(|XMLHttpRequest|WebSocket/, '網路存取'],
  [/\beval\s*\(|\bFunction\s*\(|new\s+Function\b/, '動態執行'],
  [/child_process|(?<![.\w])(exec(Sync|File)?|spawn(Sync)?)\s*\(/, '執行外部程式'],
  [/\bfs\s*\.|\bBuffer\s*\.\s*from\s*\([^)]*base64/, '檔案系統/解碼'],
  [/https?:\/\//, '網址'],
  [/__proto__|\bconstructor\s*\[/, '原型操作'],
];
// 測試只在 CI 與開發機跑,可以讀 fixture;但不准連網、不准跑外部程式、不准動態執行
const FORBIDDEN_TEST = [
  [/\brequire\s*\(\s*['"](?!\.{1,2}\/|path['"]|fs['"]|os['"]|jszip['"])/, '不在允許清單的模組'],
  [/\bfetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\//, '網路存取'],
  [/child_process|(?<![.\w])(exec(Sync|File)?|spawn(Sync)?)\s*\(/, '執行外部程式'],
  [/\beval\s*\(|\bFunction\s*\(|new\s+Function\b/, '動態執行'],
  [/\bprocess\s*\.\s*(exit|kill|binding|dlopen)/, 'process'],   // process.env 設暫存目錄是測試常見寫法
];

const git = (dir, args) => execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function check(dir, base, head = 'HEAD') {
  const problems = [];
  const changed = git(dir, ['diff', '--name-only', '--no-renames', `${base}..${head}`]).split('\n').filter(Boolean);
  if (!changed.length) return ['沒有任何改動'];
  for (const f of changed) {
    if (!ALLOWED.some((re) => re.test(f))) problems.push(`改到允許範圍外的檔案:${f}`);
  }
  for (const f of changed.filter((n) => n.endsWith('.js') && ALLOWED.some((re) => re.test(n)))) {
    const rules = f.startsWith('app/tests/') ? FORBIDDEN_TEST : FORBIDDEN_CODE;
    const diff = git(dir, ['diff', '-U0', '--no-renames', `${base}..${head}`, '--', f]);
    for (const line of diff.split('\n')) {
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      const code = line.slice(1);
      if (/^\s*(\/\/|\*|\/\*)/.test(code)) continue;   // 註解
      for (const [re, label] of rules) {
        if (re.test(code)) problems.push(`${f} 新增了「${label}」:${code.trim().slice(0, 120)}`);
      }
    }
  }
  return problems;
}

if (require.main === module) {
  const [dir, base, head] = process.argv.slice(2);
  const problems = check(dir, base, head || 'HEAD');
  if (!problems.length) { console.log('ok'); process.exit(0); }
  for (const p of problems) console.log(p);
  process.exit(1);
}

module.exports = { check, ALLOWED };
