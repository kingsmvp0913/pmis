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

module.exports = { extractPages };
