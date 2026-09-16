#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const APP_DIR = path.resolve(__dirname, '..');
const STAMP_NAME = '.pmis-package-lock.sha256';

function packageLockHash(appDir) {
  const lockfile = path.join(appDir, 'package-lock.json');
  return crypto.createHash('sha256').update(fs.readFileSync(lockfile)).digest('hex');
}

function installDependencies(appDir) {
  const options = { cwd: appDir, stdio: 'inherit' };
  if (process.platform === 'win32') {
    return spawnSync(process.env.ComSpec || 'cmd.exe', [
      '/d', '/s', '/c', 'npm install --no-audit --no-fund',
    ], options);
  }
  return spawnSync('npm', ['install', '--no-audit', '--no-fund'], options);
}

function syncDependencies(options = {}) {
  const appDir = options.appDir || APP_DIR;
  const install = options.install || installDependencies;
  const stamp = path.join(appDir, 'node_modules', STAMP_NAME);
  const hash = packageLockHash(appDir);

  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === hash) {
    return false;
  }

  console.log('[依賴] 偵測到套件清單更新，正在安裝所需套件...');
  const result = install(appDir);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm install 失敗（結束碼 ${result.status}）`);

  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  fs.writeFileSync(stamp, `${hash}\n`, 'utf8');
  console.log('[依賴] 套件安裝完成。');
  return true;
}

if (require.main === module) {
  try {
    syncDependencies();
  } catch (err) {
    console.error(`[依賴] ${err.message}`);
    console.error('請確認網路連線後重新啟動 PMIS。');
    process.exitCode = 1;
  }
}

module.exports = { packageLockHash, syncDependencies };
