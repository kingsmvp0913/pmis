/**
 * daily-log-scan.js — 無文字層(掃描件)施工日誌的**涵蓋範圍偵測**。
 *
 * ## 為什麼只做這件事,不直接把 OCR 接成讀取器的後備
 *
 * 實測(饒平 `0711A-0711A.pdf`,文字層當答案卷,同一份檔兩條路比對):
 *
 * | 解析度 | 數字格正確 | 讀不到→null | **讀成別的數字** |
 * |---|---|---|---|
 * | 1600 | 38.9% | 61.1% | 0.0% |
 * | **2200** | **51.5%** | 47.9% | **0.6%** |
 * | 2800 | 45.5% | 52.7% | 1.8% |
 * | 3400 | 43.7% | 51.5% | 4.8% |
 * | 5000 | 12.6% | 78.4% | 9.0% |
 * | 兩解析度取共識 | 42.5% | 56.9% | 0.6% |
 *
 * 明細數量最好也只救得回一半,而且**還是有 0.6% 讀成另一個合法數字**
 * (實測 21→20、2590.00→09)。那種錯 SP3 一條都攔不住:值本身自洽,
 * 累計也自洽,一路寫進每日施工紀錄 → 監造報表 → 估驗計價。
 * 「少一格」看得見(完整性關卡會報),「多一個錯的數字」看不見——
 * 所以**明細一律不走 OCR**。
 *
 * 反過來,**表頭那一行 OCR 非常穩**:鎮西 60 頁實測填報日期 100% 正確、0 讀錯
 * (天氣、工程名稱、工期、進度同一行也都對)。字大、獨立、沒有格線干擾。
 * 那就只用它做一件有價值的事:**告訴承辦人這份掃描件涵蓋哪些日期**——
 * 把「這份讀不到」變成「這份是 6/1~6/30 共 30 天,內容要人工補」,
 * 也能判斷這份掃描件是不是與已經讀得到的檔重複(宜謙 31 份裡有 14 份就是重複的)。
 *
 * Exports:
 *   scanCoverage(pdfPath, {ocr, extractItemsOcr, width}) → { pages, days, 日期, 缺日期頁 }
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

module.exports = { scanCoverage, pageHeader };
