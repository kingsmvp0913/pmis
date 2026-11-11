/**
 * git-auth.js — 讓「啟動.bat」的 git pull 帶上 data/config.json 的 GITHUB_TOKEN
 *
 * repo 改成私人之後,沒有憑證的 git pull 會失敗,系統就靜靜停在舊版。使用者的電腦
 * 沒有 GitHub 帳號,不能靠登入視窗;改把權杖寫進**本機** .git/config 的 extraheader
 * (不進版控),bat 一行都不用改。每次啟動同步一次:換權杖、拿掉權杖都會跟著更新。
 *
 * 這裡跑在 git pull 之後,所以「第一次填權杖」那次啟動拉的是舊憑證;
 * 因此必須先填好權杖、確認拉得到,才把 repo 改成私人(見 docs/自動修正流程.md)。
 */
const { execFileSync } = require('child_process');

const KEY = 'http.https://github.com/.extraheader';

function headerFor(token) {
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
}

function currentHeader(git, root) {
  try {
    return git(['config', '--local', '--get', KEY], root).trim();
  } catch {
    return '';   // 沒設定時 git config 回 1
  }
}

/** @returns {'set'|'unset'|'unchanged'|'skipped'} */
function syncGitAuth(token, root, git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })) {
  try {
    git(['rev-parse', '--git-dir'], root);
  } catch {
    return 'skipped';   // ZIP 下載的資料夾沒有 .git,start.js 另有提示
  }
  const want = token ? headerFor(token) : '';
  const have = currentHeader(git, root);
  if (want === have) return 'unchanged';
  if (!want) {
    git(['config', '--local', '--unset-all', KEY], root);
    return 'unset';
  }
  git(['config', '--local', '--replace-all', KEY, want], root);
  return 'set';
}

module.exports = { syncGitAuth, headerFor, KEY };
