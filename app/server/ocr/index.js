/**
 * ocr/index.js — PDF 轉文字。純基礎設施,不懂業務。
 *
 * 兩個引擎,對外只有一個 `ocrPdf`:
 *
 * 1. **PP-OCRv5(`paddle-engine.js`)** —— 優先。24 份開工報告表逐欄實測
 *    對/錯/漏 160/13/25 → 181/6/20,每頁 16.3s → 7.4s;施工日誌數字格
 *    51.5% → 88.0%。相依與模型缺席時自動退場。
 * 2. **Windows 內建 OCR(`ocr-driver.ps1`)** —— 後備。走 Windows.Data.Pdf +
 *    Windows.Media.Ocr,零安裝、不連外。WinRT 型別只在 Windows PowerShell 5.1
 *    下載得動(PS 7 會 "Unable to find type"),故由 Node spawn 5.1 驅動
 *    —— 與 template-engine.js 同一條路。
 *
 * 兩者輸出**同一種形狀**,下游(kickoff-report / parsers/filetypes/pdf)不必知道
 * 是誰讀的。`boxes[i]` 是 `lines[i]` 的外接矩形 {x, y, w, h}(像素,原點左上):
 * 開工報告表是二維表格,而 OCR 的行結果是把它壓成視覺閱讀序的一維序列——同一列的
 * 標籤與值因此被拆到不相鄰的位置,座標是把表格還原回二維的唯一依據。
 *
 * Exports:
 *   WINDOWS_WIDTHS        [2200, 3400] —— 只有後備引擎用
 *   DEFAULT_WIDTHS        目前引擎的預設解析度
 *   activeEngine()        'paddle' | 'windows'
 *   collapseCjkSpaces(s)  清掉 CJK 字元之間的空格(OCR 逐字插空格)
 *   ocrPdf(pdfPath, opts) → { pages: [{page, width, lines, boxes, words, pw, ph, bw, bh}], failedPages }
 */
const path = require('path');
const { execFile } = require('child_process');
const { toTraditional } = require('./variants');
const paddle = require('./paddle-engine');

const DRIVER = path.join(__dirname, 'ocr-driver.ps1');

// Windows OCR 專用。2200 與 3400 取聯集是在補它「每份文件最佳解析度不同」的
// 不穩定,不是普遍有效的手段 —— PP-OCRv5 下同一個聯集**增益為 0**,見
// paddle-engine.js 的說明。故這組數字綁在後備引擎上,不是全域預設。
const WINDOWS_WIDTHS = [2200, 3400];

// 實測 2.5–5 秒 / 2 頁;取 120 秒為單次上限,足以容納多頁掃描件。
const ATTEMPT_TIMEOUT_MS = 120000;

// Windows PowerShell 5.1(非 pwsh 7)。與 template-engine.js:18-21 同一份語意,
// 兩處各一份是刻意的:為此建一支共用模組會讓 OCR 層依賴 Excel 層。
function powershell51() {
  return path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Windows OCR 對中文會逐字插入空格(「工 程 名 稱」),不清掉的話所有標籤都比不中。
 *
 * 只清 CJK↔CJK 之間的空白:數字之間的空白必須留著,'115 06 16' 清成 '1150616'
 * 會讓日期解析錯位;中文與數字交界也保留,以免破壞數字邊界。
 */
function collapseCjkSpaces(s) {
  if (s == null) return '';
  return String(s).replace(/([一-鿿])[ \t　]+(?=[一-鿿])/g, '$1');
}

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// 單次 spawn:一個解析度跑一趟。失敗一律 reject,由呼叫端決定是否降級。
function spawnDriver(pdfPath, width) {
  return new Promise((resolve, reject) => {
    execFile(
      powershell51(),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DRIVER,
        '-PdfPath', pdfPath, '-Width', String(width)],
      { timeout: ATTEMPT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const lines = String(stdout).trim().split(/\r?\n/).filter(Boolean);
        if (err && lines.length === 0) {
          return reject(new Error(`OCR 驅動失敗: ${stderr || err.message}`));
        }
        let result;
        try { result = JSON.parse(lines[lines.length - 1]); }
        catch { return reject(new Error(`無法解析 OCR 驅動輸出:${stdout}\n${stderr}`)); }
        // ok=false 代表這個解析度整趟沒有任何一頁成功(driver 端只在
        // 「全部頁都失敗」時才會這樣回),對呼叫端而言等同這個解析度失敗。
        if (!result.ok) return reject(new Error(result.error || 'OCR 驅動未知錯誤'));
        resolve({ pages: result.pages || [], failedPages: result.failedPages || [] });
      }
    );
  });
}

/**
 * 兩個引擎共用的文字正規化。
 *
 * PS 5.1 的 ConvertTo-Json 會把單元素陣列塌成單一物件,故一律正規化成陣列,
 * 否則只有一行文字的頁面會讓 .map 炸掉。
 * `toTraditional` 吸掉辨識模型零星吐出的簡體字形(見 variants.js):少這一步,
 * 「契約金额」就對不上標籤 `契約金額`,整欄抽不到。
 */
function normalizePage(p) {
  return {
    page: p.page,
    width: p.width,
    lines: toArray(p.lines).map((l) => toTraditional(collapseCjkSpaces(l))),
    boxes: toArray(p.boxes),
    // word 級的框(給座標型讀取器用)與頁面尺寸(像素→點的比例尺)。
    // 行級的框對密集表格沒有用:一行橫跨整列。
    words: toArray(p.words).map((wd) => (wd && wd.t != null ? { ...wd, t: toTraditional(wd.t) } : wd)),
    pw: p.pw,
    ph: p.ph,
    bw: p.bw,
    bh: p.bh,
  };
}

/** 目前實際會用哪個引擎。給呼叫端與診斷頁用,不影響行為。 */
function activeEngine() {
  return paddle.isAvailable() ? 'paddle' : 'windows';
}

/** 目前引擎的預設解析度。PP-OCRv5 只跑一個(聯集增益為 0,見 paddle-engine.js)。 */
function defaultWidths() {
  return paddle.isAvailable() ? [paddle.DEFAULT_WIDTH] : WINDOWS_WIDTHS;
}

// 後備引擎:每個解析度各跑一趟。單一解析度失敗不讓整趟失敗(兩個解析度本就是
// 為了互補,少一個仍可用);全部失敗才 throw。單一頁失敗(driver 端已逐頁
// try/catch)不會拖垮同一趟裡的其他頁——痕跡在 failedPages,不會被靜默吞掉。
async function ocrPdfWindows(abs, widths) {
  const all = [];
  const failedPages = [];
  const errors = [];
  for (const w of widths) {
    try {
      const { pages, failedPages: failed } = await spawnDriver(abs, w);
      for (const p of pages) all.push(normalizePage(p));
      failedPages.push(...failed);
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (all.length === 0) throw new Error(`OCR 全部解析度皆失敗:${errors.join(' / ')}`);
  return { pages: all, failedPages };
}

/**
 * 對一份 PDF 跑 OCR。結果**全部回傳、不在此層合併**——合併規則(逐欄取聯集)
 * 屬業務層,基礎設施層不該決定。
 *
 * 引擎優先 PP-OCRv5;它不可用(套件或模型缺席)時退回 Windows driver。
 * **PP-OCRv5 執行期出錯也退回**:辨識是可降級的,讓一次 ONNX 例外把歸檔流程
 * 整個擋住,比讀得差一點嚴重。退回的痕跡走 console.warn,不靜默。
 *
 * @param {string} pdfPath 會轉成絕對路徑——WinRT 的 GetFileFromPathAsync 不吃相對路徑
 * @param {{widths?: number[], engine?: 'paddle'|'windows'}} [opts]
 * @returns {Promise<{pages: Array<object>, failedPages: Array<object>}>}
 */
async function ocrPdf(pdfPath, opts) {
  const abs = path.resolve(pdfPath);
  const want = (opts && opts.engine) || activeEngine();
  const widths = (opts && opts.widths)
    || (want === 'paddle' ? [paddle.DEFAULT_WIDTH] : WINDOWS_WIDTHS);

  if (want === 'paddle') {
    try {
      const { pages, failedPages } = await paddle.ocrPdfPaddle(abs, { widths });
      return { pages: pages.map(normalizePage), failedPages };
    } catch (err) {
      if (opts && opts.engine) throw err;         // 明確指定引擎就不要偷偷換掉
      console.warn(`[ocr] PP-OCRv5 失敗,退回 Windows OCR:${err.message}`);
      return ocrPdfWindows(abs, WINDOWS_WIDTHS);
    }
  }
  return ocrPdfWindows(abs, widths);
}

module.exports = {
  WINDOWS_WIDTHS, defaultWidths, activeEngine, collapseCjkSpaces, ocrPdf,
};
