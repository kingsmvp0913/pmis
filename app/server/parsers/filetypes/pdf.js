/**
 * filetypes/pdf.js — 共用 PDF 檔型讀取器
 *
 * 各廠商 PDF 讀取器共用此工具:以 pdf-parse 抽出「每頁純文字」。
 * 回傳陣列每元素 { page, text },page 為 1-based 頁碼,text 為該頁文字。
 *
 * 文字一律做 Unicode NFKC 正規化:金大等 PDF 的 CID 字型會把部分漢字
 * (如「年」)映到 CJK 相容區(U+F9xx)碼位,NFKC 可還原成標準漢字,
 * 讓下游用一般漢字錨點(年/月/日/累計…)比對即可。
 *
 * Exports:
 *   extractPages(filePath) -> Promise<Array<{ page:number, text:string }>>
 *   columnBounds(items)    -> {blockMax,labelMax}(由 x 分布推導欄界;證據不足回預設常數)
 *   rowsFromItems(items, bounds?) -> Array<{label,value}>(純函式,供兩欄表版面用)
 *   extractRows(fileOrBuffer) -> Promise<Array<{page, rows:[{label,value}]}>>
 */
const fs = require('fs');
const pdf = require('pdf-parse');

// 自訂 pagerender:依文字 item 的 y 座標(transform[5])換行,逐頁還原成
// 貼近版面的多行文字(pdf-parse 預設會把整份併成一坨,難以逐頁切)。
// 用 pdf-parse@1(純 CJS,無 ESM 動態 import),於 Jest VM 下亦可正常載入。
function renderPage(pages) {
  return function (pageData) {
    return pageData
      .getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
      .then((tc) => {
        let lastY = null;
        let text = '';
        for (const item of tc.items) {
          const y = item.transform[5];
          if (lastY !== null && lastY !== y) text += '\n';
          text += item.str;
          lastY = y;
        }
        pages.push(text);
        return text;
      });
  };
}

/**
 * 抽出 PDF 每頁文字(NFKC 正規化)。
 * @param {string} filePath PDF 絕對或相對路徑
 * @returns {Promise<Array<{page:number, text:string}>>}
 */
async function extractPages(filePath) {
  const buffer = fs.readFileSync(filePath);
  const pages = [];
  await pdf(buffer, { pagerender: renderPage(pages) });
  return pages.map((text, i) => ({
    page: i + 1,
    text: String(text || '').normalize('NFKC'),
  }));
}

// ── 兩欄表版面(如政府電子採購網決標公告「友善列印」)──
// 版面固定:x<45 為區塊名直排字(機/關/資/料)、45≤x<130 為標籤欄、x≥130 為值欄。
// 同一列的標籤與值 y 座標會差 1~3px,故以容差分組而非精確相等。
const BLOCK_MAX_X = 45;
const LABEL_MAX_X = 130;
const Y_TOLERANCE = 3;

// 欄界推導所需的最少同 x item 數。低於此表示證據不足(如單元測試的三兩筆),
// 推出來的只是噪音,寧可退回上面兩個實測主流值。
const MIN_CLUSTER = 10;
// 欄界往左讓的距離。實測各案「標籤欄 x − 區塊直排字 x」最小 14.2(饒平),
// 讓 5pt 足以把直排字排除又不會咬到標籤欄。
const COLUMN_MARGIN = 5;

/**
 * 由 item 的 x 分布推導「區塊/標籤」與「標籤/值」兩道欄界。
 *
 * 為何不能寫死:48 份決標公告實測,標籤欄 x 有 **7 種值**(50.2 佔 41 案,另有
 * 48.3/49.8/46.7/45.7/44.9/17.4)。饒平的 44.9 只差 0.1 就落在舊常數 45 之外,
 * 整份被當成區塊直排字丟掉;元長整頁左移到 17.4。兩案的 5 個欄位全部抽不到,
 * 而 parseAwardNotice **不會 throw**——輸出是「每欄都 null」的合法結構,
 * 看起來像文件沒填,是拿讀取器自己的輸出當基準時驗不出來的那一類。
 *
 * 推導依據:標籤欄與值欄各自是一大票 item 的左對齊點,x 頻次的前兩名就是它們,
 * 且與第三名(區塊直排字)差距懸殊——實測古坑 143/120 vs 21、元長 127/102 vs 21。
 * 兩者中 x 較小的是標籤欄(48 案皆然)。
 *
 * @param {Array<{x:number,s:string}>} items 整份文件(非單頁)的 item
 * @returns {{blockMax:number, labelMax:number}}
 */
function columnBounds(items) {
  const cnt = new Map();
  for (const it of items || []) {
    if (!String(it && it.s != null ? it.s : '').trim()) continue;
    const k = Math.round(it.x * 10) / 10;
    cnt.set(k, (cnt.get(k) || 0) + 1);
  }
  const top = [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  if (top.length < 2 || top[1][1] < MIN_CLUSTER) {
    return { blockMax: BLOCK_MAX_X, labelMax: LABEL_MAX_X };
  }
  const [labelX, valueX] = [top[0][0], top[1][0]].sort((a, b) => a - b);
  return { blockMax: labelX - COLUMN_MARGIN, labelMax: valueX - COLUMN_MARGIN };
}

// 決標公告 PDF 的內嵌字型 ToUnicode CMap 把下列漢字誤映到 CJK 部首補充區
// (U+2E80–U+2EFF),而非標準統一漢字。NFKC 對這個區塊沒有相容分解(它只
// 還原得了 U+F9xx 相容漢字),不額外映射的話,這些字下游與專案主檔
// (schools.name / projects.name,皆為標準碼位)逐字比對會誤判成不一致——
// 28 份樣本實測「民」(U+2EA0)每一份的主辦機關都出現,不修等於硬擋機制
// 形同虛設。僅列實測到的 3 個字,其餘部首補充區字元未實測到問題,不補。
const CJK_RADICAL_FIXUPS = {
  '⺠': '民', // 民
  '⻑': '長', // 長
  '⻄': '西', // 西
};

function fixCjkRadicals(s) {
  let out = s;
  for (const [bad, good] of Object.entries(CJK_RADICAL_FIXUPS)) {
    out = out.split(bad).join(good);
  }
  return out;
}

/**
 * 由單頁 text item 座標陣列建「標籤/值」列。純函式,不碰檔案系統。
 *
 * NFKC 正規化後再做 CJK 部首補充區誤映還原(見 CJK_RADICAL_FIXUPS),
 * 修正決標公告字型的已知缺陷。
 *
 * @param {Array<{x:number,y:number,s:string}>} items 單頁的 item
 * @param {{blockMax:number,labelMax:number}} [bounds] 欄界;省略則由本頁 item 自行推導。
 *   **整份文件應由 extractRows 算一次再傳進來**:逐頁各自推導的話,item 不足的短頁
 *   會退回預設常數,同一份文件的前後頁用不同欄界切,結果不一致。
 * @returns {Array<{label:string,value:string}>} 由上而下
 */
function rowsFromItems(items, bounds) {
  const { blockMax, labelMax } = bounds || columnBounds(items);
  const buckets = [];
  // 先依 y 由大到小排序再分組:bucket 錨點取自「第一個放入的 item」,
  // 若不先排序,items 原始順序不同(如 y 鏈狀相近的 415/413/411/409,
  // 兩兩在容差內但總跨距超過容差)會導致分出不同列數,結果不穩定。
  const ordered = (items || []).slice().sort((a, b) => b.y - a.y);
  for (const it of ordered) {
    if (!String(it.s == null ? '' : it.s).trim()) continue;
    let b = buckets.find((k) => Math.abs(k.y - it.y) <= Y_TOLERANCE);
    if (!b) {
      b = { y: it.y, items: [] };
      buckets.push(b);
    }
    b.items.push(it);
  }
  buckets.sort((a, b) => b.y - a.y);
  return buckets.map((b) => {
    const sorted = b.items.slice().sort((p, q) => p.x - q.x);
    const join = (lo, hi) => fixCjkRadicals(sorted
      .filter((i) => i.x >= lo && i.x < hi)
      .map((i) => i.s)
      .join('')
      .normalize('NFKC')
      .trim());
    return { label: join(blockMax, labelMax), value: join(labelMax, Infinity) };
  });
}

/**
 * 抽出 PDF 每頁的「標籤/值」列。僅適用版面為兩欄表的固定格式文件(決標公告);
 * 自由文字 PDF 請用 extractPages。
 *
 * @param {string|Buffer} fileOrBuffer 檔案路徑或已讀入的內容(上傳走記憶體不落地)
 * @returns {Promise<Array<{page:number, rows:Array<{label,value}>}>>}
 */
async function extractRows(fileOrBuffer) {
  const buffer = Buffer.isBuffer(fileOrBuffer) ? fileOrBuffer : fs.readFileSync(fileOrBuffer);
  const pages = [];
  await pdf(buffer, {
    pagerender: (pageData) => pageData
      .getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
      .then((tc) => {
        pages.push(tc.items.map((it) => ({ x: it.transform[4], y: it.transform[5], s: it.str })));
        return '';
      }),
  });
  // 欄界由**整份文件**的 item 算一次:逐頁各自推導的話,item 不足的短頁會退回
  // 預設常數,同一份文件的前後頁用不同欄界切。
  const bounds = columnBounds(pages.flat());
  return pages.map((items, i) => ({ page: i + 1, rows: rowsFromItems(items, bounds) }));
}

/**
 * 抽出 PDF 每頁的原始文字 item(含 x/y 座標),不做任何分欄。
 *
 * `extractRows` 的分欄寫死給決標公告的兩欄表(BLOCK_MAX_X/LABEL_MAX_X),多欄表格
 * 套不上;`extractPages` 又只回文字,而多欄表格抽成文字後會變成
 * 「1.002,500.001.00 2,500.00」這種黏連字串,還原不回欄位。
 *
 * 廠商讀取器需要的是原始座標,自己依該家版面分欄——同 SP1B 對 OCR 的結論:
 * 把座標丟掉之後,下游只能靠順序猜,而順序在多欄表格裡不成立。
 *
 * 一併回傳 `w`(item 繪製寬度)。單一 item 常橫跨多欄——金大第二聯的
 * `"-   124.0    "` 就同時裝著金額欄的「-」與累計欄的「124.0」,只有 x(左端)
 * 無法判斷欄內某個 token 的位置;有 w 才能用 w/s.length 推每個字元的 x,
 * 進而算出 token 中心落在哪一欄。
 *
 * @param {string|Buffer} fileOrBuffer
 * @returns {Promise<Array<{page:number, items:Array<{x:number,y:number,w:number,s:string}>}>>}
 */
async function extractItems(fileOrBuffer) {
  const buffer = Buffer.isBuffer(fileOrBuffer) ? fileOrBuffer : fs.readFileSync(fileOrBuffer);
  const pages = [];
  await pdf(buffer, {
    pagerender: (pageData) => pageData
      .getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
      .then((tc) => {
        pages.push(tc.items.map((it) => ({
          x: it.transform[4],
          y: it.transform[5],
          w: typeof it.width === 'number' ? it.width : 0,
          // 與 extractPages 一致地做 NFKC:CID 字型會把「年」等字映到 CJK 相容區,
          // 不正規化則下游 regex 抓不到(見本檔頭註)。
          s: fixCjkRadicals(String(it.str == null ? '' : it.str).normalize('NFKC')),
        })));
        return '';
      }),
  });
  return pages.map((items, i) => ({ page: i + 1, items }));
}

module.exports = { extractPages, columnBounds, rowsFromItems, extractRows, extractItems };

/* ───────────────────────── 掃描件:OCR 版的 extractItems ───────────────────────── */

/**
 * OCR 的 word 框 → 與 `extractItems` **同一種形狀**的 items(`{x, y, w, s}`,
 * PDF 點座標、y 由下往上)。目的是讓既有的座標型讀取器**原封不動**吃掃描件。
 *
 * 三件事非做不可,少一件就對不上:
 * ① **像素→點的比例尺要用點陣圖的真實寬度**(driver 回報的 `bw`),不能拿
 *    DestinationWidth。這台機器顯示縮放 125%,要求 2200 實際給 2750,
 *    用要求值換算會讓所有 x 偏移到 1.247 倍(實測)。
 * ② **y 用「該行所有字的框底中位數」**,不是每個字自己的框底。同一行裡有無下緣的字
 *    (一、二)與有下緣的字(誌、期),各自的框底差好幾點,逐字換算會讓同一列
 *    在讀取器的分帶裡被拆成兩三列。OCR 本來就把字分好行了,直接用那個分組最穩。
 * ③ **相鄰的字要併成詞**。Windows OCR 的 CJK「word」是一個字一個框,不併的話
 *    讀取器那些 `find(/^施工項目$/)` 的表頭比對永遠找不到。判準用「字距 < 0.8 倍字高」:
 *    同一格內的字距是 2~10px、跨欄的空白是上百 px,兩者差一個數量級。
 *
 * @param {string} filePath
 * @param {{ocr:{ocrPdf:Function}, width?:number, gapRatio?:number}} opts
 *   ocr 由呼叫端注入(filetypes 不直接 require server/ocr,維持分層)
 * @returns {Promise<Array<{page:number, items:Array<{x:number,y:number,w:number,s:string}>}>>}
 */
/**
 * OCR 修補層。只做兩件**可稽核**的事,不碰其他任何字:
 * ① 標點/字形:OCR 常把小數點讀成中點(`0·65`)、把 l/O 讀進數字裡。
 *    只在「整個 token 看起來就是數字」時才套用,避免把項目名稱裡的字改掉。
 * ② 表頭標籤:工程會標準表單的欄位標籤是**固定小字彙**,OCR 認錯一兩個字
 *    (`累計完` → `…計元`)就會讓讀取器的 `find(/^累計完成數量$/)` 整個表頭找不到。
 *    與字彙比對,長度相近且**至少七成字元相同**才吸附過去。
 * 兩者都刻意保守:寧可留著錯字讓完整性關卡看得見,也不要猜一個看起來合理的值。
 */
const OCR_LABELS = [
  '項次', '合約項次', '工程項目', '施工項目', '契約項目', '材料名稱', '單位', '單 位',
  '契約數量', '合約數量', '設計數量', '數量', '契約單價', '單價', '複價',
  '本日完成數量', '累計完成數量', '本日完成金額', '累計完成金額', '本日完成', '完成金額',
  '本日使用數量', '累計使用數量', '本日使用量', '累計使用量', '備註',
  '工別', '本日人數', '累計人數', '機具名稱',
  '第一聯', '第二聯', '表報編號', '表單編號', '填報日期', '填表日期', '本日天氣', '本日氣候',
  '工程名稱', '承攬廠商名稱', '核定工期', '契約工期', '累計工期', '剩餘工期',
  '開工日期', '完工日期', '預定進度', '實際進度', '累計預定進度', '累計實際進度',
  '營造業專業工程特定施工項目',
];
const NUMISH = /^[\d.,·•．・oOlI]+$/;
function repairNum(s) {
  return s.replace(/[·•．・]/g, '.').replace(/[oO]/g, '0').replace(/[lI]/g, '1');
}
function snapLabel(s) {
  const t = s.replace(/[\s　]/g, '');
  if (t.length < 2 || t.length > 14) return s;
  let best = null; let bestScore = 0;
  for (const lab of OCR_LABELS) {
    const L = lab.replace(/[\s　]/g, '');
    if (Math.abs(L.length - t.length) > 1) continue;
    let same = 0;
    for (let i = 0; i < Math.min(L.length, t.length); i++) if (L[i] === t[i]) same += 1;
    const score = same / L.length;
    if (score > bestScore) { bestScore = score; best = L; }
  }
  return bestScore >= 0.7 && bestScore < 1 ? best : s;
}
function repairOcrText(s) {
  const t = String(s);
  if (NUMISH.test(t.replace(/[\s　]/g, '')) && /\d/.test(t)) return repairNum(t);
  return snapLabel(t);
}

async function extractItemsOcr(filePath, opts = {}) {
  const ocr = opts.ocr;
  if (!ocr || typeof ocr.ocrPdf !== 'function') throw new Error('extractItemsOcr 需要注入 ocr.ocrPdf');
  const width = opts.width || 2200;
  const gapRatio = opts.gapRatio == null ? 0.8 : opts.gapRatio;

  const { pages } = await ocr.ocrPdf(filePath, { widths: [width] });
  const out = [];
  for (const p of pages) {
    const words = (p.words || []).filter((w) => w && w.t != null && w.x != null);
    // 比例尺:點 = 像素 × (頁寬點 / 點陣圖像素寬)。Windows 的 Size 是 DIP(1/96 吋),
    // PDF 點是 1/72 吋,故 ×0.75。
    const pageW = Number(p.pw) * 0.75;
    const pageH = Number(p.ph) * 0.75;
    const bw = Number(p.bw) || Math.round(Number(p.width) * 1.25);
    if (!(pageW > 0) || !(pageH > 0) || !(bw > 0)) continue;
    const k = pageW / bw;

    const byLine = new Map();
    for (const w of words) {
      const key = w.line == null ? 0 : w.line;
      if (!byLine.has(key)) byLine.set(key, []);
      byLine.get(key).push(w);
    }
    const items = [];
    for (const ws of byLine.values()) {
      ws.sort((a, b) => a.x - b.x);
      const bottoms = ws.map((w) => w.y + w.h).sort((a, b) => a - b);
      const mid = bottoms[Math.floor(bottoms.length / 2)];
      // 併字的門檻用**整行字高的中位數**,不能用單一個字的高:像「一」「二」這種
      // 只有一橫的字框高只有 7px,拿它當基準會把「第/一聯」拆開,而讀取器的表頭
      // 比對(find(/^第一聯$/))就永遠找不到。
      const hs = ws.map((w) => w.h).sort((a, b) => a - b);
      const mh = hs[Math.floor(hs.length / 2)] || 1;
      const y = pageH - mid * k;                       // ②:整行共用一個 y
      let cur = null;
      for (const w of ws) {
        const gap = cur ? w.x - (cur.x1) : 0;
        if (cur && gap <= gapRatio * mh) {             // ③:字距小於 0.8 倍字高就併
          cur.s += w.t;
          cur.x1 = w.x + w.w;
        } else {
          if (cur) items.push({ x: cur.x0 * k, y, w: (cur.x1 - cur.x0) * k, s: repairOcrText(cur.s) });
          cur = { x0: w.x, x1: w.x + w.w, s: String(w.t) };
        }
      }
      if (cur) items.push({ x: cur.x0 * k, y, w: (cur.x1 - cur.x0) * k, s: repairOcrText(cur.s) });
    }
    items.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    out.push({ page: p.page, items });
  }
  out.sort((a, b) => a.page - b.page);
  return out;
}

module.exports.extractItemsOcr = extractItemsOcr;
module.exports._ocrRepair = { repairOcrText, snapLabel, repairNum, OCR_LABELS };
