/**
 * kickoff-report.js — 開工報告表的欄位抽取(懂開工報告表,不懂 PMIS)
 *
 * 吃 ocr/index.js 的輸出形狀,吐 8 欄候選值。**只作預填,不作裁決**:
 * 逐欄辨識率 77%、契約工期僅 46%,讀不到一律留 null,由承辦人逐欄確認。
 *
 * 24 份實測:標籤統一(21/24 完全一致)但版面不統一,OCR 按視覺行掃描會把
 * 標籤欄與值欄打散,故同列取不到時要往下一列找。
 *
 * Exports:
 *   LABELS                   欄位 → 標籤候選(含變體)
 *   extractFields(ocrOutput) 純函式 → 8 欄
 *   readKickoffReport(path)  跑 OCR 後抽欄位(薄 IO 層)
 */
const { rocToISO, parseMoney, parseDuration } = require('./kickoff-values');
const { normalizeOrgName, extractCounty } = require('./org-match');
const { ocrPdf } = require('./ocr');

// 標籤候選。變體只有元長廁所一份使用(`契約約定工期`/`開工日期`),
// 納入是補完整性、不是提辨識率——別再為此反覆調整(見 memory kickoff-report-ocr-findings)。
const LABELS = {
  工程名稱: ['工程名稱'],
  契約編號: ['契約編號'],
  契約金額: ['契約金額'],
  決標日期: ['決標日期'],
  契約工期: ['契約規定工期', '契約約定工期'],
  主辦機關: ['主辦機關'],
  工程地點: ['工程地點'],
  契約規定開工日: ['契約規定開工日', '開工日期'],
  契約規定竣工日: ['契約規定竣工日', '竣工日期'],
};

// 判斷一份文件「是不是開工報告表」:只要命中任一已知標籤(不分欄位),
// 或「正式開工」退路句本身可解出日期,即視為開工報告表——24 份實測中
// 3 份公文體/他縣市格式兩者皆無,其餘每份至少命中其中一種。
// 兩者皆無才 throw,硬湊欄位會讓承辦人以為系統看懂了,實際比對的是別份文件的內容。
const ALL_LABELS = Object.values(LABELS).flat();

// 值前後常黏著冒號、全形冒號與定位符號,一併清掉再判空。
function cleanValue(s) {
  const v = String(s == null ? '' : s).replace(/^[\s:：.、]+/, '').trim();
  return v === '' ? null : v;
}

/**
 * 在一組文字行中找某標籤的值。先看同列(標籤之後的剩餘文字),
 * 同列無值再取下一列 —— OCR 會把表格的標籤欄與值欄打散成兩行。
 * @returns {string|null}
 */
function findByLabels(lines, labels) {
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || '');
    for (const label of labels) {
      const at = line.indexOf(label);
      if (at === -1) continue;
      const sameRow = cleanValue(line.slice(at + label.length));
      if (sameRow) return sameRow;
      // 同列無值:下一列若本身不是另一個標籤,即視為值
      const next = cleanValue(lines[i + 1]);
      if (next && !isAnyLabel(next)) return next;
    }
  }
  return null;
}

// 下一列若以任何已知標籤開頭,那是相鄰欄位而非本欄的值。
function isAnyLabel(s) {
  return Object.values(LABELS).some((ls) => ls.some((l) => String(s).startsWith(l)));
}

// 幾乎每份都有「本工程定於中華民國○○○年○月○日正式開工」,
// 實測與「契約規定開工日」一致,是標籤抓不到時的唯一退路。
function startDateFallback(lines) {
  for (const line of lines) {
    if (!/正式開工|開工典禮|開工日/.test(String(line))) continue;
    const iso = rocToISO(line);
    if (iso) return iso;
  }
  return null;
}

// 是否具備開工報告表的痕跡:命中任一已知標籤,或退路句可解出日期。
function looksLikeKickoffReport(allLines) {
  if (allLines.some((l) => ALL_LABELS.some((label) => l.includes(label)))) return true;
  return startDateFallback(allLines) != null;
}

/**
 * 從 OCR 輸出抽 8 欄。**逐欄取兩解析度的聯集**:任一讀到即採用,先命中者優先。
 * 只跑單一解析度會少 5 個百分點,且改善非單調(每份文件最佳解析度不同)。
 *
 * @param {{pages: Array<{page:number,width:number,lines:string[]}>}} ocrOutput
 * @returns {object} 8 欄;讀不到的一律 null
 * @throws {Error} code 'NOT_KICKOFF_REPORT' —— 完全沒有已知標籤,也沒有退路句可解出日期
 */
function extractFields(ocrOutput) {
  const pages = (ocrOutput && ocrOutput.pages) || [];
  const allLines = [];
  for (const p of pages) for (const l of (p && p.lines) || []) allLines.push(String(l));

  if (!looksLikeKickoffReport(allLines)) {
    const err = new Error('此檔無法辨識為開工報告表(缺少任何已知欄位標籤與退路句),請確認上傳的是開工報告表');
    err.code = 'NOT_KICKOFF_REPORT';
    throw err;
  }

  // 逐頁逐解析度找,先命中者保留 —— pages 依 widths 順序推入,
  // 故 2200px 的結果優先,3400px 只補其未命中的欄位。
  const raw = {};
  for (const key of Object.keys(LABELS)) {
    for (const p of pages) {
      if (raw[key]) break;
      raw[key] = findByLabels((p && p.lines) || [], LABELS[key]);
    }
    if (!raw[key]) raw[key] = null;
  }

  const 開工日 = rocToISO(raw.契約規定開工日) || startDateFallback(allLines);

  return {
    工程名稱: raw.工程名稱,
    契約編號: raw.契約編號,
    契約金額: parseMoney(raw.契約金額),
    決標日期: rocToISO(raw.決標日期),
    契約工期: parseDuration(raw.契約工期),
    主辦機關: raw.主辦機關,
    // 工程地點有街道與校名兩種寫法,只能抽開頭縣市(spec §5.2)
    縣市: extractCounty(raw.工程地點),
    契約規定開工日: 開工日,
    契約規定竣工日: rocToISO(raw.契約規定竣工日),
  };
}

/**
 * 跑 OCR 後抽欄位。薄薄一層 IO。
 * @param {string} pdfPath
 * @returns {Promise<object>}
 */
async function readKickoffReport(pdfPath) {
  return extractFields(await ocrPdf(pdfPath));
}

module.exports = { LABELS, extractFields, readKickoffReport };
