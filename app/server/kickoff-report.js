/**
 * kickoff-report.js — 開工報告表的欄位抽取(懂開工報告表,不懂 PMIS)
 *
 * 吃 ocr/index.js 的輸出形狀,吐 9 欄候選值。**只作預填,不作裁決**:
 * 讀不到一律留 null,由承辦人逐欄確認或修正。
 *
 * ## 為何依座標而非行序(2026-08-02 改寫)
 *
 * 開工報告表是二維表格,`OcrResult.Lines` 是把它壓成視覺閱讀序的一維結果——
 * 同一列的標籤與值因此被拆到不相鄰的位置。24 份實測有四種行序樣態
 * (值在標籤下一行 / 上一行 / 同一行 / 標籤與值各自整批堆疊),靠行序猜就得為
 * 每種樣態疊一條啟發式,而它們互相衝突:元長的「工程地點」值在標籤上一行,
 * 南陽的「決標日期」上一行卻是隔壁欄的值,兩者形態相同、型別把關測不出差別。
 *
 * 改看 `boxes[i]`(每行的外接矩形)之後,四種樣態是同一條規則:
 * **值 = 標籤右側、垂直帶重疊、最近的那個文字框**;署名欄則是正下方同欄。
 * 對 24 份樣本、以決標公告為真值的 6 個可判定欄位實測:
 * 正確 47 → 99,且「抓錯格子」的錯值 3 → 0(見 memory sp1b-ocr-geometry-findings)。
 *
 * Exports:
 *   LABELS                   欄位 → 標籤候選(含變體)
 *   extractFields(ocrOutput) 純函式 → 9 欄
 *   readKickoffReport(path)  跑 OCR 後抽欄位(薄 IO 層)
 */
const { rocToISO, parseMoney, parseDuration } = require('./kickoff-values');
const { extractCounty } = require('./org-match');
const { ocrPdf } = require('./ocr');

// 標籤候選。變體只有元長廁所一份使用(`契約約定工期`/`開工日期`/`契約總價`),
// 納入是補完整性、不是提辨識率——別再為此反覆調整(見 memory kickoff-report-ocr-findings)。
//
// 臺中市格式(大勇)另有兩個用詞,兩個都以決標公告驗證過語意等價才收:
//   `承包工程費` → 值 6,319,000,與決標公告的契約金額完全相符
//   `工程期限`   → 值「115 年 8 月 15 日前完工」,與履約起迄的**迄**相符,故掛竣工日
//                  而非契約工期(那格是日期不是天數,掛錯會讓非 null 的垃圾值
//                  擋掉 durationSentenceFallback)
// **`訂約日期` 刻意不收**:大勇表上訂約 114/12/18、決標公告的決標日 114/12/16,
// 實測差 2 天。決標日在 kickoff-compare 是 hard 級,收它等於每份臺中市文件都多
// 一個擋住歸檔的假硬錯。
const LABELS = {
  工程名稱: ['工程名稱'],
  契約編號: ['契約編號'],
  契約金額: ['契約金額', '契約總價', '承包工程費'],
  決標日期: ['決標日期'],
  契約工期: ['契約規定工期', '契約約定工期'],
  主辦機關: ['主辦機關'],
  工程地點: ['工程地點'],
  契約規定開工日: ['契約規定開工日', '開工日期'],
  契約規定竣工日: ['契約規定竣工日', '竣工日期', '工程期限'],
};

const ALL_LABELS = Object.values(LABELS).flat();

// 只挑「工程名稱/契約金額/契約編號」與「決標/開工/竣工日」這兩組標籤出來獨立判斷,
// 是 2026-08-01 code review 追加實測(對照 docs/samples/開工報告表/ 7 份真實 OCR 輸出)
// 找出的兩個判別特徵,而非憑空猜的門檻。
const CORE_ANCHORS = ['工程名稱', '契約金額', '契約編號'];
const DATE_FAMILY_LABELS = ['決標日期', ...LABELS.契約規定開工日, ...LABELS.契約規定竣工日];

// 真實 OCR 常見、但不在我們 9 個欄位裡的「其他標題/標籤殘片」。表格常把好幾個
// 標題排在一起(如「監造單位/主辦機關/提報單位」),不列進來的話,某一欄的值
// 找不到時會誤把隔壁的標題當成值收下。
const NON_VALUE_CAPTIONS = [
  '監造單位', '提報單位', '承包廠商', '廠商名稱', '備註',
  '檢附相關', '文件', '開工時程', '工期', '訂約日期',
  '機關通知開工', '開工前協調會', '開工前協調', '之發文日期',
  '會議日期', '議日期', '填表日期', '契約規定', '契約約定',
];

// 值前後常黏著冒號、全形冒號與定位符號,一併清掉再判空。署名欄的值寫成
// 「(呂罡銘建築師事務所)」,而尾括號常被印章蓋掉導致成對規則不成立,故單邊括號
// 也要清——否則值永遠帶著一個「(」。
function cleanValue(s) {
  let v = String(s == null ? '' : s).replace(/^[\s:：.、]+/, '').trim();
  const m = /^[（(](.*)[)）]$/.exec(v);
  if (m) return m[1].trim() === '' ? null : m[1].trim();
  // 只有在括號**不成對**時才清單邊:印章咬掉右括號會留下「( 雲林縣…國民小」。
  // 無條件清尾括號會誤傷合法值——古坑的工程名稱本身就以「…國小部B棟西側)」結尾。
  if (/^[（(]/.test(v) && !/[)）]/.test(v)) v = v.replace(/^[（(]\s*/, '').trim();
  else if (/[)）]$/.test(v) && !/[（(]/.test(v)) v = v.replace(/\s*[)）]$/, '').trim();
  return v === '' ? null : v;
}

// 工程名稱真正的值一定帶專案性質字眼;純機關/學校名稱常常混在旁邊。
const PROJECT_NAME_KEYWORDS = ['工程', '整修', '新建', '拆除', '改善', '修繕', '興建', '計畫'];
// 主辦機關在這批樣本裡永遠是學校。
const SCHOOL_NAME_MARKERS = ['國小', '國中', '小學', '中學'];

/**
 * 千分位分組。金額與契約編號兩條把關共用同一條——契約編號那條是靠「不像金額」
 * 來排除誤收,兩邊的定義一旦不同步,全形逗號的金額就會被當成契約編號收下。
 *
 * 兩種寬容都是實測逼出來的,而且**都是大勇那一格**:
 * - **逗號兩側的空白**:`collapseCjkSpaces` 刻意只清 CJK 之間的空格(數字間的
 *   空格必須留著,否則 `115 06 16` 會被黏成 `1150616` 讓日期錯位),於是
 *   Windows OCR 讀出來的是「6 , 319 , 000」。
 * - **全形逗號**:換 PP-OCRv5 之後同一格變成「6，319，000」(U+FF0C)。
 *   只認半形的話 `parseMoney` 明明解得出 6319000,卻在型別把關就被判成讀不到
 *   ——**同一格因為兩個不同的原因掉了兩次**。
 */
const 千分位 = /\d{1,3}(\s*[,，]\s*\d{3})+/;

// OCR 對中文會逐字插空格(「1 1 5 年」),比對日期形態前一律先清掉空白,
// 否則「115 年 03 月 12 日」測不出是日期,型別把關就形同虛設。
function looksLikeRocDate(s) {
  const stripped = String(s).replace(/[\s　]/g, '');
  return /(\d{1,3})[/年\-.](\d{1,2})[/月\-.](\d{1,2})/.test(stripped);
}

/**
 * 型別把關:抽到的候選值形態明顯不對就當沒抽到,不硬收。
 *
 * 改用座標配對後這層**更加必要**而非可有可無:座標找對了格子,不代表格子裡的字
 * 沒被毀掉。橋頭/南陽/古坑棒球/四湖跳遠的署名欄尾字被印章蓋掉,OCR 只讀到
 * 「雲林縣麥寮鄉橋頭國民小」;而「學校」在 kickoff-compare 是 hard 級,收下它就
 * 變成擋住歸檔的**假硬錯**,判成讀不到反而不擋人(missing 不進 hardErrors)。
 * @returns {boolean}
 */
function isPlausibleValue(fieldKey, s) {
  switch (fieldKey) {
    case '工程名稱':
      return s.length >= 5 && PROJECT_NAME_KEYWORDS.some((k) => s.includes(k));
    case '契約編號':
      // 24 份樣本的契約編號沒有一個帶千分位逗號或「元」(1150113 / A1150608 /
      // TKPS-A1150603 / ywjh11504 / 114-17 / SH1140006),而金額一定有其中之一。
      // 少了這條,契約編號欄空著時右邊的金額會被當成編號收下——無中文、有數字、
      // 長度也在範圍內,前三個條件全都攔不住。
      return !/[一-鿿]/.test(s) && /\d/.test(s) && s.length <= 20
        && !/元/.test(s) && !千分位.test(s);
    case '契約金額':
      // 不能只看「有沒有連續數字」——契約編號(如「A1150608」)本身就有一長串
      // 數字。金額一定有「元」、千分位逗號分組,或國字大寫數字這三種標記之一。
      // 千分位要容忍逗號兩側的空白:collapseCjkSpaces 刻意只清 CJK 之間的空格
      // (數字間的空格必須留著,否則 '115 06 16' 會被黏成 '1150616' 讓日期錯位),
      // 於是 OCR 讀到的金額長成「6 , 319 , 000」。不容忍的話 parseMoney 明明解得出
      // 6319000,卻在這一關就被判成讀不到——大勇的契約金額正是這樣掉的。
      return !looksLikeRocDate(s)
        && (/元/.test(s) || 千分位.test(s)
          || /[零〇一壹二貳兩三叁參四肆五伍六陸七柒八捌九玖十拾百佰千仟萬万億]/.test(s));
    case '主辦機關':
      return SCHOOL_NAME_MARKERS.some((k) => s.includes(k));
    default:
      return true;
  }
}

// 是否為「非值」的標題/標籤殘片:含 9 個欄位的標籤與 NON_VALUE_CAPTIONS。
function isAnyLabel(s) {
  const str = String(s);
  if (ALL_LABELS.some((l) => str.startsWith(l))) return true;
  return NON_VALUE_CAPTIONS.some((l) => str.startsWith(l));
}

// ── 幾何配對 ────────────────────────────────────────────────────────────

/**
 * 一頁 → cell 陣列。`boxes[i]` 與 `lines[i]` 索引對齊(見 ocr/index.js)。
 * 沒有座標或沒有文字的行一律丟掉:幾何規則對它們無意義。
 */
function toCells(page) {
  const out = [];
  const lines = (page && page.lines) || [];
  const boxes = (page && page.boxes) || [];
  for (let i = 0; i < lines.length; i++) {
    const b = boxes[i];
    const t = String(lines[i] == null ? '' : lines[i]).trim();
    if (!b || b.x == null || b.y == null || !t) continue;
    out.push({
      text: t, x: b.x, y: b.y, w: b.w, h: b.h,
      right: b.x + b.w, bottom: b.y + b.h, cx: b.x + b.w / 2,
    });
  }
  return out;
}

// 垂直重疊(像素)。**只要求 > 0**:值格與標籤格常上下錯開大半個字高
// (元長「開工日期」與其值只重疊 8px),要求高比例重疊會把正確答案濾掉。
const vOverlap = (a, b) => Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);

// 同一格內容換行時 OCR 會拆成兩個 cell,而對齊方式兩種都有:古坑是左緣對齊
// (x 698 vs 693)、新光是置中對齊(cx 1571 vs 1575.5)。只認一種就會漏掉另一種。
function sameColumn(a, b) {
  const tol = 0.6 * Math.max(a.h, b.h);
  return Math.abs(a.x - b.x) <= tol || Math.abs(a.cx - b.cx) <= tol;
}

// 標籤本身也可能被 OCR 拆成上下兩行(大美的「契約規定」/「竣工日期」)。
// 以中心 x 對齊(續行常置中,左緣不齊)且行距近者視為同一個標籤。
function mergedBelow(c, all) {
  for (const d of all) {
    if (d === c) continue;
    if (Math.abs(d.cx - c.cx) > 0.6 * Math.max(c.h, d.h)) continue;
    const gap = d.y - c.bottom;
    if (gap < 0 || gap > 1.2 * c.h) continue;
    const x = Math.min(c.x, d.x);
    const right = Math.max(c.right, d.right);
    return { text: c.text + d.text, x, y: c.y, right, bottom: d.bottom, h: d.bottom - c.y, cx: (x + right) / 2 };
  }
  return null;
}

// 臺中市格式的標籤是一格一字、**水平**排開(大勇的「工程」x274 /「名」x550 /
// 「稱」x687,值在 x822)。mergedBelow 只合併垂直相鄰,拼不出完整標籤。
//
// **不能靠間距切**:大勇的標籤字間距是 91/95px,而標籤到值只有 85px——值反而
// 比標籤自己的字距更近,任何間距門檻都會先把值吞進來。改成逐格向右累積、
// **湊出完整標籤即停**,且只認完全相等(逐字拼出來的東西用 startsWith 會把值
// 一起收進標籤)。湊不出就不算命中,值因此永遠不會被當成標籤的一部分。
const MAX_MERGE_CELLS = 6;
function mergedRight(c, all, labels) {
  const row = all
    .filter((d) => d !== c && d.x >= c.right - 2 && vOverlap(c, d) > 0)
    .sort((a, b) => a.x - b.x)
    .slice(0, MAX_MERGE_CELLS);
  let text = c.text;
  let right = c.right;
  let bottom = c.bottom;
  for (const d of row) {
    text += d.text;
    right = Math.max(right, d.right);
    bottom = Math.max(bottom, d.bottom);
    if (labels.some((lb) => text === lb)) {
      return { text, x: c.x, y: c.y, right, bottom, h: bottom - c.y, cx: (c.x + right) / 2 };
    }
  }
  return null;
}

/**
 * 找某欄位的標籤格。標籤在格內只認「開頭」或「結尾」:元長把廠商名稱與標籤
 * 擠成一格「賜利發土木包工業契約約定工期」,標籤在結尾;台西則是
 * 「工程地點雲林縣台西國中」,標籤在開頭、其後就是值。標籤埋在句子中間的
 * (公文體「...契約編號A1150506,依合約...」)一律不認。
 * @returns {{anchor:object, rest:string|null}|null}
 */
function findLabel(all, labels) {
  for (const c of all) {
    for (const lb of labels) {
      const at = c.text.indexOf(lb);
      if (at === 0 || (at > 0 && c.text.endsWith(lb))) {
        return { anchor: c, rest: cleanValue(c.text.slice(at + lb.length)) };
      }
    }
  }
  // 單格找不到才試合併。合併結果只用來定位,不影響上面的單格判定。
  for (const c of all) {
    const m = mergedBelow(c, all);
    if (m && labels.some((lb) => m.text.startsWith(lb))) return { anchor: m, rest: null };
  }
  // 垂直合併也拼不出來,才試水平累積(臺中市格式)。排最後是為了讓既有樣本的
  // 判定路徑完全不變——水平合併只在前兩條都落空時才有機會影響結果。
  for (const c of all) {
    const m = mergedRight(c, all, labels);
    if (m) return { anchor: m, rest: null };
  }
  return null;
}

// 收集候選中與 best 同欄的續行,依 y 接成一個值。
function joinColumn(cands, best, within) {
  const group = cands.filter((c) => c === best || (sameColumn(best, c) && within(c)));
  group.sort((a, b) => a.y - b.y);
  return group.map((c) => c.text).join('');
}

/**
 * 同列右側最近的非標籤格,同欄續行一併接回。
 * 不接續行的話,古坑的工程名稱只會拿到下半截「棟西側 )」——兩個候選的左緣
 * 只差 5px,「取最左」在此毫無意義。
 */
function rightOf(anchor, all) {
  const 右側 = all.filter((c) => c.x >= anchor.right - 2 && !isAnyLabel(c.text));
  const cands = 右側.filter((c) => vOverlap(anchor, c) > 0);
  if (!cands.length) return null;
  let best = cands[0];
  for (const c of cands) if (c.x < best.x) best = c;
  const group = cands.filter((c) => c === best || sameColumn(best, c));

  // **續行也可能落在標籤上方。** 新光的工程名稱是兩行的一格,而上面那行
  // (`Danas-…綜合球場地`,y 722..812)與標籤(y 814..882)**差 2px 就重疊**,
  // vOverlap 判成不同列、連候選都進不去,於是整個前半段丟掉,只拿到
  // 「坪破損修復災後復建工程」——**而那是個看起來完全合理的工程名稱**,
  // 不會有任何欄位變 null,是最難發現的那種錯。
  //
  // 往上收的條件與 joinColumn 往下收一樣嚴(同欄 + 緊貼一個字高內),而且是
  // **逐格往上串**,中間斷開就停。既有的同列候選挑選完全不動,只多收上方續行。
  //
  // ⚠️ 還要再加一條:**往上收不得跨進別的標籤那一列**。新光的「工程地點」
  // 與其值的間距是 65px、比一個字高(70)還小,單靠距離門檻擋不住,結果
  // 「工程地點」把上一列屬於「工程名稱」的值收走,兩欄一起壞掉。
  // 判準不是調距離而是**看語意**:與某個標籤垂直重疊的格,已經是那個標籤的值,
  // 不可能同時是這一格的續行。真正的續行是「超出標籤那一列」的那幾行,
  // 它們不會與任何標籤重疊。
  const 標籤格 = all.filter((c) => isAnyLabel(c.text));
  const 是別人的值 = (c) => 標籤格.some((lb) => vOverlap(lb, c) > 0);
  let top = group.reduce((m, c) => (c.y < m.y ? c : m), group[0]);
  for (;;) {
    const up = 右側.find((c) => !group.includes(c) && sameColumn(top, c)
      && top.y - c.bottom >= 0 && top.y - c.bottom <= Math.max(top.h, c.h)
      && !是別人的值(c));
    if (!up) break;
    group.push(up);
    top = up;
  }
  group.sort((a, b) => a.y - b.y);
  return group.map((c) => c.text).join('');
}

/**
 * 正下方同欄最近的非標籤格(署名欄:標籤在上、值在下),續行一併接回。
 * 續行限定緊貼在下(間距不超過一個字高),否則會把下一列的內容也吞進來。
 */
function belowOf(anchor, all) {
  const cands = all.filter((c) =>
    c.y >= anchor.bottom && c.y - anchor.bottom <= 3 * anchor.h
    && Math.abs(c.cx - anchor.cx) <= 0.5 * Math.min(anchor.right - anchor.x, c.w)
    && !isAnyLabel(c.text));
  if (!cands.length) return null;
  let best = cands[0];
  for (const c of cands) if (c.y < best.y) best = c;
  return joinColumn(cands, best, (c) => c.y > best.y && c.y - best.bottom <= best.h);
}

// 同格餘文 → 同列右側 → 正下方同欄。每一步都要過型別把關,不過就當沒找到。
function valueFor(cells, labels, fieldKey) {
  const f = findLabel(cells, labels);
  if (!f) return null;
  const take = (v) => {
    const s = typeof v === 'string' ? v : cleanValue(v);
    return s && isPlausibleValue(fieldKey, s) ? s : null;
  };
  if (f.rest) return take(f.rest);
  return take(cleanValue(rightOf(f.anchor, cells))) || take(cleanValue(belowOf(f.anchor, cells)));
}

// ── 敘述句退路 ──────────────────────────────────────────────────────────

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
// 90日曆天竣工」)。標籤路徑解不出天數時,退而在全文找含「日曆天」或「工作天」
// 且能被 parseDuration 解出天數的那一行。
function durationSentenceFallback(lines) {
  for (const line of lines) {
    const s = String(line);
    if (!/日曆天|工作天/.test(s)) continue;
    if (parseDuration(s).天數 != null) return s;
  }
  return null;
}

// 表單上的工期欄長這樣:「（80）日曆天 /（  ）工作天」。**括號會讓 OCR 把數字與
// 基準詞斷成兩個框**,而且分屬不同行——`80` 自成一行、`日曆天` 自成一行,
// 所以 durationSentenceFallback 在行層永遠拼不出「80日曆天」。
// 但在**座標層它們是水平相鄰的**(文安:80 的右緣 2456、「日曆天」左緣 2481)。
// 以基準詞為錨、往左取同列最近的純數字,拼成 parseDuration 認得的「80日曆天」。
//
// **兩個基準詞都帶數字時回 null,不猜**——沿用 parseDuration 的立場:猜錯會把
// 日曆天的案子當工作天驗,產生一個必然的假硬錯,而承辦人本來就知道是哪一種。
const 基準詞 = /^[)）\s]*(日曆天|工作天)$/;
function durationCellFallback(cells) {
  const hits = [];
  for (const c of cells) {
    const m = 基準詞.exec(String(c.text).replace(/\s/g, ''));
    if (!m) continue;
    let best = null;
    for (const d of cells) {
      if (!/^\d{1,4}$/.test(String(d.text).trim())) continue;
      if (d.x >= c.x || vOverlap(c, d) <= 0) continue;          // 只認同列、在左邊
      if (c.x - d.right > Math.max(c.h, d.h)) continue;          // 隔太遠不是同一格的內容
      if (!best || d.right > best.right) best = d;               // 取最靠近的
    }
    if (best) hits.push(`${best.text.trim()}${m[1]}`);
  }
  return hits.length === 1 ? hits[0] : null;
}

/**
 * 主辦機關的退路:**表單抬頭的機關全銜**。
 *
 * 四份樣本(大勇/大美/文安/鹿場)整份沒有「主辦機關」標籤,但第 1 頁最上方
 * (y 360~390)都印著機關全銜。文安在第 2 頁雖有「工程主辦」/「機關」,卻是
 * **標籤被拆成上下兩段、中間夾著值**,`mergedBelow` 拼不起來。
 *
 * ⚠️ 為什麼這裡不套用「錯比漏危險」而選擇補值:`kickoff-compare` 的 `cmp` 對
 * **`missing` 也判 hard**(第 51 行),讀不到與讀錯一樣擋住歸檔。既然漏不會比較
 * 安全,補一個讓承辦人核對的值就是淨改善——大美那份 OCR 把「莿桐」讀成「莉桐」,
 * 預填出來他改一個字,空著他要打整串。沿用「OCR 只作預填不作裁決」的立場。
 *
 * 判準要能把機關全銜與工程名稱分開:兩者都含「國小」,但機關全銜**以縣市開頭、
 * 以學校結尾**,工程名稱結尾是「工程」。取最上方那一個,避開署名欄裡的同名字串。
 */
const 學校結尾 = /(國民小學|國民中學|國小|國中|小學|中學)$/;
function orgHeaderFallback(cells) {
  let best = null;
  for (const c of cells) {
    const s = String(c.text).replace(/[\s　]/g, '');
    if (!學校結尾.test(s) || !extractCounty(s)) continue;
    if (!best || c.y < best.y) best = c;
  }
  return best ? String(best.text).replace(/[\s　]/g, '') : null;
}

// 金額標籤被 OCR 毀掉時的退路(元長的「契約總價」被讀成「丁約總價」,
// 值「新台幣 1,091,313 元整」卻好端端在旁邊)。**不**改用模糊比對標籤——
// 「竣工日期」與「開工日期」只差一個字,放寬字元容差會把這兩欄配錯,
// 那比抽不到嚴重得多。改認值本身的形態:以「新台幣/新臺幣」開頭。
function moneySentenceFallback(lines) {
  for (const line of lines) {
    const s = String(line).trim();
    if (/^新[台臺]幣/.test(s) && parseMoney(s) != null) return s;
  }
  return null;
}

// ── 守門:是不是開工報告表 ───────────────────────────────────────────────

// 判定看**前 3 頁**。原本只看第 1 頁,理由是關鍵欄位都落在第 1 頁、後續頁是
// 品管人員登錄表等附件,把附件算進來會讓公文封面被誤放行。
//
// 但實測到真實的反例:承辦人給的 `[開工報告]函+[開工報告].doc` 轉出 4 頁,
// **頁 1、2 是廠商函的正本與副本,開工報告書在頁 3**。只看第 1 頁的話整份被判
// 「無法辨識為開工報告表」——而那份文件裡確實有一張完整的開工報告書,
// 抽取那一段本來就會遍歷全部頁,卡住的只有守門這一關。
//
// 取 3 頁的依據:公文函最多正本 + 副本兩頁,開工報告書排在其後。
// 原本擔心的「封面被誤放行」不成立——公誠那份合併檔現在本來就讀得出 9 欄
// 且值都正確,擋下它只是讓承辦人多做一次拆檔。
const GATE_PAGES = 3;

function gateLines(pages) {
  const head = pages.filter((p) => p && (p.page == null || p.page <= GATE_PAGES));
  const src = head.length ? head : pages;
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
// 這是臺中市簡化格式特有的缺口。只在版面看起來完整時才用這條擋,避免誤傷本來
// 就只填了 1、2 個欄位的正常案例或最小化的測試 fixture。
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
 * (原記於此的「大勇廁所只剩一句退路句」缺口已於 2026-08-05 解決:根因是臺中市格式
 * 的標籤被 OCR 拆成逐字水平散開,mergedRight 補上水平累積後標籤真的命中了。)
 */
function looksLikeKickoffReport(page1Lines) {
  if (looksComplete(page1Lines) && missingDateFamily(page1Lines)) return false;
  if (hasLabelAtLineStart(page1Lines)) return true;
  return startDateFallback(page1Lines) != null;
}

/**
 * 從 OCR 輸出抽 9 欄。**逐欄取兩解析度的聯集**:任一讀到即採用,先命中者優先。
 * 只跑單一解析度會少 5 個百分點,且改善非單調(每份文件最佳解析度不同)。
 *
 * @param {{pages: Array<{page:number,width:number,lines:string[],boxes:object[]}>}} ocrOutput
 * @returns {object} 9 欄;讀不到的一律 null
 * @throws {Error} code 'NOT_KICKOFF_REPORT' —— 前 3 頁缺少任何已知欄位標籤與退路句,
 *   或版面完整卻整組決標/開工/竣工日標籤缺席(臺中市簡化格式的已知樣態)
 * @throws {Error} code 'OCR_NO_GEOMETRY' —— OCR 輸出沒有座標。抽取全靠座標,
 *   靜默回滿滿 null 會被誤讀成「這份文件真的沒填」,故明確報錯。
 */
function extractFields(ocrOutput) {
  const pages = (ocrOutput && ocrOutput.pages) || [];
  const allLines = [];
  for (const p of pages) for (const l of (p && p.lines) || []) allLines.push(String(l));

  if (!looksLikeKickoffReport(gateLines(pages))) {
    const err = new Error('此檔無法辨識為開工報告表(缺少任何已知欄位標籤與退路句),請確認上傳的是開工報告表');
    err.code = 'NOT_KICKOFF_REPORT';
    throw err;
  }

  const pageCells = pages.map(toCells);
  if (!pageCells.some((cs) => cs.length)) {
    const err = new Error('OCR 輸出缺少文字座標,無法還原表格版面');
    err.code = 'OCR_NO_GEOMETRY';
    throw err;
  }

  // 逐頁逐解析度找,先命中者保留 —— pages 依 widths 順序推入,
  // 故 2200px 的結果優先,3400px 只補其未命中的欄位。
  const raw = {};
  for (const key of Object.keys(LABELS)) {
    for (const cs of pageCells) {
      if (raw[key]) break;
      raw[key] = valueFor(cs, LABELS[key], key);
    }
    if (!raw[key]) raw[key] = null;
  }

  if (!raw.契約金額) raw.契約金額 = moneySentenceFallback(allLines);
  // 抬頭的機關全銜(見 orgHeaderFallback)。只看第 1 頁:抬頭在那裡,而後續頁的
  // 署名欄、備註句裡也有同一個機關名,y 沒有跨頁可比性。
  if (!raw.主辦機關 && pageCells[0]) raw.主辦機關 = orgHeaderFallback(pageCells[0]);
  // 退路的觸發條件是「解不出天數」而非「標籤沒命中」:標籤命中但那格不是工期時,
  // 一個非 null 的垃圾字串會把退路整個擋掉。
  if (parseDuration(raw.契約工期).天數 == null) {
    raw.契約工期 = durationSentenceFallback(allLines);
  }
  // 行層也拼不出來,才走座標層(括號把數字與基準詞斷成兩行的那種版面)。
  // 排最後是為了讓既有樣本的判定路徑完全不變。
  if (parseDuration(raw.契約工期).天數 == null) {
    for (const cs of pageCells) {
      const v = durationCellFallback(cs);
      if (v) { raw.契約工期 = v; break; }
    }
  }

  const 開工日 = rocToISO(raw.契約規定開工日) || startDateFallback(allLines);

  return {
    工程名稱: raw.工程名稱,
    契約編號: raw.契約編號,
    契約金額: parseMoney(raw.契約金額),
    決標日期: rocToISO(raw.決標日期),
    契約工期: parseDuration(raw.契約工期),
    主辦機關: raw.主辦機關,
    // 工程地點有街道與校名兩種寫法,只能抽開頭縣市(spec §5.2)。
    // 臺中市格式**整份沒有「工程地點」欄**,改由主辦機關的全銜推——機關全銜
    // 本來就以縣市開頭(「臺中市西區大勇國民小學」),而且只在工程地點抽不到時才用。
    縣市: extractCounty(raw.工程地點) || extractCounty(raw.主辦機關),
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
