/**
 * repo 改私人後,使用者電腦的「啟動.bat」git pull 要帶權杖,否則靜靜停在舊版。
 * 用真的 git 建一個暫存 repo,驗證寫進的是**本機** .git/config,且換/拿掉權杖會跟著變。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { syncGitAuth, headerFor, KEY } = require('../scripts/git-auth');

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-gitauth-'));
  git(['init', '-q'], dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const header = () => { try { return git(['config', '--local', '--get', KEY], dir).trim(); } catch { return ''; } };

test('權杖以 x-access-token 的 Basic 標頭寫進本機 .git/config', () => {
  expect(syncGitAuth('ghp_abc', dir)).toBe('set');
  expect(header()).toBe(headerFor('ghp_abc'));
  expect(Buffer.from(header().split(' ').pop(), 'base64').toString()).toBe('x-access-token:ghp_abc');
});

test('每次啟動都同步:沒變就不動、換權杖就換、拿掉就清掉', () => {
  syncGitAuth('old', dir);
  expect(syncGitAuth('old', dir)).toBe('unchanged');
  expect(syncGitAuth('new', dir)).toBe('set');
  expect(header()).toBe(headerFor('new'));
  expect(syncGitAuth('', dir)).toBe('unset');
  expect(header()).toBe('');
  expect(syncGitAuth('', dir)).toBe('unchanged');
});

test('ZIP 下載的資料夾沒有 .git 時略過,不報錯', () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-nogit-'));
  try {
    // 暫存目錄可能落在某個 repo 底下;用假的 git 模擬「不是 repo」
    const notRepo = () => { throw new Error('not a git repository'); };
    expect(syncGitAuth('tok', plain, notRepo)).toBe('skipped');
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
});
