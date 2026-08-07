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
