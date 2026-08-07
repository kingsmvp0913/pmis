/**
 * truth-key.js — 從人工做好的監造報表 .xlsm 抽出「答案卷」
 *
 * 用途:讀取器的驗收一直是拿讀取器自己的輸出當基準,所以「讀錯但格式合法」的錯誤
 * (名稱切錯、值掛到鄰居列)驗不出來。舊案的成品報表是**外部**基準,能打破這個盲區。
 *
 * ⚠️ 這些成品是人做的,**也可能有錯**。本檔只負責「把人填的值原樣取出來」,
 * 不做任何正確性判斷——誰對誰錯由讀報告的人決定。
 *
 * Exports:
 *   LABELS               「工程基本資料」分頁 A1..A10 的預期標籤(順序即列號)
 *   readTruthKey(path)   讀成品 .xlsm → { 工程名稱, 監造單位, ..., 工程編號 }
 */
const XLSX = require('xlsx');
const { excelSerialToISO } = require('./parsers/filetypes/xlsx');

const SHEET = '工程基本資料';

// A1..A10 的標籤。49 案實測完全一致(見 docs/superpowers/specs/2026-08-07-讀取器差異量測基座-design.md)。
// 順序就是列號:LABELS[0] 在 A1。「完工期限」(A9)是報表自算的,不是答案卷欄位,故不抽。
const LABELS = [
  '工程名稱', '監造單位', '主辦機關', '設計單位', '承包廠商',
  '契約金額', '契約工期', '開工日期', '完工期限', '工程編號',
];
const SKIP = new Set(['完工期限']);

/**
 * 空值統一:空字串與純空白視同缺值(null)。
 * 比對層把 null 當「答案卷沒填」、'' 會被當成「有值但空」而列進「不一致」——
 * 那是兩種不同的情況,壓成同一種會讓報告把「人沒填」誤報成「讀取器讀錯」。
 */
function cellValue(ws, addr) {
  const c = ws[addr];
  if (!c || c.v == null) return null;
  if (typeof c.v === 'string') {
    const s = c.v.trim();
    return s === '' ? null : s;
  }
  return c.v;
}

/**
 * 讀成品監造報表的「工程基本資料」分頁。
 *
 * 分頁名寫死是刻意的,且與 SP2 挑表的作法相反(發包經費總表不能看分頁名,
 * 第一張常是別案殘留)——那是廠商自己維護的檔;這裡的分頁名由公版範本固定,49/49 一致。
 *
 * 抽值前先驗 A 欄標籤,不符就 throw。這是整份差異報告正確性的唯一防線:
 * 版面若改了而這裡靜默照抽,取到的是錯格的值,報告卻看起來完全正常,
 * 所有「不一致」都會被誤讀成讀取器的錯。
 *
 * @param {string} xlsmPath 成品報表路徑
 * @returns {object} 9 個欄位;缺值為 null
 * @throws {Error} 無該分頁,或 A 欄標籤與預期不符
 */
function readTruthKey(xlsmPath) {
  const wb = XLSX.readFile(xlsmPath, { sheetStubs: true, cellDates: false });
  const ws = wb.Sheets[SHEET];
  if (!ws) {
    throw new Error(`找不到「${SHEET}」分頁(有:${wb.SheetNames.join('、')})`);
  }

  LABELS.forEach((expected, i) => {
    const addr = `A${i + 1}`;
    const got = cellValue(ws, addr);
    if (String(got || '').replace(/[\s　:：]/g, '') !== expected) {
      throw new Error(`版面不符:${addr} 應為「${expected}」,實為「${got == null ? '(空)' : got}」`);
    }
  });

  const out = {};
  LABELS.forEach((label, i) => {
    if (SKIP.has(label)) return;
    let v = cellValue(ws, `B${i + 1}`);
    // 成品裡開工日期存的是 Excel 序號(實測 49/49)。不轉的話比對層拿到 45338,
    // 與決標公告側的 '2024-02-01' 永遠判不一致——那是格式問題不是讀取器問題。
    if (label === '開工日期' && typeof v === 'number') v = excelSerialToISO(v);
    out[label] = v;
  });
  return out;
}

module.exports = { LABELS, readTruthKey };
