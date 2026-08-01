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

// 這些是真實 OCR 常見、但不在我們 9 個欄位裡的「其他標題/標籤殘片」——
// 2026-08-02 code review 追加實測(對照 5 份真實 OCR 輸出,見 task-5-report.md)發現
// 表格常把好幾個標籤擠成一列、值又擠成另一列(如「監造單位/主辦機關/提報單位」
// 三個標題連在一起,值另外一列),原本 `isAnyLabel` 只認自己 9 個欄位的標籤字串,
// 遇到「提報單位」這種沒列進 LABELS 的標題會誤判成值——這正是「學校」欄位抽到
// 「提報單位」四個字的根因。把這些已知的標題殘片也算進「不是值」的清單。
const NON_VALUE_CAPTIONS = [
  '監造單位', '提報單位', '承包廠商', '廠商名稱', '備註',
  '檢附相關', '文件', '開工時程', '工期', '訂約日期',
  '機關通知開工', '開工前協調會', '開工前協調', '之發文日期',
  '會議日期', '議日期', '填表日期', '契約規定', '契約約定',
];

// 值前後常黏著冒號、全形冒號與定位符號,一併清掉再判空;整個值被「()」或「（）」
// 包住是署名欄(如「(呂罡銘建築師事務所)」)的常見寫法,連括號一併拆掉。
function cleanValue(s) {
  let v = String(s == null ? '' : s).replace(/^[\s:：.、]+/, '').trim();
  const m = /^[（(](.*)[)）]$/.exec(v);
  if (m) v = m[1].trim();
  return v === '' ? null : v;
}

// 工程名稱真正的值一定帶專案性質字眼;純機關/學校名稱(如「雲林縣元長鄉元長
// 國民小學」)常常混在旁邊(它是工程地點或主辦機關的值),不能直接當工程名稱收下。
const PROJECT_NAME_KEYWORDS = ['工程', '整修', '新建', '拆除', '改善', '修繕', '興建', '計畫'];
// 主辦機關在這批樣本裡永遠是學校。
const SCHOOL_NAME_MARKERS = ['國小', '國中', '小學', '中學'];

// OCR 對中文會逐字插空格(「1 1 5 年」),比對日期形態前一律先清掉空白,
// 否則「115 年 03 月 12 日」測不出是日期,型別把關就形同虛設。
function looksLikeRocDate(s) {
  const stripped = String(s).replace(/[\s　]/g, '');
  return /(\d{1,3})[/年\-.](\d{1,2})[/月\-.](\d{1,2})/.test(stripped);
}

// 只有這 4 個欄位有型別把關,才允許往同方向跳過「已知非值標題」繼續找
// (如元長的契約編號要跳過中間夾的契約金額值本身沒有標題可跳,但主辦機關
// 要跳過「監造單位/提報單位」兩個標題才碰得到校名)。其餘欄位(決標日期、
// 契約規定開工日/竣工日、工程地點、契約工期)沒有型別把關,同形態的候選值
// (例如南陽「決標日期」隔壁跳過兩個標題後會先碰到的其實是「之發文日期」
// 的值,兩者都是合法日期,型別測不出差別)一律只看緊鄰那一行,不跨標題找,
// 避免抓到別的欄位的值卻沒有任何把關能擋下來(見 task-5-report.md)。
const SKIPPABLE_FIELDS = new Set(['工程名稱', '契約編號', '契約金額', '主辦機關']);
const MAX_LABEL_SKIP = 3;

/**
 * 型別把關:抽到的候選值形態明顯不對就當沒抽到,不硬收——錯值比空值傷害大
 * (見 task-5-report.md 元長廁所實測:工程名稱被學校名稱頂替、契約編號被
 * 契約金額頂替、主辦機關直接抽到隔壁標籤「提報單位」四個字)。
 * 其餘欄位(工程地點、日期類、契約工期)交給下游 `extractCounty`／`rocToISO`／
 * `parseDuration` 自然把關,這裡不重複判斷。
 * @returns {boolean}
 */
function isPlausibleValue(fieldKey, s) {
  switch (fieldKey) {
    case '工程名稱':
      return s.length >= 5 && PROJECT_NAME_KEYWORDS.some((k) => s.includes(k));
    case '契約編號':
      return !/[一-鿿]/.test(s) && /\d/.test(s) && s.length <= 20;
    case '契約金額':
      // 不能只看「有沒有連續數字」——契約編號(如「A1150608」)本身就有一長串
      // 數字,單看數字長度會把契約編號誤收成金額(見 task-5-report.md 大美實測)。
      // 金額一定有「元」、千分位逗號分組,或國字大寫數字這三種標記之一。
      return !looksLikeRocDate(s)
        && (/元/.test(s) || /\d{1,3}(,\d{3})+/.test(s)
          || /[零〇一壹二貳兩三叁參四肆五伍六陸七柒八捌九玖十拾百佰千仟萬万億]/.test(s));
    case '主辦機關':
      return SCHOOL_NAME_MARKERS.some((k) => s.includes(k));
    default:
      return true;
  }
}

/**
 * 在一組文字行中找某標籤的值。先看同列(標籤之後的剩餘文字),同列無值再
 * 往下一行找;只有 SKIPPABLE_FIELDS 這 4 個有型別把關的欄位才會再往上一行找
 * (見 task-5-report.md 元長廁所:工程名稱/契約編號的值印在標籤「上面」那一列)。
 * 其餘欄位不查上一行——「決標日期」與「契約規定開工日/竣工日」這類標籤常常
 * 緊鄰成對(如元長的「竣工日期/開工日期」兩個標籤緊挨著),往上一行只會抓到
 * 隔壁那個日期欄位自己的值,兩者形態相同,型別把關测不出來,查了反而更危險。
 * 找到的候選只有通過型別檢查才收,型別不對就當這個方向沒找到——
 * 不再繼續往同方向猜,猜錯比留白傷害更大。
 * @returns {string|null}
 */
function findByLabels(lines, labels, fieldKey) {
  const canGoBackward = SKIPPABLE_FIELDS.has(fieldKey);
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || '');
    for (const label of labels) {
      const at = line.indexOf(label);
      if (at === -1) continue;
      const sameRow = cleanValue(line.slice(at + label.length));
      if (sameRow && isPlausibleValue(fieldKey, sameRow)) return sameRow;
      const forward = scanForValue(lines, i + 1, 1, fieldKey);
      if (forward) return forward;
      if (canGoBackward) {
        const backward = scanForValue(lines, i - 1, -1, fieldKey);
        if (backward) return backward;
      }
    }
  }
  return null;
}

// 往指定方向逐行找值:空白行一律跳過。遇到已知的「非值」標題
// (本欄位與其他欄位的標籤、NON_VALUE_CAPTIONS 的標題殘片)時,
// 只有 SKIPPABLE_FIELDS 這 4 個有型別把關的欄位才繼續往同方向跳過
// (上限 MAX_LABEL_SKIP 行),其餘欄位遇到標題就直接判定這個方向找不到。
// 停在第一個非標題行,只有通過型別檢查才採用,型別不合就視為找不到,
// 不再繼續往同方向猜——猜錯比留白傷害更大。
function scanForValue(lines, start, step, fieldKey) {
  const canSkipLabels = SKIPPABLE_FIELDS.has(fieldKey);
  let i = start;
  let skipped = 0;
  while (i >= 0 && i < lines.length) {
    const s = cleanValue(lines[i]);
    if (!s) { i += step; continue; }
    if (isAnyLabel(s)) {
      if (!canSkipLabels || skipped >= MAX_LABEL_SKIP) return null;
      skipped += 1;
      i += step;
      continue;
    }
    return isPlausibleValue(fieldKey, s) ? s : null;
  }
  return null;
}

// 是否為「非值」的標題/標籤殘片:含本欄位與其他 8 個欄位的標籤,
// 也含 NON_VALUE_CAPTIONS 這份從真實 OCR 收集來的其他標題清單。
function isAnyLabel(s) {
  const str = String(s);
  if (ALL_LABELS.some((l) => str.startsWith(l))) return true;
  return NON_VALUE_CAPTIONS.some((l) => str.startsWith(l));
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

// 契約工期常埋在句子裡,不是乾淨的「標籤:數字」形態(大美是「機關通知日起
// 90日曆天竣工」;台西/明禮則是「契約規定工期」標籤本身被 OCR 拆成
// 「契約規定」/「工期」兩截,永遠對不上 LABELS.契約工期 的完整字串)。
// 標籤路徑找不到時,退而在全文找含「日曆天」或「工作天」且能被 parseDuration
// 解出天數的那一行——parseDuration 本身已有型別把關(如南陽的 `_J50_` 會被
// 擋下),這裡不重複判斷,只借用它驗證候選行是否可信。
function durationSentenceFallback(lines) {
  for (const line of lines) {
    const s = String(line);
    if (!/日曆天|工作天/.test(s)) continue;
    if (parseDuration(s).天數 != null) return s;
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
      raw[key] = findByLabels((p && p.lines) || [], LABELS[key], key);
    }
    if (!raw[key]) raw[key] = null;
  }
  if (!raw.契約工期) raw.契約工期 = durationSentenceFallback(allLines);

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
