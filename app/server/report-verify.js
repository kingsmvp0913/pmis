/**
 * report-verify.js — 上傳既有監造報表時的版面檢查
 *
 * 承辦人上傳自己做到一半的報表當作這一案的常駐檔。**版面對不上就必須擋下**
 * (使用者裁決 2026-08-10):系統是靠固定的分頁名與儲存格位址寫入的
 * (工程基本資料!B1-B10、每日施工紀錄的日期欄由 J 欄起算…),版面一不同就會把
 * 數字寫進錯的格子——而那種錯不會讓任何地方報錯,整份報表卻是歪的。
 *
 * 檢查刻意只看「系統真的會寫入的位置」,不做全檔比對:承辦人的報表本來就會有
 * 自己加的分頁、調過的欄寬、多出來的註記,那些都不影響寫入正確性,擋下來只會
 * 讓一份可用的檔案進不來。
 *
 * Exports:
 *   verifyWorkbook(xlsmPath) → { ok:boolean, problems:string[] }
 */
const XLSX = require('xlsx');

// 系統寫入時依賴的分頁。少一個就寫不進去。
const REQUIRED_SHEETS = ['工程基本資料', '契約詳細價目表', '監造報表', '每日施工紀錄'];

// 「這一格必須是這個標籤」——用標籤而不是位置比對,才能指出**哪裡**不對。
// 取自公版範本;這些是寫入位址的錨點,錯位了整排都會歪。
const ANCHORS = [
  ['工程基本資料', 'A1', '工程名稱'],
  ['工程基本資料', 'A6', '契約金額'],
  ['工程基本資料', 'A7', '契約工期'],
  ['工程基本資料', 'A8', '開工日期'],
  ['工程基本資料', 'A10', '工程編號'],
  ['契約詳細價目表', 'A1', '項次'],
  ['契約詳細價目表', 'D1', '契約數量'],
];

const 去空白 = (v) => String(v == null ? '' : v).replace(/[\s　]/g, '');

/**
 * @param {string} xlsmPath
 * @returns {{ok:boolean, problems:string[]}} problems 寫給承辦人看,直接顯示
 */
function verifyWorkbook(xlsmPath) {
  const problems = [];
  let wb;
  try {
    wb = XLSX.readFile(xlsmPath, { bookVBA: true });
  } catch (e) {
    return { ok: false, problems: ['這個檔案打不開,請確認是 Excel 的 .xlsm 監造報表'] };
  }

  const names = new Set(wb.SheetNames || []);
  const 缺分頁 = REQUIRED_SHEETS.filter((s) => !names.has(s));
  if (缺分頁.length) {
    problems.push(`缺少分頁:${缺分頁.join('、')}(系統要靠這些分頁寫入資料)`);
  }

  for (const [sheet, addr, expect] of ANCHORS) {
    if (!names.has(sheet)) continue;                 // 分頁本身缺了,上面已經報過
    const ws = wb.Sheets[sheet];
    const got = ws && ws[addr] ? 去空白(ws[addr].v) : '';
    if (去空白(got) !== 去空白(expect)) {
      problems.push(`「${sheet}」的 ${addr} 應該是「${expect}」,實際是「${got || '(空白)'}」`);
    }
  }

  // 巨集不見不擋:報表的巨集是列印/排版用的,少了它資料仍然寫得進去,
  // 擋下來會讓一份內容正確的檔案進不來。只在問題清單裡提一句。
  if (!wb.vbaraw) {
    problems.push('(提醒)這份檔案沒有巨集,若原本的報表有列印巨集,另存時可能被拿掉了');
  }

  // 只有「提醒」開頭的訊息不算失敗
  const 硬問題 = problems.filter((p) => !p.startsWith('(提醒)'));
  return { ok: 硬問題.length === 0, problems };
}

module.exports = { verifyWorkbook, REQUIRED_SHEETS, ANCHORS };
