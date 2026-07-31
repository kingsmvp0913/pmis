/**
 * project-basics.js — 工程基本資料的比對與寫入指令組裝(SP1 業務層)
 *
 * 純函式,不碰檔案系統、不碰 DB。IO 由 project-basics-routes.js 負責。
 *
 * Exports:
 *   COMPARABLE                    可與決標公告比對的欄位(順序即畫面顯示順序)
 *   compareBasics(award, project) 逐欄比對 → [{欄位, 決標公告值, 主檔值, 狀態}]
 */

// 決標公告能提供、且主檔也有對應值的欄位。契約工期/開工日期不在此列
// (決標公告推不出,見 spec §4.3);監造單位/設計單位來自系統設定,無從比對。
const COMPARABLE = ['工程名稱', '主辦機關', '承包廠商', '契約金額', '工程編號'];

/**
 * 比對前正規化:空值統一成 null;數字與其字串形式視為相同(主檔 award_amount 是
 * NUMERIC,pg 依驅動可能回字串);去除所有半形/全形空白(承辦人與公告排版的空白
 * 差異不是實質不一致)。
 */
function normalize(v) {
  if (v == null) return null;
  if (typeof v === 'number') return String(v);
  const s = String(v).replace(/[\s　]/g, '');
  if (s === '') return null;
  // 純數字字串轉成數值再轉回,消去 '3057698.00' 這類尾綴差異
  if (/^-?\d+(\.\d+)?$/.test(s)) return String(Number(s));
  return s;
}

/**
 * 逐欄比對決標公告解析值與 PMIS 專案主檔值。
 *
 * 狀態三態不可壓成布林:'missing'(沒得比)與 'diff'(比出來不同)在畫面上的
 * 提示與承辦人的處理方式不同,壓成布林會讓硬擋誤判。
 *
 * @param {object} award   parseAwardNotice 的輸出
 * @param {object} project 主檔側同名欄位
 * @returns {Array<{欄位:string, 決標公告值:any, 主檔值:any, 狀態:'match'|'diff'|'missing'}>}
 */
function compareBasics(award, project) {
  const a = award || {};
  const p = project || {};
  return COMPARABLE.map((欄位) => {
    const na = normalize(a[欄位]);
    const np = normalize(p[欄位]);
    let 狀態;
    if (na == null || np == null) 狀態 = 'missing';
    else if (na === np) 狀態 = 'match';
    else 狀態 = 'diff';
    return {
      欄位,
      決標公告值: a[欄位] == null ? null : a[欄位],
      主檔值: p[欄位] == null ? null : p[欄位],
      狀態,
    };
  });
}

module.exports = { COMPARABLE, compareBasics };
