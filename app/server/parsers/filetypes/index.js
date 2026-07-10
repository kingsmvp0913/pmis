/**
 * filetypes/index.js — 檔型共用工具彙整(注入用)
 *
 * registry 於載入讀取器時,把本檔的 exports 當 `ctx.filetypes` 注入給讀取器的
 * parse(filePath, ctx) / parseAll(filePath, ctx)。讀取器一律透過
 * `ctx.filetypes.<fn>` 取用檔型工具,**不得自己 require 檔型檔或摸路徑**
 * (禁 process.cwd()/寫死 app 路徑)。這樣裝到 data/vendor-parsers/ 的讀取器
 * 也能用,不依賴 app 原始碼佈局。
 *
 * re-export:
 *   來自 pdf.js  :extractPages
 *   來自 xlsx.js :readWorkbook, readSheet, gridFromWorksheet,
 *                 colToIndex, indexToCol, excelSerialToISO
 */
const { extractPages } = require('./pdf');
const {
  readWorkbook,
  readSheet,
  gridFromWorksheet,
  colToIndex,
  indexToCol,
  excelSerialToISO,
} = require('./xlsx');

module.exports = {
  extractPages,
  readWorkbook,
  readSheet,
  gridFromWorksheet,
  colToIndex,
  indexToCol,
  excelSerialToISO,
};
