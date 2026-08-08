const fs = require('fs');
const path = require('path');

// 啟動入口有兩條:使用者雙擊的「啟動.bat」→ app/scripts/start.js,以及開發時直接
// `node app/server/index.js`。onboarding(git pull + 掃描安裝讀取器)原本只掛在
// index.js 的 `require.main === module` 分支,start.js 自己 createApp + listen,
// **整條使用者路徑跳過了 onboarding**——症狀是 samples/ 有 33 支讀取器,
// data/vendor-parsers/ 只停在手動上傳年代的那 9 支,而且不會有任何錯誤訊息。
//
// 這支測試守的是「兩條入口都要跑 onboarding」,不是某段程式碼長什麼樣;
// 用讀原始碼比對是因為兩條入口都會真的 listen 與連 DB,起不動。
const ROOT = path.resolve(__dirname, '..', '..');
const BAT = path.join(ROOT, '啟動.bat');
const ENTRIES = [
  path.join(ROOT, 'app', 'scripts', 'start.js'),
  path.join(ROOT, 'app', 'server', 'index.js'),
];

describe('啟動入口必須執行讀取器 onboarding', () => {
  test.each(ENTRIES)('%s 有呼叫 runStartupOnboarding', (file) => {
    const src = fs.readFileSync(file, 'utf8');
    expect(src).toMatch(/runStartupOnboarding\s*\(/);
  });

  test('啟動.bat 指向的仍是有 onboarding 的那支 start.js', () => {
    const bat = fs.readFileSync(BAT, 'utf8');
    expect(bat).toMatch(/app[\\/]scripts[\\/]start\.js/);
  });
});
