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
const { extractCounty } = require('./org-match');
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

const ALL_LABELS = Object.values(LABELS).flat();

// 只挑「工程名稱/契約金額/契約編號」與「決標/開工/竣工日」這兩組標籤出來獨立判斷,
// 是 2026-08-01 code review 追加實測(對照 docs/samples/開工報告表/ 7 份真實 OCR 輸出、
// 見 task-5-report.md)找出的兩個判別特徵,而非憑空猜的門檻。
const CORE_ANCHORS = ['工程名稱', '契約金額', '契約編號'];
const DATE_FAMILY_LABELS = ['決標日期', ...LABELS.契約規定開工日, ...LABELS.契約規定竣工日];

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

// 判定「是不是開工報告表」只看第 1 頁:24 份實測中,除了不合規格的那幾份,
// 其餘每份的關鍵欄位都落在第 1 頁(後續頁是品管人員登錄表、證書等附件)。
// 若把附件頁也算進來,像「公誠國小-開工資料+公文.pdf」這種公文封面+附件合併
// 上傳的 8 頁 PDF,附件裡剛好也有乾淨的「工程名稱」等標籤,會被誤判成開工報告表
// 本身,反而放過真正該擋下的封面公文(該公文的第 1 頁沒有任何一個已知標籤,
// 也沒有退路句)。
function firstPageLines(pages) {
  const p1 = pages.filter((p) => p && p.page === 1);
  const src = p1.length ? p1 : pages;
  const out = [];
  for (const p of src) for (const l of (p && p.lines) || []) out.push(String(l));
  return out;
}

// 只認「行首」命中,不認整行任意位置命中:「公誠國小」封面公文裡有一句
// 「...契約編號A1150506,依合約...」,契約編號三字埋在句子中間,若整行任意
// 位置都算命中,這種公文夾雜的巧合字串會被誤判成真的表格欄位。
function hasLabelAtLineStart(lines) {
  return lines.some((l) => {
    const s = String(l).trim();
    return ALL_LABELS.some((label) => s.startsWith(label));
  });
}

// 「校園中庭紅磚道路面修復及排水溝設置工程_開工報告表.pdf」(臺中市格式)實測:
// 工程名稱/契約金額/契約編號、署名欄「主辦機關」、「工程地點」全部命中且版面完整,
// 但整份文件沒有「決標日期」,也沒有任何「開工日/竣工日」標籤(連變體都沒有)——
// 這是臺中市簡化格式特有的缺口,不是元長那種只是換了標籤名稱
// (元長仍命中變體標籤「開工日期」)。只在版面看起來完整時才用這條擋,
// 避免誤傷本來就只填了 1、2 個欄位的正常案例或最小化的測試 fixture。
function looksComplete(lines) {
  const anchorHits = CORE_ANCHORS.filter((label) => lines.some((l) => l.includes(label))).length;
  return anchorHits >= 2
    && lines.some((l) => l.includes('主辦機關'))
    && lines.some((l) => l.includes('工程地點'));
}

function missingDateFamily(lines) {
  return !DATE_FAMILY_LABELS.some((label) => lines.some((l) => l.includes(label)));
}

/**
 * 是否具備開工報告表的痕跡(只看第 1 頁):版面完整卻整組決標/開工/竣工日標籤
 * 缺席 → 直接判定不是;否則命中任一已知標籤(行首),或退路句本身可解出日期,
 * 即視為開工報告表。
 *
 * **已知殘留缺口**(2026-08-01 code review 追加實測,見 task-5-report.md):
 * 「大勇廁所開工報告及相關文件.pdf」第 1 頁整份 OCR 只剩一句退路句
 * 「...上項工程於民國115年1月26日正式開工」,沒有任何一個標籤命中——這與
 * 「敘述句 fallback 可命中開工日」測試的 fixture 是完全同型的輸入(純退路句、
 * 無任何標籤),而退路句依規格必須單獨足以放行,故無法僅憑文字內容把兩者分開。
 * 目前仍會放行;因為沒有任何欄位標籤命中,除了「契約規定開工日」外其餘欄位會
 * 全部是 null,不會有「硬湊出一個看似正確實則錯誤的值」的風險,但仍是已知限制。
 */
function looksLikeKickoffReport(page1Lines) {
  if (looksComplete(page1Lines) && missingDateFamily(page1Lines)) return false;
  if (hasLabelAtLineStart(page1Lines)) return true;
  return startDateFallback(page1Lines) != null;
}

/**
 * 從 OCR 輸出抽 8 欄。**逐欄取兩解析度的聯集**:任一讀到即採用,先命中者優先。
 * 只跑單一解析度會少 5 個百分點,且改善非單調(每份文件最佳解析度不同)。
 *
 * @param {{pages: Array<{page:number,width:number,lines:string[]}>}} ocrOutput
 * @returns {object} 8 欄;讀不到的一律 null
 * @throws {Error} code 'NOT_KICKOFF_REPORT' —— 第 1 頁缺少任何已知欄位標籤與退路句,
 *   或版面完整卻整組決標/開工/竣工日標籤缺席(臺中市簡化格式的已知樣態)
 */
function extractFields(ocrOutput) {
  const pages = (ocrOutput && ocrOutput.pages) || [];
  const allLines = [];
  for (const p of pages) for (const l of (p && p.lines) || []) allLines.push(String(l));

  if (!looksLikeKickoffReport(firstPageLines(pages))) {
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
