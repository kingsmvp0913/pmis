#!/usr/bin/env node
/**
 * fetch-ocr-models.js — 取得 PP-OCRv5 的 ONNX 模型與字典
 *
 * 三個檔約 20MB,放 `data/ocr-models/`(env `OCR_MODEL_DIR` 覆寫)。
 * **不進版控**:本專案的慣例是大二進位不版控(見 docs/samples/.gitignore),
 * 而 data/ 已在 .gitignore 內。
 *
 * 這是**安裝期**的一次性下載,不是執行期依賴:模型就位後 OCR 完全離線。
 * 沒下載成功也不會壞——`ocr/index.js` 會退回 Windows 內建 OCR,只是辨識率較差。
 *
 * 用法:node app/scripts/fetch-ocr-models.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { modelDir, modelPaths } = require('../server/ocr/paddle-engine');

const BASE = 'https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main';
const DICT_BASE = 'https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main';

const SOURCES = {
  detection: `${BASE}/detection/PP-OCRv5_mobile_det_infer.onnx`,
  recognition: `${BASE}/recognition/PP-OCRv5_mobile_rec_infer.onnx`,
  charactersDictionary: `${DICT_BASE}/recognition/ppocrv5_dict.txt`,
};

// GitHub 的 media/raw 都會跨主機轉址,不跟就只拿到一個 302 的空檔。
function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('轉址次數過多'));
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} — ${url}`));
      }
      // 先寫到 .part 再改名:中途斷線留下的半截檔會讓下次啟動誤判成「模型已就位」。
      const tmp = `${dest}.part`;
      const file = fs.createWriteStream(tmp);
      res.pipe(file);
      file.on('finish', () => file.close(() => {
        fs.renameSync(tmp, dest);
        resolve();
      }));
      file.on('error', (err) => { fs.unlink(tmp, () => reject(err)); });
    }).on('error', reject);
  });
}

async function main() {
  const dir = modelDir();
  const targets = modelPaths();
  fs.mkdirSync(dir, { recursive: true });
  console.log(`=== 取得 PP-OCRv5 模型 → ${dir} ===`);
  for (const [key, dest] of Object.entries(targets)) {
    if (fs.existsSync(dest)) {
      console.log(`[跳過] 已存在 ${path.basename(dest)}`);
      continue;
    }
    console.log(`[下載] ${path.basename(dest)} …`);
    await download(SOURCES[key], dest);
    console.log(`[OK]   ${path.basename(dest)} ${(fs.statSync(dest).size / 1048576).toFixed(1)} MB`);
  }
  console.log('模型就位,OCR 將改用 PP-OCRv5(離線,不再連外)。');
}

if (require.main === module) {
  main().catch((err) => {
    // 失敗不是致命的:退回 Windows OCR 仍可運作,只是辨識率較差。
    console.error(`[FAIL] ${err.message}`);
    console.error('OCR 將沿用 Windows 內建引擎(辨識率較差但可用)。');
    process.exit(1);
  });
}

module.exports = { SOURCES, download, main };
