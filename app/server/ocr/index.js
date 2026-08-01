/**
 * ocr/index.js — PDF 轉文字(Windows 內建 OCR)。純基礎設施,不懂業務。
 *
 * 走 Windows.Data.Pdf + Windows.Media.Ocr,零安裝成本、不連外。
 * WinRT 型別只在 Windows PowerShell 5.1 下載得動(PS 7 會 "Unable to find type"),
 * 故由 Node spawn 5.1 驅動 —— 與 template-engine.js 同一條路。
 *
 * Exports:
 *   DEFAULT_WIDTHS        [2200, 3400](spec §3.5 實測;不得加第三個)
 *   collapseCjkSpaces(s)  清掉 CJK 字元之間的空格(OCR 逐字插空格)
 *   ocrPdf(pdfPath, opts) → { pages: [{page, width, lines}], failedPages: [{page, width, error}] }
 */
const path = require('path');
const { execFile } = require('child_process');

const DRIVER = path.join(__dirname, 'ocr-driver.ps1');

// 2200 與 3400 取聯集:實測 72% → 77%。加第三個(1500px)增益為 0、
// 成本卻多 50%,故只跑兩個(spec §3.5)。改善非單調——每份文件最佳解析度不同,
// 這正是取聯集有效的原因。
const DEFAULT_WIDTHS = [2200, 3400];

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
 * 對一份 PDF 跑 OCR。每個解析度各跑一趟,結果**全部回傳、不在此層合併**——
 * 合併規則(逐欄取聯集)屬業務層,基礎設施層不該決定。
 *
 * 單一解析度失敗不讓整趟失敗:兩個解析度本就是為了互補,少一個仍可用;
 * 全部失敗才 throw。同理,單一頁在某個解析度下失敗(driver 端已逐頁 try/catch)
 * 不會拖垮同一趟裡的其他頁——失敗頁的痕跡會出現在 failedPages,不會被靜默吞掉。
 *
 * @param {string} pdfPath 會轉成絕對路徑——WinRT 的 GetFileFromPathAsync 不吃相對路徑
 * @param {{widths?: number[]}} [opts]
 * @returns {Promise<{pages: Array<{page:number, width:number, lines:string[]}>, failedPages: Array<{page:number, width:number, error:string}>}>}
 */
async function ocrPdf(pdfPath, opts) {
  const widths = (opts && opts.widths) || DEFAULT_WIDTHS;
  const abs = path.resolve(pdfPath);
  const all = [];
  const failedPages = [];
  const errors = [];
  for (const w of widths) {
    try {
      const { pages, failedPages: failed } = await spawnDriver(abs, w);
      for (const p of pages) {
        all.push({ page: p.page, width: p.width, lines: (p.lines || []).map(collapseCjkSpaces) });
      }
      failedPages.push(...failed);
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (all.length === 0) throw new Error(`OCR 全部解析度皆失敗:${errors.join(' / ')}`);
  return { pages: all, failedPages };
}

module.exports = { DEFAULT_WIDTHS, collapseCjkSpaces, ocrPdf };
