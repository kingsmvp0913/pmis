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
  // fixtures 只准放資料檔(允許清單):可執行的檔案測試 require 得到,gate 卻不會解析它
  /^app\/tests\/fixtures\/[^/]+\.(pdf|xls|xlsx|xlsm|doc|docx|json|txt|csv|png|jpe?g)$/i,
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
  'atob', 'btoa', 'escape', 'unescape', 'importScripts', 'arguments',
]);
// 測試只在 CI(沒有權杖)與開發機跑,可以 require 專案內的檔案與少數模組,不准連網、跑外部程式、動態執行
// global/globalThis 底下拿得到 process、jest、require,繞過下面的允許清單
const DENY_IDENT_TEST = new Set(['eval', 'Function', 'Reflect', 'Proxy', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Worker', 'WebAssembly',
  'global', 'globalThis']);
// 這些名字當成任何物件的屬性來存取也不准(x.process、x['jest']):別名會繞過允許清單
const GUARDED_NAMES = new Set(['process', 'jest', 'fs', 'require']);
// 測試在執行時改寫 repo 裡的檔案再 require,就繞過了上面的解析;讀取器測試只需要讀 fixture。
// 只比「新增的」:既有測試寫暫存檔的那些不受影響(見 check() 的逐項比對)
const DENY_PROP_TEST = new Set([
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync',
  'rename', 'renameSync', 'symlink', 'symlinkSync', 'link', 'linkSync', 'createWriteStream', 'mkdtemp', 'mkdtempSync',
]);
// 寫檔的方法太多(open/write/truncate/fs.promises/改名解構…)禁止清單列不完:測試的 fs 改用允許清單,只准唯讀
const FS_READ_ALLOW = new Set([
  'readFileSync', 'readFile', 'existsSync', 'readdirSync', 'readdir', 'statSync', 'stat', 'lstatSync',
  'accessSync', 'access', 'realpathSync', 'constants',
]);
// jest、process 也一樣:解構、轉存、計算屬性名都能繞過「擋某幾個名字」,改成只准這些
const JEST_ALLOW = new Set([
  'fn', 'spyOn', 'restoreAllMocks', 'clearAllMocks', 'resetAllMocks',
  'useFakeTimers', 'useRealTimers', 'advanceTimersByTime', 'runAllTimers', 'setSystemTime',
]);
const PROCESS_ALLOW = new Set(['env']);
const TEST_MODULES = /^(\.{1,2}\/|(path|fs|os|jszip|express|supertest|pg-mem|xlsx|pdf-lib|jsonwebtoken|bcryptjs)$)/;
// 原型鏈逃脫與字串拼湊:`x.constructor.constructor('…')()`、`x['con' + 'structor']`、String.fromCharCode
const DENY_PROP = new Set([
  'constructor', '__proto__', 'prototype', '__defineGetter__', '__defineSetter__',
  '__lookupGetter__', '__lookupSetter__', 'caller', 'callee', 'fromCharCode', 'fromCodePoint', 'raw',
  'mainModule', 'binding', '_linkedBinding', 'dlopen', 'getBuiltinModule',
  // Error.prepareStackTrace 拿到的呼叫點物件可以取回 this/函式本身,等於另一條拿到全域物件的路
  'prepareStackTrace', 'captureStackTrace', 'stackTraceLimit', 'getThis', 'getFunction', 'getTypeName',
]);
// require 以外載入模組的路:拿得到完整的 fs、child_process,繞過上面對 require 的檢查。
// 只擋「新增的」,既有測試原本就有的 jest.mock 不受影響
const MODULE_LOADERS = new Set([
  'requireActual', 'requireMock', 'createMockFromModule', 'mock', 'doMock', 'setMock', 'unstable_mockModule',
  'isolateModules', 'isolateModulesAsync', 'createRequire',
]);
// 字串裡出現也擋:const k = 'prepareStackTrace'; Error[k] = …、Object.defineProperty(Error, 'prepareStackTrace', …)
const DENY_WORD = /constructor|__proto__|prototype|__(define|lookup)[GS]etter__|prepareStackTrace|captureStackTrace|stackTraceLimit|getThis|getFunction|getTypeName/;
const DENY_MODULE = /^(child_process|node:|http|https|net|dgram|tls|dns|vm|worker_threads|cluster|module|inspector)/;

// tracked:該版本 git 裡有的檔案。測試 require 的相對路徑必須指到其中一個——
// 否則測試可以先用 fs 寫出一支程式再 require 進來,完全繞過這裡的解析。
function astProblems(file, source, isTest, tracked = null) {
  let ast;
  try {
    ast = parse(source, { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: false });
  } catch (err) {
    return [`${file} 無法解析成 JavaScript:${err.message}`];
  }
  const out = [];
  const denyIdent = isTest ? DENY_IDENT_TEST : DENY_IDENT_CODE;
  // 每筆問題帶「出現在哪段程式」:修改前後逐項比對時,require('./x') 與 require('child_process')
  // 才不會被當成同一種而互相抵銷(只比數量的話,刪一個合理的、加一個危險的就過關)
  let parentOf = new Map();
  const snippet = (n) => {
    const ctx = parentOf.get(n) && parentOf.get(n).type !== 'Program' ? parentOf.get(n) : n;
    return source.slice(ctx.start, ctx.end).replace(/\s+/g, ' ').slice(0, 160);
  };
  const report = (n, msg) => out.push(`${file}:${n.loc ? n.loc.start.line : '?'}\t${msg}\t${snippet(n)}`);
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
          report(node, `用了「${node.name}」`);
        }
        // 測試的 fs/jest/process 只准 x.<允許的成員>;轉存、當參數傳、解構、計算屬性名都不准
        // (那樣就追不到它被拿去做什麼)
        if (isTest && !isKeyPosition(node, parent, key)
          && (node.name === 'fs' || node.name === 'jest' || node.name === 'process')) {
          const allow = node.name === 'fs' ? FS_READ_ALLOW : node.name === 'jest' ? JEST_ALLOW : PROCESS_ALLOW;
          const what = node.name === 'fs' ? '測試的 fs 只准唯讀' : `測試的 ${node.name} 只准常用功能`;
          const asMember = (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && key === 'object';
          const asDecl = node.name === 'fs' && parent.type === 'VariableDeclarator' && key === 'id';
          if (asMember) {
            const prop = parent.computed ? null : parent.property.name;
            if (!prop || !allow.has(prop)) report(node, `${what}(用了 ${prop ? `.${prop}` : '[…]'})`);
          } else if (!asDecl) {
            report(node, `${what}:不准轉存、解構或傳出去`);
          }
        }
        // 解構出來再用(const { writeFileSync } = fs)也算
        if (isTest && DENY_PROP_TEST.has(node.name) && !isKeyPosition(node, parent, key)) report(node, `測試寫檔「${node.name}」`);
        // 測試:require 只准直接呼叫(不准轉存、.call、當參數傳),module 一律不准
        if (isTest && node.name === 'require' && !isKeyPosition(node, parent, key)
          && !(parent.type === 'CallExpression' && key === 'callee')) {
          report(node, '把 require 轉存或間接呼叫');
        }
        if (isTest && node.name === 'module' && !isKeyPosition(node, parent, key)) report(node, '用了「module」');
        if (!isTest && node.name === 'module' && !isKeyPosition(node, parent, key)
          && !(parent.type === 'MemberExpression' && key === 'object' && !parent.computed && parent.property.name === 'exports')) {
          report(node, `用了「module」(只准 module.exports)`);
        }
        break;
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        if (!node.computed && node.property.type === 'Identifier' && DENY_PROP.has(node.property.name)) {
          report(node, `存取「.${node.property.name}」`);
        }
        if (isTest && !node.computed && node.property.type === 'Identifier' && DENY_PROP_TEST.has(node.property.name)) {
          report(node, `測試寫檔「.${node.property.name}」`);
        }
        if (isTest && GUARDED_NAMES.has(node.computed ? node.property.value : node.property.name)) {
          report(node, `測試透過其他物件存取「${node.computed ? node.property.value : node.property.name}」`);
        }
        // 讀取器:危險名字當成任何物件的屬性也不准(x.process、x['fetch']),否則別名就繞過識別字清單
        if (!isTest && DENY_IDENT_CODE.has(node.computed ? node.property.value : node.property.name)) {
          report(node, `透過其他物件存取「${node.computed ? node.property.value : node.property.name}」`);
        }
        if (isTest && MODULE_LOADERS.has(node.computed ? node.property.value : node.property.name)) {
          report(node, `測試用 require 以外的方式載入模組「${node.computed ? node.property.value : node.property.name}」`);
        }
        if (isTest && node.computed && node.property.type === 'StringLiteral' && DENY_PROP_TEST.has(node.property.value)) {
          report(node, `測試寫檔「['${node.property.value}']」`);
        }
        if (node.computed && node.property.type === 'StringLiteral' && DENY_PROP.has(node.property.value)) {
          report(node, `存取「['${node.property.value}']」`);
        }
        if (node.computed && (node.property.type === 'TemplateLiteral'
          || (node.property.type === 'BinaryExpression' && hasString(node.property)))) {
          report(node, `用拼湊的字串當屬性名`);
        }
        break;
      // 一般函式裡的 this 在非嚴格模式下就是全域物件
      // 讀取器也一樣:它在使用者電腦的伺服器裡跑,this.process 就繞過了識別字清單
      case 'ThisExpression':
        report(node, isTest ? '測試用了 this' : '用了 this');
        break;
      // 物件字面量的屬性名:Object.assign(Error, { prepareStackTrace(e, s) {…} })
      case 'ObjectExpression':
        for (const pp of node.properties) {
          const k = (pp.type === 'ObjectProperty' || pp.type === 'ObjectMethod') && !pp.computed
            && (pp.key.type === 'Identifier' ? pp.key.name : pp.key.type === 'StringLiteral' ? pp.key.value : null);
          if (k && DENY_PROP.has(k)) report(node, `物件屬性名「${k}」`);
        }
        break;
      // 解構出危險屬性(const { mainModule } = process、const { constructor: C } = x)
      case 'ObjectPattern':
        for (const pp of node.properties) {
          const k = pp.type === 'ObjectProperty' && (pp.key.type === 'Identifier' ? pp.key.name
            : pp.key.type === 'StringLiteral' ? pp.key.value : null);
          if (pp.type === 'ObjectProperty' && pp.computed) report(node, '解構時用計算屬性名');
          else if (k && (DENY_PROP.has(k) || (isTest && (MODULE_LOADERS.has(k) || DENY_PROP_TEST.has(k))))) {
            report(node, `解構出「${k}」`);
          }
        }
        break;
      case 'StringLiteral':
        if (DENY_WORD.test(node.value)) report(node, `字串含「${node.value.slice(0, 40)}」`);
        if (DENY_MODULE.test(node.value)) report(node, `字串是系統模組名「${node.value.slice(0, 40)}」`);
        break;
      case 'TemplateElement':
        if (DENY_WORD.test(node.value.cooked || '')) report(node, `字串含原型相關字樣`);
        break;
      case 'Import':
      case 'ImportExpression':
      case 'MetaProperty':
      case 'WithStatement':
        report(node, `用了「${node.type}」`);
        break;
      case 'CallExpression':
        if (node.callee.type === 'Identifier' && node.callee.name === 'require' && isTest) {
          const arg = node.arguments[0];
          // require('fs') 只准 const fs = require('fs')、只解構出唯讀方法,或直接 .唯讀方法
          if (arg && arg.type === 'StringLiteral' && arg.value === 'fs') {
            const named = parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier' && parent.id.name === 'fs';
            const readOnly = parent.type === 'VariableDeclarator' && parent.id.type === 'ObjectPattern'
              && parent.id.properties.every((pp) => pp.type === 'ObjectProperty' && !pp.computed
                && pp.key.type === 'Identifier' && FS_READ_ALLOW.has(pp.key.name));
            const member = (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && key === 'object'
              && !parent.computed && FS_READ_ALLOW.has(parent.property.name);
            if (!named && !readOnly && !member) report(node, '測試的 fs 只准唯讀(require 的用法)');
          }
          if (!arg || arg.type !== 'StringLiteral') report(node, `require 的參數不是固定字串`);
          else if (DENY_MODULE.test(arg.value) || !TEST_MODULES.test(arg.value)) report(node, `require 了「${arg.value}」`);
          // fixtures 允許任何副檔名、而 gate 只解析 .js:從那裡 require 等於繞過檢查載入任意程式。
          // 先正規化再判斷(反斜線、大小寫、./ ../ 都可能拿來繞過)
          else if (arg.value.includes('\\') || /(^|\/)fixtures(\/|$)/i.test(require('path').posix.normalize(arg.value))
            || /\.(?!js$|json$)[^./]+$/i.test(arg.value)) {
            report(node, `require 了檢查不到的檔案「${arg.value}」`);
          } else if (tracked && arg.value.startsWith('.')) {
            // 要寫出完整檔名:省略副檔名時 Node 會先找 x.js,執行時才產生的 x.js 會蓋過 repo 裡的 x/index.js
            const p = require('path').posix.join(require('path').posix.dirname(file), arg.value);
            if (!/\.(js|json)$/.test(arg.value)) report(node, `require 要寫出完整檔名與副檔名「${arg.value}」`);
            else if (!tracked.has(p)) report(node, `require 了 repo 裡沒有的檔案「${arg.value}」`);
          }
        }
        break;
      default:
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments' || k === 'extra') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => { if (c && typeof c.type === 'string') parentOf.set(c, node); visit(c, node, k); });
      else if (v && typeof v.type === 'string') { parentOf.set(v, node); visit(v, node, k); }
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
  // 符號連結/子模組:git show 讀到的是連結本身,執行時拿到的卻是別的檔案
  for (const line of git(dir, ['diff', '--raw', '--no-renames', `${base}..${head}`]).split('\n').filter(Boolean)) {
    const m = /^:\d+ (\d+) \S+ \S+ \S+\t(.+)$/.exec(line);
    if (m && (m[1] === '120000' || m[1] === '160000')) problems.push(`不准新增符號連結或子模組:${m[2]}`);
  }
  const tree = (rev) => new Set(git(dir, ['ls-tree', '-r', '--name-only', rev]).split('\n').filter(Boolean));
  const tracked = tree(head);
  const trackedBase = tree(base);   // 修改前那一版用它自己的樹,既有的 require 才抵銷得掉
  for (const f of changed.filter((n) => n.endsWith('.js') && ALLOWED.some((re) => re.test(n)))) {
    let source;
    try { source = git(dir, ['show', `${head}:${f}`]); } catch { continue; }   // 刪掉的檔案
    let before = '';
    try { before = git(dir, ['show', `${base}:${f}`]); } catch { /* 新檔 */ }
    const isTest = f.startsWith('app/tests/');
    // 修改前就載入了系統模組的測試(git-auth、gate 本身…):改它時可以直接用已載入的 execFileSync,
    // 不必新增 require 就繞過下面的比對,所以這類測試一律不准自動修改
    if (isTest && before && /require\(\s*['"](child_process|vm|worker_threads|net|http|https)['"]\s*\)/.test(before)) {
      problems.push(`改到載入系統模組的測試(只准人工修改):${f}`);
      continue;
    }
    // 既有程式本來就有的(驗證規則 require 專案內模組、測試 require supertest)不算;
    // 逐項比「哪種問題 + 出現在哪段程式」,修改後多出來的才擋。比的是語法樹,註解與拆字照樣抓得到。
    const kind = (p) => p.split('\t').slice(1).join('\t');
    const had = new Map();
    for (const p of before ? astProblems(f, before, isTest, isTest ? trackedBase : null) : []) {
      if (!p.includes('\t')) continue;
      had.set(kind(p), (had.get(kind(p)) || 0) + 1);
    }
    // 修改前就會寫檔的測試(既有測試建暫存目錄那類):改它時可以把既有的寫檔呼叫換個目標,
    // 呼叫那一行的文字卻沒變,逐項比對抓不到——整支只准人工修改,自動修正要加測試就寫在新檔
    if (isTest && [...had.keys()].some((k) => /測試寫檔|測試的 fs/.test(k))) {
      problems.push(`改到會寫檔的既有測試(只准人工修改,新測試請寫在新檔):${f}`);
      continue;
    }
    for (const p of astProblems(f, source, isTest, isTest ? tracked : null)) {
      if (!p.includes('\t')) { problems.push(p); continue; }   // 解析失敗
      const n = had.get(kind(p)) || 0;
      if (n > 0) had.set(kind(p), n - 1);
      else { const [where, msg, code] = p.split('\t'); problems.push(`${where} ${msg}:${code}`); }
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
