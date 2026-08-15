/**
 * daily-log-scan.js — 無文字層(掃描件)施工日誌的 OCR 解析。
 *
 * ## 兩件事:涵蓋範圍偵測(`scanCoverage`)與明細解析(`scanDays`)
 *
 * 明細解析 2026-08-10 才開放,**而且只作為預填,一律要承辦人逐格確認才寫得進去**
 * (見 daily-log-routes.js 的 `/daily-logs/scan`)。開放的依據與代價:
 *
 * | 層 | 對 | 錯 | 漏 |
 * |---|---|---|---|
 * | item 層(OCR 的框對不對得上文字層) | 86.8% | 0 | 13.2% |
 * | **dailyRows 層(6 份文件 296 格實測)** | **62.8%** | **1.7%** | **35.5%** |
 *
 * item 層那個 86.8% **不能拿來決定要不要開放**——中間隔著讀取器的表頭錨點與
 * 座標分欄,而且逐家差異從 0% 到 100%(宜謙 96.7、宏恩 81~100、金大 13~43、
 * 另有 2 份讀取器走 OCR 會整份 throw)。量測基座在 `data/parser-tools/ocr-ab/`。
 *
 * ⚠️⚠️ **那 62.8% 是拿「有文字層的檔案」走 OCR 路徑量的**,因為只有那種檔案
 * 才有答案卷(同一份文件的文字層)。真掃描件另有雜訊、傾斜、印章、影印衰減。
 *
 * **2026-08-11 更正:先前記的「真掃描件整份 throw」已經修掉了。** 卡點不是
 * 辨識率,是宜謙讀取器要求第二聯五個表頭錨點全到,而「單位」是直排兩個小字、
 * 掃描件上 OCR 沒產生框;另外四個都讀到了,單位欄的**值**也讀得清清楚楚。
 * 改成表頭找不到時從值回推欄界(`yiqian.pmisparser.js` 的 `unitColumnX`)之後,
 * 饒平 4/25-4/30 六天全部解析出來,本日完成數量**對 6、錯 0、漏 0**。
 * ⚠️ 樣本很小(一家、一份、6 個非零格),**不足以宣稱「真掃描件可用」**;
 * 名稱仍有明顯錯字(图籬/开开/损壤)。逐格確認仍是放行前提。
 *
 * ⚠️ **「錯的看不見」這個性質沒有變**:1.7% 那些值本身自洽、累計也自洽,
 * SP3 的 42 條驗證一條都攔不住,會一路寫進每日施工紀錄 → 監造報表 → 估驗計價。
 * 逐格確認是放行前提,不可省。
 *
 * ## 為什麼涵蓋範圍偵測仍然單獨存在
 *
 * **表頭那一行 OCR 非常穩**:鎮西 60 頁實測填報日期 100% 正確、0 讀錯(天氣、
 * 工程名稱、工期、進度同一行也都對)。字大、獨立、沒有格線干擾——與明細格完全
 * 不同的難度。所以即使讀取器整份 throw(實測 2/8 份會),涵蓋範圍仍答得出來:
 * 把「這份讀不到」變成「這份是 6/1~6/30 共 30 天,內容要人工補」,也能判斷
 * 這份掃描件是不是與已經讀得到的檔重複(宜謙 31 份裡有 14 份就是重複的)。
 *
 * ⚠️ 解析度一律 **2200**,不要跟著開工報告表調到 3400:密集表格的最佳點與
 * 開工報告表相反(2200 86.8% / 2800 85.0% / 3400 84.4%,且 2800 以上開始把
 * 數字讀成別的數字)。
 *
 * Exports:
 *   scanCoverage(pdfPath, {ocr, extractItemsOcr, width}) → { pages, days, 日期, 缺日期頁 }
 *   scanDays(pdfPath, {ocr, extractItemsOcr, filetypes, parser, width}) → parseAll 的輸出
 */

const nfkc = (v) => String(v == null ? '' : v).normalize('NFKC');
const despace = (v) => nfkc(v).replace(/[\s　]/g, '');

/** 民國⇄西元雙制。 */
function toISO(y, m, d) {
  let year = Number(y);
  if (!Number.isFinite(year)) return null;
  if (year < 1911) year += 1911;
  return `${year}-${String(Number(m)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`;
}

/**
 * 一頁的表頭資訊(純函式,吃 items 陣列,方便測試)。
 * 只取「OCR 實測可靠」的那幾欄,不碰明細。
 */
function pageHeader(items) {
  const t = despace((items || []).map((i) => i.s).join(''));
  const dm = t.match(/填[表報]日期[:：]?(\d{2,4})年(\d{1,2})月(\d{1,2})日/);
  const wm = t.match(/上午[:：](.{1,4}?)下午[:：](.{1,4}?)(?:填|工程名稱|$)/);
  return {
    填報日期: dm ? toISO(dm[1], dm[2], dm[3]) : null,
    星期: (t.match(/星期[一二三四五六日天]/) || [])[0] || null,
    天氣_上午: wm ? wm[1] : null,
    天氣_下午: wm ? wm[2] : null,
  };
}

/**
 * 掃描件涵蓋範圍。
 * @param {string} pdfPath
 * @param {{ocr:object, extractItemsOcr:Function, width?:number}} deps
 *   依賴一律注入:這一層不決定 OCR 怎麼跑,也方便測試時餵假資料。
 */
async function scanCoverage(pdfPath, deps = {}) {
  const { ocr, extractItemsOcr, width } = deps;
  if (typeof extractItemsOcr !== 'function') throw new Error('scanCoverage 需要注入 extractItemsOcr');
  const pages = await extractItemsOcr(pdfPath, { ocr, width: width || 2200 });
  const rows = pages.map((p) => ({ page: p.page, ...pageHeader(p.items) }));
  const 日期 = [...new Set(rows.map((r) => r.填報日期).filter(Boolean))].sort();
  return {
    pages: rows,
    days: 日期.length,
    日期,
    缺日期頁: rows.filter((r) => !r.填報日期).map((r) => r.page),
  };
}

/** 密集表格的最佳解析度(與開工報告表相反,見檔頭)。 */
const SCAN_WIDTH = 2200;

/**
 * 掃描件的明細解析:OCR 的 items 餵給**該廠商既有的讀取器**,吐出與文字層同形的 days。
 *
 * 讀取器一行都不用改——`extractItemsOcr` 產出的就是 `extractItems` 的形狀,
 * 這裡只是把 `ctx.filetypes.extractItems` 換掉。其餘檔型工具(readWorkbook 等)
 * 必須原樣保留:整包換掉的話,讀取器裡任何一支非 PDF 分支都會炸。
 *
 * ⚠️ 讀取器**可能整份 throw**(表頭錨點 OCR 認錯就找不到,實測 8 份裡有 2 份)。
 * 這裡不吞掉——呼叫端要能分辨「這份 OCR 讀得出明細」與「這份只能靠涵蓋範圍」。
 *
 * @param {string} pdfPath
 * @param {{ocr:object, extractItemsOcr:Function, filetypes:object, parser:object, width?:number}} deps
 * @returns {Promise<Array<{header:object, dailyRows:Array}>>}
 */
async function scanDays(pdfPath, deps = {}) {
  const {
    ocr, extractItemsOcr, filetypes, parser, width,
  } = deps;
  if (typeof extractItemsOcr !== 'function') throw new Error('scanDays 需要注入 extractItemsOcr');
  if (!parser || typeof parser.parseAll !== 'function') throw new Error('scanDays 需要注入 parser.parseAll');
  const pages = await extractItemsOcr(pdfPath, { ocr, width: width || SCAN_WIDTH });
  return parser.parseAll(pdfPath, {
    filetypes: { ...(filetypes || {}), extractItems: async () => pages },
  });
}

module.exports = {
  scanCoverage, scanDays, pageHeader, SCAN_WIDTH,
};
