/**
 * doc-convert.js — Word 文件 → PDF。純基礎設施,不懂業務。
 *
 * ## 為什麼需要這一層
 *
 * 開工報告表有相當比例是 Word 檔而不是 PDF,其中舊版 `.doc`(Word 97-2003)是
 * **OLE2 複合文件**,與 `.docx`(zip + XML)是完全不同的格式,沒有可靠的純 JS
 * 讀法。而下游 `readKickoffReport` 吃的是 PDF 路徑(要走 OCR 拿座標)。
 *
 * 用 Word COM 轉檔:與 template-engine 用 Excel COM 同一個理由——這台機器上
 * 本來就有 Office,轉出來的版面與承辦人看到的完全一致,不必賭第三方轉檔器
 * 對表格的還原度(而版面正是 SP1B 座標配對的依據,見 sp1b-ocr-geometry)。
 *
 * ⚠️ **中文路徑會讓 Word COM 找不到檔**(PS 5.1 下的編碼問題,見 doc-to-pdf.ps1
 * 的註解)。故輸入輸出一律用 ASCII 暫存檔名,呼叫端不必自己處理。
 *
 * Exports:
 *   isWordFile(name)              副檔名是不是 .doc/.docx/.odt
 *   convertToPdf(buffer, name)    → Promise<Buffer>(PDF 內容)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// Word COM 轉檔實測數秒;取 120 秒為上限,與 OCR driver 同一個量級。
const TIMEOUT_MS = 120000;

let seq = 0;

/**
 * 副檔名是不是 Word COM 開得起來的文件檔。
 *
 * **`.odt` 也算**:承辦人手上真的有 LibreOffice 存的 OpenDocument
 * (`模板\DEBUG專用` 14 份裡就有 2 份),Word 開得起來、轉出來的 PDF 也讀得到
 * (實測 5 欄與 8 欄)。不認的話它會被當成 PDF 直接餵給 OCR,
 * 前端收到的是「OCR 全部解析度皆失敗」——**訊息在騙人**,承辦人會去查掃描品質,
 * 而真正的原因是根本沒轉檔。
 */
const isWordFile = (name) => /\.(docx?|odt)$/i.test(String(name || ''));

// Windows PowerShell 5.1(非 pwsh 7)。同 template-engine.js / ocr/index.js 的理由:
// COM 型別只在 5.1 下載得動。三處各一份是刻意的,不為此建共用模組讓各層互相依賴。
function powershell51() {
  return path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// 落一支 .ps1 用 -File 呼叫,不用 -Command 內嵌腳本:`-Command` 不做 param 綁定,
// 傳進去的 -In/-Out 會被當成腳本文字的一部分,Word 收到空路徑後直接失敗
// (症狀是「轉換失敗」但看不出為什麼)。同 ocr-driver.ps1 / excel-com-driver.ps1 的慣例。
const DRIVER = path.join(__dirname, 'doc-convert.ps1');

/**
 * Word buffer → PDF buffer。
 *
 * @param {Buffer} buffer 上傳的 .doc/.docx 內容
 * @param {string} originalName 原始檔名(只用來取副檔名)
 * @returns {Promise<Buffer>} PDF 內容
 * @throws {Error} Word 不可用或轉檔失敗;訊息不含伺服器路徑,呼叫端可直接回前端
 */
function convertToPdf(buffer, originalName) {
  // 副檔名要照原樣落檔:Word 靠它決定用哪個轉換器,.odt 存成 .doc 會開不起來。
  const m = String(originalName || '').match(/\.(docx|odt)$/i);
  const ext = m ? `.${m[1].toLowerCase()}` : '.doc';
  const base = path.join(os.tmpdir(), `pmis-doc-${process.pid}-${++seq}`);
  const inPath = base + ext;      // ASCII 檔名:中文路徑 Word COM 開不起來
  const outPath = base + '.pdf';
  fs.writeFileSync(inPath, buffer);

  return new Promise((resolve, reject) => {
    execFile(powershell51(),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DRIVER, '-In', inPath, '-Out', outPath],
      { timeout: TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        try {
          if (err) {
            // 細節只留 server log:訊息可能含伺服器路徑,不該回給前端;
            // 但也不能整個吞掉,那會讓「轉換失敗」變成無法診斷的黑盒。
            console.error('[doc-convert] Word 轉檔失敗:', String(stderr || err.message).slice(0, 500));
            reject(new Error('Word 檔轉換失敗,請改上傳 PDF'));
            return;
          }
          if (!fs.existsSync(outPath)) {
            reject(new Error('Word 檔轉換後找不到 PDF,請改上傳 PDF'));
            return;
          }
          resolve(fs.readFileSync(outPath));
        } finally {
          // 兩個暫存檔都要清:失敗路徑若不清,每次失敗都留一份在 temp。
          for (const f of [inPath, outPath]) {
            try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
          }
        }
      });
  });
}

module.exports = { isWordFile, convertToPdf };
