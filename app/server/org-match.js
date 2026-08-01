/**
 * org-match.js — 廠商/主辦機關的名稱正規化與逐字比對(純函式,不碰 DB 與檔案系統)
 *
 * Exports:
 *   normalizeOrgName(v) — trim + 全形轉半形 + 臺→台 + 移除所有空白;空值回 null
 *   extractCounty(name) — 由機關全名開頭抽出縣市;抽不到回 null
 *   findByName(list, name) — 正規化後**逐字相等**才命中
 *   COUNTIES — 22 個縣市
 *
 * 為何禁止模糊比對(spec §4.2):綁錯廠商的錯誤會一路污染監造報表與後續所有 SP,
 * 而多按一次「建立」的成本極低。實測佐證:vendors 現有的「晉林土木包工業」
 * (由 parser-onboarding 從施工日誌建立)與決標公告解析值逐字吻合。
 */

// 與 app/public/js/views/schools.js 的下拉共用同一份語意。兩處各一份是刻意的:
// 後端只用來抽 county,前端只用來畫下拉,為此建一支 API 過度設計。改動時兩邊都要動。
const COUNTIES = [
  '台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市',
  '基隆市', '新竹市', '新竹縣', '苗栗縣', '彰化縣', '南投縣',
  '雲林縣', '嘉義市', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣',
  '台東縣', '澎湖縣', '金門縣', '連江縣',
];

function normalizeOrgName(v) {
  if (v == null) return null;
  const s = String(v)
    // 全形英數與標點 → 半形
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    // 異體字:決標公告與開工報告表同一份文件內即混用
    .replace(/臺/g, '台')
    // OCR 常把半形連字號 '-' 誤讀成視覺相近的破折號,決標公告與開工報告表因此
    // 在同一段編號/年度區間上出現不同字元但語意相同的寫法(元長國小案例實測:
    // 「114—116年」vs「114-116年」)。只收斂西式破折號家族(em dash — / en dash –),
    // **刻意不納入中文數字「一」**——「一」在「第一期工程」「一號橋」等正常語境下
    // 是合法中文字,當連字號處理會反過來破壞這些合法比對,見 org-match.test.js。
    .replace(/[—–]/g, '-')
    // 全形空白也要清:PDF 抽取常挾帶
    .replace(/[\s　]/g, '');
  return s === '' ? null : s;
}

function extractCounty(name) {
  const n = normalizeOrgName(name);
  if (n == null) return null;
  return COUNTIES.find((c) => n.startsWith(c)) || null;
}

function findByName(list, name) {
  const target = normalizeOrgName(name);
  if (target == null || !Array.isArray(list)) return null;
  return list.find((it) => normalizeOrgName(it && it.name) === target) || null;
}

module.exports = { normalizeOrgName, extractCounty, findByName, COUNTIES };
