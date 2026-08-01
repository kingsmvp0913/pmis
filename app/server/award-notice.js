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
 *   parseVenue(v)             '雲林縣(非原住民地區)' -> '雲林縣';去括號註記供 SP1B 階段二比對
 *   parsePeriod(v)            '115/06/16 - 115/11/12 (預估)' -> {起,迄};拆日期並去預估標記供 SP1B 階段二比對
 *   parseDirectFields(rows)   標籤與值同列的 4 個錨點
 *   winningVendor(rows)       由「投標廠商N」群組取「是否得標=是」那家
 *   parseAwardNotice(pages)   組合上述,純函式輸出 8 值(原 5 值 + 決標日/地點/起迄供階段二比對);掃描件 throw
 *   readAwardNotice(fileOrBuffer)  讀檔(路徑或 Buffer)後解析,薄薄一層 IO
 */

const { extractRows } = require('./parsers/filetypes/pdf');

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
 * '雲林縣(非原住民地區)' → '雲林縣'。27/27 份的履約地點都是這種「行政區級距 + 括號註記」
 * 形態,與開工報告表的實際地址不是同一種資料,只能比開頭縣市(spec §5.2)。
 * 全形括號也要處理:同一份公告內半形全形混用。
 * @returns {string|null}
 */
function parseVenue(v) {
  if (v == null) return null;
  const s = String(v).replace(/[（(].*$/, '').trim();
  return s === '' ? null : s;
}

/**
 * '115/06/16 - 115/11/12 (預估)' → { 起, 迄 }。
 * 「(預估)」必須去掉——它是決標公告自己標明的不確定性(spec §5.3),
 * 留著會讓迄日與開工報告表逐字比永遠不符。
 * 鹿場 B1150513 整份無此欄,缺值回兩個 null 而非 throw:
 * 一份缺欄不該讓其餘 7 欄一起拿不到。
 * @returns {{起:string|null, 迄:string|null}}
 */
function parsePeriod(v) {
  if (v == null) return { 起: null, 迄: null };
  const s = String(v).replace(/[（(].*$/, '').trim();
  const m = /^(\d{2,3}\/\d{1,2}\/\d{1,2})\s*[-–~]\s*(\d{2,3}\/\d{1,2}\/\d{1,2})$/.exec(s);
  return m ? { 起: m[1], 迄: m[2] } : { 起: null, 迄: null };
}

/**
 * 由「投標廠商N」群組取得標廠商名稱。
 *
 * 決標公告會列出所有投標廠商,**得標的不必然是第一家**——28 份樣本中有 4 份不是
 * (仁德第 2、四湖永慶第 3、豐榮第 2、鹿場第 3)。故一律以群組內的
 * 「是否得標 = 是」判定,取第一個「廠商名稱」是錯的。
 *
 * @param {Array<{label,value}>} rows
 * @returns {string|null}
 */
function winningVendor(rows) {
  let name = null;
  for (const r of rows || []) {
    if (!r) continue;
    if (/^投標廠商\d+$/.test(r.label)) { name = null; continue; }
    if (r.label === '廠商名稱') { name = r.value || null; continue; }
    if (r.label === '是否得標') {
      if (r.value === '是' && name) return name;
      name = null;
    }
  }
  return null;
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

/**
 * 機關(學校)與廠商的聯絡資訊。28 份樣本實測:這 5 個標籤**每份都恰好出現一次**,
 * 故用 firstValue(完全相等比對)即可,不需要像得標廠商那樣掃群組。
 *
 * **兩邊不對稱,不是漏抽**:機關側有「聯絡人」姓名,廠商側只有電話與地址——
 * 決標公告上沒有廠商聯絡人姓名這個欄位。廠商聯絡人因此只有電話,姓名留空由承辦人補。
 *
 * 廠商電話/地址緊接在「是否得標=是」那家之後,得標廠商排第 2、第 3 家的樣本
 * (仁德/四湖永慶/豐榮/鹿場)實測也正確,不會貼到落選廠商身上。
 *
 * 值一律照抄(只 trim):地址帶的空白來自 PDF 分欄,自行合併等於編造格式。
 */
function parseContacts(rows) {
  const v = (label) => {
    const s = firstValue(rows, label);
    return s == null ? null : String(s).trim() || null;
  };
  return {
    機關聯絡人: v('聯絡人'),
    機關電話: v('聯絡電話'),
    機關地址: v('機關地址'),
    廠商電話: v('廠商電話'),
    廠商地址: v('廠商地址'),
  };
}

/**
 * 解析決標公告 → 13 值(原 5 值 + 3 個 SP1B 階段二比對錨點 + 5 個聯絡資訊)。
 * 純函式,吃 extractRows 的輸出。
 *
 * 整份抽不到任何文字 = 掃描件。此時直接 throw(帶 code 'SCANNED_PDF')而非回滿滿 null,
 * 否則承辦人會誤以為「已解析、只是沒抓到」而放行。不做 OCR fallback。
 *
 * @param {Array<{page:number, rows:Array<{label,value}>}>} pages
 * @returns {{工程名稱, 主辦機關, 承包廠商, 契約金額, 工程編號, 決標日期, 履約地點, 履約起迄,
 *   機關聯絡人, 機關電話, 機關地址, 廠商電話, 廠商地址}}
 */
function parseAwardNotice(pages) {
  const rows = flattenRows(pages);
  if (!rows.some((r) => r && (r.label || r.value))) {
    const err = new Error('此決標公告為掃描件(PDF 內無可抽取文字),無法自動解析');
    err.code = 'SCANNED_PDF';
    throw err;
  }
  const direct = parseDirectFields(rows);
  return {
    工程名稱: direct.工程名稱,
    主辦機關: direct.主辦機關,
    承包廠商: winningVendor(rows),
    契約金額: direct.契約金額,
    工程編號: direct.工程編號,
    // 以下三欄只供 SP1B 階段二比對,不進 SP1 的 5 值裁決流程
    決標日期: firstValue(rows, '決標日期'),
    履約地點: parseVenue(firstValue(rows, '履約地點')),
    履約起迄: parsePeriod(firstValue(rows, '履約起迄日期')),
    // 聯絡資訊只供建立學校/廠商時預填,不進 SP1 的 5 值裁決,也不進 SP1B 的比對
    ...parseContacts(rows),
  };
}

/**
 * 讀檔並解析。上傳走記憶體時直接傳 Buffer,不落地暫存檔。
 * @param {string|Buffer} fileOrBuffer
 * @returns {Promise<{工程名稱, 主辦機關, 承包廠商, 契約金額, 工程編號, 決標日期, 履約地點, 履約起迄}>}
 */
async function readAwardNotice(fileOrBuffer) {
  return parseAwardNotice(await extractRows(fileOrBuffer));
}

module.exports = {
  flattenRows, firstValue, parseAmount, parseVenue, parsePeriod, parseDirectFields, winningVendor, parseContacts, parseAwardNotice, readAwardNotice,
};
