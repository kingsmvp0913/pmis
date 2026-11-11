#!/usr/bin/env node
/**
 * fix-queue-gate.js — 自動修正推上去之前的固定檢查(不靠 Claude 自述)
 *
 *   node scripts/fix-queue-gate.js <repo 目錄> <base commit> [head,預設 HEAD]
 *
 * 施工日誌與承辦人說明都會被 Claude 讀,裡面若夾帶指令,最壞是 Claude 改出有問題的
 * 程式。讀取器會在使用者的伺服器裡執行,所以這裡擋兩件事:
 *   1. 只能動讀取器、驗證規則、測試、缺陷登記與讀取器 SKILL(使用者 2026-11-11 定的範圍)
 *   2. 改到的程式檔整份解析成語法樹,不得出現能碰系統、網路、動態執行、原型鏈的寫法——讀取器本來就不准 require 任何東西
 *      (靜態檢查擋不住所有混淆;讀取器在伺服器裡沒有隔離,這是已知的剩餘風險,見 docs/自動修正流程.md)
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

// 逐行比對字串擋不住(`/* */ require(...)` 會被當註解跳過、'con'+'structor' 拆字),
// 改成解析成語法樹再檢查**整個檔案**;解析不了的檔案直接拒絕。
const { parse } = require('@babel/parser');

// 讀取器與驗證規則在使用者電腦的伺服器裡跑:碰得到系統、網路、動態執行的識別字一律不准出現
const DENY_IDENT_CODE = new Set([
  'require', 'process', 'global', 'globalThis', 'eval', 'Function', 'Reflect', 'Proxy',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'Worker', 'WebAssembly', 'SharedArrayBuffer',
  '__dirname', '__filename', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask',
  'atob', 'btoa', 'escape', 'unescape', 'importScripts',
]);
// 測試只在 CI(沒有權杖)與開發機跑,可以 require 專案內的檔案與少數模組,不准連網、跑外部程式、動態執行
const DENY_IDENT_TEST = new Set(['eval', 'Function', 'Reflect', 'Proxy', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Worker', 'WebAssembly']);
const TEST_MODULES = /^(\.{1,2}\/|(path|fs|os|jszip|express|supertest|pg-mem|xlsx|pdf-lib|jsonwebtoken|bcryptjs)$)/;
// 原型鏈逃脫與字串拼湊:`x.constructor.constructor('…')()`、`x['con' + 'structor']`、String.fromCharCode
const DENY_PROP = new Set([
  'constructor', '__proto__', 'prototype', '__defineGetter__', '__defineSetter__',
  '__lookupGetter__', '__lookupSetter__', 'caller', 'callee', 'fromCharCode', 'fromCodePoint', 'raw',
]);
const DENY_WORD = /constructor|__proto__|prototype|__(define|lookup)[GS]etter__/;
const DENY_MODULE = /^(child_process|node:|http|https|net|dgram|tls|dns|vm|worker_threads|cluster|module|inspector)/;

function astProblems(file, source, isTest) {
  let ast;
  try {
    ast = parse(source, { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: false });
  } catch (err) {
    return [`${file} 無法解析成 JavaScript:${err.message}`];
  }
  const out = [];
  const denyIdent = isTest ? DENY_IDENT_TEST : DENY_IDENT_CODE;
  const at = (n) => `${file}:${n.loc ? n.loc.start.line : '?'}	`;
  const isKeyPosition = (node, parent, key) => (
    ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && key === 'property' && !parent.computed)
    || ((parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod' || parent.type === 'ClassProperty'
      || parent.type === 'ClassMethod') && key === 'key' && !parent.computed)
  );
  const hasString = (n) => n && (n.type === 'StringLiteral' || n.type === 'TemplateLiteral'
    || (n.type === 'BinaryExpression' && (hasString(n.left) || hasString(n.right))));
  const visit = (node, parent, key) => {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'Identifier':
        if (!isKeyPosition(node, parent, key) && denyIdent.has(node.name)) {
          // 讀取器唯一需要的模組系統用法是 module.exports
          out.push(`${at(node)} 用了「${node.name}」`);
        }
        if (!isTest && node.name === 'module' && !isKeyPosition(node, parent, key)
          && !(parent.type === 'MemberExpression' && key === 'object' && !parent.computed && parent.property.name === 'exports')) {
          out.push(`${at(node)} 用了「module」(只准 module.exports)`);
        }
        break;
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        if (!node.computed && node.property.type === 'Identifier' && DENY_PROP.has(node.property.name)) {
          out.push(`${at(node)} 存取「.${node.property.name}」`);
        }
        if (node.computed && (node.property.type === 'TemplateLiteral'
          || (node.property.type === 'BinaryExpression' && hasString(node.property)))) {
          out.push(`${at(node)} 用拼湊的字串當屬性名`);
        }
        break;
      case 'StringLiteral':
        if (DENY_WORD.test(node.value)) out.push(`${at(node)} 字串含「${node.value.slice(0, 40)}」`);
        break;
      case 'TemplateElement':
        if (DENY_WORD.test(node.value.cooked || '')) out.push(`${at(node)} 字串含原型相關字樣`);
        break;
      case 'Import':
      case 'ImportExpression':
      case 'MetaProperty':
      case 'WithStatement':
        out.push(`${at(node)} 用了「${node.type}」`);
        break;
      case 'CallExpression':
        if (node.callee.type === 'Identifier' && node.callee.name === 'require' && isTest) {
          const arg = node.arguments[0];
          if (!arg || arg.type !== 'StringLiteral') out.push(`${at(node)} require 的參數不是固定字串`);
          else if (DENY_MODULE.test(arg.value) || !TEST_MODULES.test(arg.value)) out.push(`${at(node)} require 了「${arg.value}」`);
        }
        break;
      default:
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments' || k === 'extra') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => visit(c, node, k));
      else if (v && typeof v.type === 'string') visit(v, node, k);
    }
  };
  visit(ast.program, ast, 'program');
  return out;
}

const git = (dir, args) => execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
  cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
});

function check(dir, base, head = 'HEAD') {
  const problems = [];
  const changed = git(dir, ['diff', '--name-only', '--no-renames', `${base}..${head}`]).split('\n').filter(Boolean);
  if (!changed.length) return ['沒有任何改動'];
  for (const f of changed) {
    if (!ALLOWED.some((re) => re.test(f))) problems.push(`改到允許範圍外的檔案:${f}`);
  }
  for (const f of changed.filter((n) => n.endsWith('.js') && ALLOWED.some((re) => re.test(n)))) {
    let source;
    try { source = git(dir, ['show', `${head}:${f}`]); } catch { continue; }   // 刪掉的檔案
    let before = '';
    try { before = git(dir, ['show', `${base}:${f}`]); } catch { /* 新檔 */ }
    const isTest = f.startsWith('app/tests/');
    // 既有程式本來就有的(驗證規則 require 專案內模組、測試 require supertest)不算;
    // 同一類寫法變多才擋。比的是語法樹,註解與拆字照樣抓得到。
    const kind = (p) => p.split('	')[1];
    const had = new Map();
    for (const p of before ? astProblems(f, before, isTest) : []) {
      if (!p.includes('	')) continue;
      had.set(kind(p), (had.get(kind(p)) || 0) + 1);
    }
    for (const p of astProblems(f, source, isTest)) {
      if (!p.includes('	')) { problems.push(p); continue; }   // 解析失敗
      const n = had.get(kind(p)) || 0;
      if (n > 0) had.set(kind(p), n - 1);
      else problems.push(p.replace('	', ' '));
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

module.exports = { check, astProblems, ALLOWED };
