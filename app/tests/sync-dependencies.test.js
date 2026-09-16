const fs = require('fs');
const os = require('os');
const path = require('path');
const { packageLockHash, syncDependencies } = require('../scripts/sync-dependencies');

function fixture() {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-deps-'));
  fs.writeFileSync(path.join(appDir, 'package-lock.json'), '{"version":1}\n');
  return appDir;
}

describe('啟動時同步 npm 相依套件', () => {
  const dirs = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('首次啟動安裝套件並記錄 lockfile 雜湊', () => {
    const appDir = fixture();
    dirs.push(appDir);
    const install = jest.fn(() => ({ status: 0 }));

    expect(syncDependencies({ appDir, install })).toBe(true);
    expect(install).toHaveBeenCalledWith(appDir);
    expect(fs.readFileSync(path.join(appDir, 'node_modules', '.pmis-package-lock.sha256'), 'utf8').trim())
      .toBe(packageLockHash(appDir));
  });

  test('lockfile 未變時略過安裝', () => {
    const appDir = fixture();
    dirs.push(appDir);
    const install = jest.fn(() => ({ status: 0 }));
    syncDependencies({ appDir, install });

    expect(syncDependencies({ appDir, install })).toBe(false);
    expect(install).toHaveBeenCalledTimes(1);
  });

  test('lockfile 改變時重新安裝', () => {
    const appDir = fixture();
    dirs.push(appDir);
    const install = jest.fn(() => ({ status: 0 }));
    syncDependencies({ appDir, install });
    fs.writeFileSync(path.join(appDir, 'package-lock.json'), '{"version":2}\n');

    expect(syncDependencies({ appDir, install })).toBe(true);
    expect(install).toHaveBeenCalledTimes(2);
  });

  test('安裝失敗時不寫入新雜湊，讓下次啟動重試', () => {
    const appDir = fixture();
    dirs.push(appDir);
    const stamp = path.join(appDir, 'node_modules', '.pmis-package-lock.sha256');
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    fs.writeFileSync(stamp, 'old-hash\n');
    const install = jest.fn(() => ({ status: 1 }));

    expect(() => syncDependencies({ appDir, install })).toThrow('npm install 失敗');
    expect(fs.readFileSync(stamp, 'utf8').trim()).toBe('old-hash');
  });
});
