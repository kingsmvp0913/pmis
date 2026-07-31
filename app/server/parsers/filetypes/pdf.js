/**
 * filetypes/pdf.js — 共用 PDF 檔型讀取器
 *
 * 各廠商 PDF 讀取器共用此工具:以 pdf-parse 抽出「每頁純文字」。
 * 回傳陣列每元素 { page, text },page 為 1-based 頁碼,text 為該頁文字。
 *
 * 文字一律做 Unicode NFKC 正規化:金大等 PDF 的 CID 字型會把部分漢字
 * (如「年」)映到 CJK 相容區(U+F9xx)碼位,NFKC 可還原成標準漢字,
 * 讓下游用一般漢字錨點(年/月/日/累計…)比對即可。
 *
 * Exports:
 *   extractPages(filePath) -> Promise<Array<{ page:number, text:string }>>
 *   rowsFromItems(items)   -> Array<{label,value}>(純函式,供兩欄表版面用)
 *   extractRows(fileOrBuffer) -> Promise<Array<{page, rows:[{label,value}]}>>
 */
const fs = require('fs');
const pdf = require('pdf-parse');

// 自訂 pagerender:依文字 item 的 y 座標(transform[5])換行,逐頁還原成
// 貼近版面的多行文字(pdf-parse 預設會把整份併成一坨,難以逐頁切)。
// 用 pdf-parse@1(純 CJS,無 ESM 動態 import),於 Jest VM 下亦可正常載入。
function renderPage(pages) {
  return function (pageData) {
    return pageData
      .getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
      .then((tc) => {
        let lastY = null;
        let text = '';
        for (const item of tc.items) {
          const y = item.transform[5];
          if (lastY !== null && lastY !== y) text += '\n';
          text += item.str;
          lastY = y;
        }
        pages.push(text);
        return text;
      });
  };
}

/**
 * 抽出 PDF 每頁文字(NFKC 正規化)。
 * @param {string} filePath PDF 絕對或相對路徑
 * @returns {Promise<Array<{page:number, text:string}>>}
 */
async function extractPages(filePath) {
  const buffer = fs.readFileSync(filePath);
  const pages = [];
  await pdf(buffer, { pagerender: renderPage(pages) });
  return pages.map((text, i) => ({
    page: i + 1,
    text: String(text || '').normalize('NFKC'),
  }));
}

// ── 兩欄表版面(如政府電子採購網決標公告「友善列印」)──
// 版面固定:x<45 為區塊名直排字(機/關/資/料)、45≤x<130 為標籤欄、x≥130 為值欄。
// 同一列的標籤與值 y 座標會差 1~3px,故以容差分組而非精確相等。
const BLOCK_MAX_X = 45;
const LABEL_MAX_X = 130;
const Y_TOLERANCE = 3;

// 決標公告 PDF 的內嵌字型 ToUnicode CMap 把下列漢字誤映到 CJK 部首補充區
// (U+2E80–U+2EFF),而非標準統一漢字。NFKC 對這個區塊沒有相容分解(它只
// 還原得了 U+F9xx 相容漢字),不額外映射的話,這些字下游與專案主檔
// (schools.name / projects.name,皆為標準碼位)逐字比對會誤判成不一致——
// 28 份樣本實測「民」(U+2EA0)每一份的主辦機關都出現,不修等於硬擋機制
// 形同虛設。僅列實測到的 3 個字,其餘部首補充區字元未實測到問題,不補。
const CJK_RADICAL_FIXUPS = {
  '⺠': '民', // 民
  '⻑': '長', // 長
  '⻄': '西', // 西
};

function fixCjkRadicals(s) {
  let out = s;
  for (const [bad, good] of Object.entries(CJK_RADICAL_FIXUPS)) {
    out = out.split(bad).join(good);
  }
  return out;
}

/**
 * 由單頁 text item 座標陣列建「標籤/值」列。純函式,不碰檔案系統。
 *
 * NFKC 正規化後再做 CJK 部首補充區誤映還原(見 CJK_RADICAL_FIXUPS),
 * 修正決標公告字型的已知缺陷。
 *
 * @param {Array<{x:number,y:number,s:string}>} items
 * @returns {Array<{label:string,value:string}>} 由上而下
 */
function rowsFromItems(items) {
  const buckets = [];
  // 先依 y 由大到小排序再分組:bucket 錨點取自「第一個放入的 item」,
  // 若不先排序,items 原始順序不同(如 y 鏈狀相近的 415/413/411/409,
  // 兩兩在容差內但總跨距超過容差)會導致分出不同列數,結果不穩定。
  const ordered = (items || []).slice().sort((a, b) => b.y - a.y);
  for (const it of ordered) {
    if (!String(it.s == null ? '' : it.s).trim()) continue;
    let b = buckets.find((k) => Math.abs(k.y - it.y) <= Y_TOLERANCE);
    if (!b) {
      b = { y: it.y, items: [] };
      buckets.push(b);
    }
    b.items.push(it);
  }
  buckets.sort((a, b) => b.y - a.y);
  return buckets.map((b) => {
    const sorted = b.items.slice().sort((p, q) => p.x - q.x);
    const join = (lo, hi) => fixCjkRadicals(sorted
      .filter((i) => i.x >= lo && i.x < hi)
      .map((i) => i.s)
      .join('')
      .normalize('NFKC')
      .trim());
    return { label: join(BLOCK_MAX_X, LABEL_MAX_X), value: join(LABEL_MAX_X, Infinity) };
  });
}

/**
 * 抽出 PDF 每頁的「標籤/值」列。僅適用版面為兩欄表的固定格式文件(決標公告);
 * 自由文字 PDF 請用 extractPages。
 *
 * @param {string|Buffer} fileOrBuffer 檔案路徑或已讀入的內容(上傳走記憶體不落地)
 * @returns {Promise<Array<{page:number, rows:Array<{label,value}>}>>}
 */
async function extractRows(fileOrBuffer) {
  const buffer = Buffer.isBuffer(fileOrBuffer) ? fileOrBuffer : fs.readFileSync(fileOrBuffer);
  const pages = [];
  await pdf(buffer, {
    pagerender: (pageData) => pageData
      .getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
      .then((tc) => {
        pages.push(tc.items.map((it) => ({ x: it.transform[4], y: it.transform[5], s: it.str })));
        return '';
      }),
  });
  return pages.map((items, i) => ({ page: i + 1, rows: rowsFromItems(items) }));
}

module.exports = { extractPages, rowsFromItems, extractRows };
