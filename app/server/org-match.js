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
    // OCR 有時把半形連字號 '-' 誤讀成視覺相近的西式破折號,收斂 em dash(—)、
    // en dash(–)為半形連字號。**這條規則涵蓋不到元長國小案例**——實測(見下面
    // 「一」的正規化)發現那份文件 OCR 誤讀出的其實是中文數字「一」而不是破折號,
    // 兩種截然不同的誤讀在畫面截圖上幾乎分辨不出來,故兩條規則都留著、各自處理
    // 各自的實測案例,不可只留其中一條。
    .replace(/[—–]/g, '-')
    // 「一」正規化為連字號:**嚴格限縮在前後都是阿拉伯數字**時才轉換
    // (元長國小實測:OCR 把「114-116年」的半形連字號讀成「114一116年」)。
    // 「一」本身是合法中文字(「第一期工程」「一號橋」),範圍放寬一步就會反過來
    // 破壞這些正常名稱的比對,故不可用「前面是數字」或「後面是數字」單邊判斷,
    // 也不可擴及全形數字之間的「一」(如日期用語)——必須放在全形→半形轉換
    // **之後**,否則全形數字尚未轉換,前後是否為阿拉伯數字的邊界判斷會失準。
    .replace(/(\d)一(?=\d)/g, '$1-')
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
