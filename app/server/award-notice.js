/**
 * award-notice.js — 決標公告(政府電子採購網「友善列印」PDF)解析
 *
 * 決標公告是全國統一格式,不屬於任何廠商,故不進廠商讀取器 registry;
 * 解析邏輯為純函式,IO 只是薄薄一層(見 spec §5.2)。
 *
 * 本檔只抽「標籤與值同列」的錨點——28 份樣本實測皆成立。決標公告**不含契約工期**
 * (「履約起迄日期」是預估值,27 組驗證中有 13 組與實際契約工期不符),
 * 故契約工期與開工日期一律由承辦人對照開工報告表人工輸入,不在本檔解析範圍。
 *
 * Exports:
 *   flattenRows(pages)        把 extractRows 的逐頁結構攤平成單一列陣列
 *   firstValue(rows, label)   取某標籤第一個「有值」的列(標籤換行續行無值,須跳過)
 *   parseAmount(v)            '3,122,168元' -> 3122168;非此格式回 null
 *   parseDirectFields(rows)   標籤與值同列的 4 個錨點
 */

// 標籤 → 輸出欄位。全部 28 份樣本實測皆為「標籤與值同列」。
const DIRECT_ANCHORS = [
  ['標案名稱', '工程名稱'],
  ['機關名稱', '主辦機關'],
  ['標案案號', '工程編號'],
];

/**
 * 把 extractRows 的逐頁結構攤平成單一列陣列(保持原順序)。
 * @param {Array<{page:number, rows:Array<{label,value}>}>} pages
 * @returns {Array<{label:string,value:string}>}
 */
function flattenRows(pages) {
  const out = [];
  for (const p of pages || []) {
    for (const r of (p && p.rows) || []) out.push(r);
  }
  return out;
}

/**
 * 取某標籤第一個「有值」的列。標籤過長會換行,續行同標籤但無值,故不能取第一個相符列。
 * @returns {string|null} 找不到回 null(不回空字串)
 */
function firstValue(rows, label) {
  const hit = (rows || []).find((r) => r && r.label === label && r.value);
  return hit ? hit.value : null;
}

/**
 * '3,122,168元' → 3122168。決標公告同頁另有大寫國字金額(參佰壹拾貳萬…),
 * 故限定「阿拉伯數字 + 千分位 + 元」才視為金額,其餘一律 null 不編造。
 * @returns {number|null}
 */
function parseAmount(v) {
  if (v == null) return null;
  const m = /^([\d,]+)\s*元/.exec(String(v).trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * 抽出標籤與值同列的 4 個錨點。任一欄抽不到就是 null,其餘照抽。
 * @param {Array<{label,value}>} rows
 * @returns {{工程名稱:string|null, 主辦機關:string|null, 工程編號:string|null, 契約金額:number|null}}
 */
function parseDirectFields(rows) {
  const out = { 工程名稱: null, 主辦機關: null, 工程編號: null, 契約金額: null };
  for (const [label, field] of DIRECT_ANCHORS) out[field] = firstValue(rows, label);
  out.契約金額 = parseAmount(firstValue(rows, '總決標金額'));
  return out;
}

module.exports = { flattenRows, firstValue, parseAmount, parseDirectFields };
