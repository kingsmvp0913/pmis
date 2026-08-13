/**
 * daily-log-merge.js — 多個檔案的逐日結構合併(純函式)
 *
 * ## 為什麼需要這一層
 *
 * 有兩種情形,一個工程的一段期間**分散在多個檔案**,而 `parseAll` 一次只吃一個檔:
 *
 * 1. **兩聯分成兩個檔**(明德):第一聯有天氣與累計進度、明細沒有單價也沒有金額;
 *    第二聯有完整明細含單價與金額、但沒有天氣也沒有進度。只讀一個檔,不是少了
 *    天氣與進度,就是少了單價與金額——而**兩者都不會讓任何欄位「看起來」有問題**,
 *    SP3 只會說「此格式不提供」然後放行。
 * 2. **一案多份月檔**(久木 6 份、正郁的月份分頁互相涵蓋):單檔跑 SP3 時,
 *    每一份的第一天都帶著前幾個月累積出來的累計值,而本檔內只累加得到當月量,
 *    B3/F4 必然大量硬錯(久木實測單檔 157~762 個,合併後 0)。
 *
 * 承辦人 2026-08-13 選定的作法:**一次上傳多個檔,系統依填報日期合併**。
 *
 * ## 合併規則(每一條都對著一種會靜默出錯的情形)
 *
 * - **鍵是填報日期**,不是檔案順序。第一聯與第二聯的頁序不保證一致
 *   (賜利發那家實測就是倒的),靠順序配會把兩天的資料對調。
 * - **header 逐欄取「有值的那個」**,不是整份取代。兩個檔各有一半欄位,
 *   整份取代等於永遠丟掉另一半。
 * - **兩邊同一欄都有值且不同 → 保留先出現的,並記進 conflicts**。
 *   靜默挑一個會讓「兩份檔其實不是同一天/同一案」這種事永遠看不見。
 * - **dailyRows 取「明細比較完整」的那一份**,不逐列合併:兩份的列順序與項次
 *   體系可能不同(第一聯用名稱、第二聯有項次欄),逐列合併要先解決對應問題,
 *   而對應錯了會把兩個項目的數字混在一起——比少一欄嚴重得多。
 *   完整度先看「有幾列有契約單價」(那是第二聯才有的),再看列數。
 *
 * Exports:
 *   mergeDays(dayLists)  → { days, conflicts }
 */

// header 裡「有值就該補進來」的欄位。刻意列舉而不是掃全部鍵:
// 冒出新欄位時要有人決定它該不該合併,而不是預設合併。
const HEADER_FIELDS = [
  '工程名稱', '填報日期', '星期', '天氣_上午', '天氣_下午',
  '預定進度', '實際進度', '出工總人數', '本日累計金額', '承包廠商', '開工日期',
];

const isBlank = (v) => v == null || (typeof v === 'string' && v.trim() === '');

/** 明細完整度:有單價的列數優先,其次列數。單價是第二聯才有的東西。 */
function completeness(day) {
  const rows = (day && day.dailyRows) || [];
  return [rows.filter((r) => r.契約單價 != null).length, rows.length];
}

/** a 比 b 完整? */
function moreComplete(a, b) {
  const [a1, a2] = completeness(a);
  const [b1, b2] = completeness(b);
  return a1 > b1 || (a1 === b1 && a2 > b2);
}

/**
 * 把多個檔案的逐日結構合併成一份。
 *
 * @param {Array<Array<object>>} dayLists 每個檔案的 parseAll 輸出
 * @returns {{days: Array<object>, conflicts: Array<{日期:string, 欄位:string, 值:Array}>}}
 *   days 依填報日期排序;conflicts 是「同一天同一欄,兩個檔給了不同的值」
 */
function mergeDays(dayLists) {
  const byDate = new Map();
  const conflicts = [];

  for (const list of dayLists || []) {
    for (const d of list || []) {
      const key = d && d.header && d.header.填報日期;
      if (!key) continue;                                // 沒有日期就無從合併
      const prev = byDate.get(key);
      if (!prev) {
        byDate.set(key, { header: { ...d.header }, dailyRows: d.dailyRows || [], extras: { ...(d.extras || {}) } });
        continue;
      }
      for (const f of HEADER_FIELDS) {
        const a = prev.header[f];
        const b = d.header[f];
        if (isBlank(b)) continue;
        if (isBlank(a)) { prev.header[f] = b; continue; }
        // 兩邊都有值且不同:保留先出現的,但一定要報出來。靜默挑一個會讓
        // 「這兩份檔其實不是同一案」這種事永遠看不見。
        if (String(a) !== String(b)) conflicts.push({ 日期: key, 欄位: f, 值: [a, b] });
      }
      if (moreComplete(d, prev)) prev.dailyRows = d.dailyRows || [];
      for (const [k, v] of Object.entries(d.extras || {})) {
        if (prev.extras[k] == null) prev.extras[k] = v;
      }
    }
  }

  const days = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, d]) => d);
  return { days, conflicts };
}

module.exports = { mergeDays, completeness };
