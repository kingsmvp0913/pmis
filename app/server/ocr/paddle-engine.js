/**
 * paddle-engine.js — PP-OCRv5(ONNX)辨識引擎。純基礎設施,不懂業務。
 *
 * ## 為什麼多一個引擎
 *
 * Windows 內建 OCR 零安裝、不連外,但辨識率是這條產線的天花板。24 份開工報告表
 * 逐欄實測(真值取自決標公告,對/錯/漏):
 *
 * | 引擎 | 對 | 錯 | 漏 | 每頁 |
 * |---|---|---|---|---|
 * | Windows(2200+3400 聯集) | 160 | 13 | 25 | 16.3s |
 * | **PP-OCRv5 mobile(單跑 3400)** | **181** | **6** | **20** | **7.4s** |
 *
 * 施工日誌的數字格(饒平 0711A,同檔文字層當答案卷)正確率 51.5% → 88.0%。
 * 「錯」腰斬那一欄比「對」增加更要緊:錯值會變成擋人歸檔的假硬錯。
 *
 * ## 為什麼不做多解析度聯集
 *
 * 現行 Windows 路徑跑 2200+3400 取聯集。那不是為了提高辨識率,是在補 Windows OCR
 * 「每份文件最佳解析度不同」的不穩定。PP-OCRv5 沒有這個毛病,3400 全面壓過其他
 * 解析度,實測聯集**增益為 0**(3400 單跑 181、3400+2200 181、三個都跑 181),
 * 而且把較差的 2200 排前面會讓「先命中者保留」蓋掉正確答案(181 → 179)。
 * 故本引擎只跑一個解析度。
 *
 * ## 相依與退場
 *
 * 三個 npm 套件(pdfium/canvas/ppu-paddle-ocr)與 ~20MB 模型檔都是選配:
 * 任何一項缺席,`isAvailable()` 回 false,`ocr/index.js` 自動退回 Windows driver。
 * 模型放 `data/ocr-models/`(env `OCR_MODEL_DIR` 覆寫),由
 * `app/scripts/fetch-ocr-models.js` 取得——不進版控,與本專案其他大二進位一致。
 *
 * Exports:
 *   DEFAULT_WIDTH   3400(實測最佳;2200 少 6 分、4400 多花 34% 時間換 -2 分)
 *   modelDir()      模型目錄
 *   isAvailable()   相依與模型是否齊備
 *   ocrPdfPaddle(pdfPath, {widths}) → 與 ocr-driver.ps1 相同形狀的 {pages, failedPages}
 */
const fs = require('fs');
const path = require('path');

// 3400 為實測最佳:2200 是 175/7/25、3400 是 181/6/20、4400 是 179/5/23 而且
// 每頁多花 34% 時間。再高會讓字距超出偵測模型的感受野,反而掉。
const DEFAULT_WIDTH = 3400;

const MODEL_FILES = {
  detection: 'PP-OCRv5_mobile_det_infer.onnx',
  recognition: 'PP-OCRv5_mobile_rec_infer.onnx',
  charactersDictionary: 'ppocrv5_dict.txt',
};

function modelDir() {
  return process.env.OCR_MODEL_DIR
    || path.resolve(__dirname, '..', '..', '..', 'data', 'ocr-models');
}

function modelPaths() {
  const dir = modelDir();
  const out = {};
  for (const [k, f] of Object.entries(MODEL_FILES)) out[k] = path.join(dir, f);
  return out;
}

function modelsPresent() {
  return Object.values(modelPaths()).every((p) => fs.existsSync(p));
}

// 三個套件都是選配。require 失敗不得讓整個 server 起不來——OCR 只是其中一條路,
// 缺了就退回 Windows driver。
function deps() {
  try {
    return {
      PDFiumLibrary: require('@hyzyla/pdfium').PDFiumLibrary,
      createCanvas: require('@napi-rs/canvas').createCanvas,
      PaddleOcrService: require('ppu-paddle-ocr').PaddleOcrService,
    };
  } catch {
    return null;
  }
}

function isAvailable() {
  return Boolean(deps()) && modelsPresent();
}

// 模型載入約 2-4 秒,每次呼叫重載會比辨識本身還貴,故整個 process 共用一份。
let servicePromise = null;
function service() {
  if (!servicePromise) {
    const { PaddleOcrService } = deps();
    const svc = new PaddleOcrService({ model: modelPaths() });
    servicePromise = svc.initialize().then(() => svc).catch((err) => {
      servicePromise = null;          // 失敗不留壞掉的 promise,下次可重試
      throw err;
    });
  }
  return servicePromise;
}

let libPromise = null;
function pdfium() {
  const { PDFiumLibrary } = deps();
  if (!libPromise) {
    libPromise = PDFiumLibrary.init().catch((err) => { libPromise = null; throw err; });
  }
  return libPromise;
}

/**
 * pdfium 給的是 BGRA,canvas 的 ImageData 是 RGBA。不換通道整張圖藍紅顛倒,
 * 辨識率會直接掉到地板(而且看不出來是這個原因)。
 */
function bgraToCanvas(createCanvas, data, w, h) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < data.length; i += 4) {
    d[i] = data[i + 2];
    d[i + 1] = data[i + 1];
    d[i + 2] = data[i];
    d[i + 3] = data[i + 3];
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * 對一份 PDF 跑 PP-OCRv5,輸出與 `ocr-driver.ps1` **完全相同的形狀**,
 * 讓 `kickoff-report.js` 與 `parsers/filetypes/pdf.js` 原封不動地吃。
 *
 * @param {string} pdfPath
 * @param {{widths?: number[]}} [opts]
 * @returns {Promise<{pages: Array<object>, failedPages: Array<object>}>}
 */
async function ocrPdfPaddle(pdfPath, opts) {
  const widths = (opts && opts.widths) || [DEFAULT_WIDTH];
  const { createCanvas } = deps();
  const svc = await service();
  const lib = await pdfium();
  const abs = path.resolve(pdfPath);

  const pages = [];
  const failedPages = [];
  const doc = await lib.loadDocument(fs.readFileSync(abs));
  try {
    for (const width of widths) {
      for (let i = 0; i < doc.getPageCount(); i++) {
        const page = doc.getPage(i);
        try {
          const { originalWidth, originalHeight } = page.getOriginalSize();
          const r = await page.render({
            scale: width / originalWidth,
            render: async (o) => o.data,          // 不編碼,直接拿原始點陣
          });
          const res = await svc.recognize(bgraToCanvas(createCanvas, r.data, r.width, r.height));
          const lines = [];
          const boxes = [];
          const words = [];
          // PP-OCR 偵測的是**文字行**,不是字。密集表格裡一格就是一個偵測框,
          // 那正是座標型讀取器要的粒度,故 word 與 line 用同一組框。
          res.lines.flat().forEach((w, li) => {
            const b = {
              x: Math.round(w.box.x), y: Math.round(w.box.y),
              w: Math.round(w.box.width), h: Math.round(w.box.height),
            };
            lines.push(w.text);
            boxes.push(b);
            words.push({ t: w.text, line: li, ...b });
          });
          pages.push({
            page: i + 1,
            width,
            lines,
            boxes,
            words,
            // Windows 的 PdfPage.Size 是 DIP(1/96 吋),下游一律 ×0.75 換成 PDF 點。
            // pdfium 給的就是點,故先換回 DIP —— 兩個 driver 的契約必須一致,
            // 否則座標型讀取器的分帶容差全部錯位。
            pw: Math.round((originalWidth / 0.75) * 100) / 100,
            ph: Math.round((originalHeight / 0.75) * 100) / 100,
            bw: r.width,
            bh: r.height,
          });
        } catch (err) {
          // 單頁失敗(壞掉的內嵌影像等)不得拖垮整份:記下來,繼續下一頁。
          failedPages.push({ page: i + 1, width, error: err.message });
        }
      }
    }
  } finally {
    doc.destroy();
  }
  if (pages.length === 0) {
    throw new Error(`PP-OCRv5 全部頁面皆失敗:${failedPages.map((f) => f.error).join(' / ') || '無可辨識頁面'}`);
  }
  return { pages, failedPages };
}

module.exports = { DEFAULT_WIDTH, modelDir, modelPaths, isAvailable, ocrPdfPaddle };
