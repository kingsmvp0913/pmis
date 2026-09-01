/**
 * daily-log-validate.js — 施工日誌驗證(SP3,純函式)
 *
 * 依 `docs/samples/驗證清單/監造報表_施工日誌驗證檢查清單_v1.xlsx` 實作。
 * 該清單共 46 條,客戶勾除 7 條(B1/D2/G5/H2/I1/I2/I3),實作 39 條。
 * 2026-08-15 承辦人逐家走查後再加三條,合計 **42 條**:
 *   A9 整天只有名稱、沒有單位與數量(優和那份 45 天 41 列,原本 42 條一條都不觸發)
 *   J5 名稱形狀健檢(原本只活在 scripts/check-parser.js,產線沒有防線)
 *   D5 當月最後一天要有完整明細(逐日只列當天施作的格式,沒有月結對帳點)
 *
 * 嚴重度二分(客戶已確認,不給強制產出):
 *   硬錯誤 → 阻擋寫入,列出**全部**錯誤位置(哪天/哪項次)
 *   軟警告 → 標示但可寫入
 *
 * ## 「抽不到」不等於「沒填」
 *
 * 金大那份 80 天的日誌,天氣欄**每一天**都是 null——讀取器抽不到,或那份文件格式
 * 本來就沒有這欄。照 A2 判硬錯的話,這家廠商的日誌 100% 過不了,而原因不是廠商
 * 漏填。故:**某欄位整份都缺 → 判定為「此格式不提供」,跳過相關驗證並列入
 * skipped**;只有部分天數缺 → 那才是真的漏填,照判硬錯。
 *
 * skipped 一定要回給呼叫端並顯示——靜默跳過會讓承辦人以為驗過了。
 * (同一個坑 SP1B 踩過:OCR 抽不到只能判 missing,不能判 diff。)
 */

const isBlank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const { normalizeItemNo } = require('./item-no');

/**
 * 名稱形狀健檢(J5)。**原本只活在 `scripts/check-parser.js`**——那是開發用腳本,
 * 產線的 daily-log-routes 不跑它,所以讀取器把名稱切錯時上線後一條防線都沒有。
 *
 * 為什麼非有不可:完整性關卡只看「單位/契約數量/契約單價是否為 null」,而
 * **名稱被切錯不會讓任何欄位變 null**;E3(與契約表比名稱)只在有外部契約表時才驗得動。
 * 2026-08-15 逐家走查修掉的四支讀取器,壞法全是這一類——明德第二聯把長名稱的整列
 * 丟掉、富森把兩個項目的名稱黏在一起——**產線一個都擋不下來**。
 *
 * 這裡的規則刻意都**不需要外部基準**,單看名稱本身的形狀。
 */
const countOf = (s, re) => (s.match(re) || []).length;
const NAME_RULES = [
  { code: '標點開頭', why: '名稱前段可能被切掉(接到上一列去了)',
    test: (n) => /^[、，,;；。:：)）\]】}]/.test(n) },
  { code: '括號不對稱', why: '名稱可能在括號中途被截斷',
    test: (n) => countOf(n, /[(（]/g) !== countOf(n, /[)）]/g) },
  { code: '名稱過短', why: '可能只剩被切碎的殘骸',
    test: (n) => n.length < 3 },
];

/**
 * 掃描明細列的項目名稱形狀,回報疑似跨行重組錯位的列。
 * 同一項次的同一種異常只回報一次——同個項次通常每天都出現,重複 119 次只會淹掉輸出。
 * @param {Array<object>} rows dailyRows(可跨多天串接)
 * @returns {Array<{項次:string, code:string, why:string, 名稱:string}>}
 */
function detectNameAnomalies(rows) {
  const out = [];
  const seen = new Set();
  for (const r of rows || []) {
    if (isCategoryRow(r)) continue;              // 大類列本來就只有類別名,不是明細
    const name = r.工程項目 == null ? '' : String(r.工程項目).trim();
    if (!name) continue;                          // 空名稱由既有的 A5 必填檢查負責
    for (const rule of NAME_RULES) {
      if (!rule.test(name)) continue;
      const key = `${r.項次}|${rule.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ 項次: String(r.項次), code: rule.code, why: rule.why, 名稱: name });
    }
  }
  return out;
}

// 金額與數量在 PDF/Excel 來回轉換後會帶浮點尾差(實測金大 header 的本日累計金額
// 是 10400.248),用嚴格相等會把整份日誌判成錯。容差取 0.01 元/單位。
const approx = (a, b) => Math.abs(a - b) < 0.01;
// 金額另用元級容差:累加到百萬級時逐筆捨入的尾差會累積(金大實測本日累計金額
// 1483077 vs 各項加總 1483077.059)。金額以元為單位,不到半元的差是捨入而非填錯,
// 套數量那套 0.01 會生出 24 個假硬錯。半元是**單一個數**的上界,加總 M 個
// 各自捨入過的數時要乘 M —— 見 B4 的容差。
// 大小比較同樣要吃掉尾差。晉林那份實測跑出 81 個「累計 1.0000000000000002 超過
// 契約數量 1」的假硬錯,全是浮點累加誤差——承辦人會在假警報裡找不到真問題。
// 單價比對用**元級**容差。元長廁所實測:廠商 Excel 的營業稅單價是算出來的
// 51967.3(印出來顯示 51,967),而契約表(來自發包經費總表)存的是印出來的
// 整數 51967——差 0.3 元被 0.01 的容差判成硬錯,21 天每天一個,整份歸不了檔,
// 而兩邊其實是同一個數字。真的填錯(9,406 打成 9,460)差 54 元,遠在上界之外。
// ⚠️ **數量不比照辦理**:0.3 M2 是真的差,E5 維持 0.01。
const approxPrice = (a, b) => Math.abs(a - b) < 0.5;

// 訊息裡的**推導值**一律經過這裡。逐筆相加的浮點尾巴會原封不動印給承辦人看
// (明禮實測「與各項累計金額總和 72001.95000000001 不符」),看起來像系統壞掉,
// 而真正該看的是它與 59443.51 差了一萬多。只影響顯示,判定仍用原值。
const 顯示數 = (n) => (Number.isFinite(Number(n))
  ? String(Math.round(Number(n) * 100) / 100) : String(n));
const gt = (a, b) => a - b > 0.01;
const lt = (a, b) => b - a > 0.01;

// 大類標題列(金大實測第 1 列「壹 直接工程費」):單位/數量/單價本來就都空著。
// 不排除的話每一天都會生出 A5/A6/A7 三個假硬錯,承辦人幾天之後就學會忽略警告。
// **只認「三欄皆空」**:費用項目(貳~陸)有完整的單位數量單價,是真的項目。
function isCategoryRow(r) {
  return isBlank(r.單位) && r.契約單價 == null && r.契約數量 == null;
}

// header 裡會被「整份都缺」規則保護的欄位 → 對應的規則代碼與說明
const HEADER_FIELD_RULES = [
  { fields: ['天氣_上午', '天氣_下午'], code: 'A2', label: '天氣' },
  { fields: ['星期'], code: 'A3', label: '星期' },
];

// dailyRows 欄位缺漏時要跟著跳過的規則。摯東的讀取器不給「本日完成金額」
// (targetFields 裡就沒有),沒有這欄就推導不出累計金額,依賴它的檢查全部驗不了;
// 硬跑會把每一列都判成錯,真正的問題反而被淹掉。
const ROW_FIELD_RULES = [
  { field: '本日完成金額', codes: ['B3', 'B4', 'C2'], label: '本日完成金額' },
];

/**
 * 找出同一項目在多天資料中始終缺少契約數量的情況。
 *
 * 施工日誌的契約欄通常是固定版面；同一項連續多天都空白，代表來源格式沒有
 * 提供該值，不能逐日重複當成 A7 硬錯。只缺部分天數仍是實際漏填，照原規則擋下。
 */
function absentContractQtyItems(days) {
  const seen = new Map();
  for (const d of days) {
    for (const r of d.dailyRows || []) {
      if (isCategoryRow(r) || isBlank(r.項次)) continue;
      const key = String(r.項次);
      const state = seen.get(key) || { count: 0, allBlank: true };
      state.count++;
      if (r.契約數量 != null) state.allBlank = false;
      seen.set(key, state);
    }
  }
  return new Set([...seen].filter(([, s]) => s.count >= 2 && s.allBlank).map(([key]) => key));
}

// 讀取器**從來沒有**提供過的欄位。三家的 dailyRows 都只有 8 欄,沒有「完成百分比」,
// 故 B5 恆驗不了。不能靜默當作通過——沒驗到什麼一定要講。
const NEVER_AVAILABLE = [
  { code: 'B5', 原因: '施工日誌讀取器不提供「完成百分比」欄位,無從比對,已跳過此項檢查' },
  { code: 'E7', 原因: '施工日誌不提供「契約複價」欄位;契約表自身的複價一致性已於建立契約詳細價目表時驗過' },
  // 累計完成金額沒有獨立來源(讀取器不給該欄),推導值是逐日累加的結果、天然不會
  // 回退,拿它驗「不回退」等於自己驗自己。負的本日金額由 C3 擋。
  { code: 'F2', 原因: '施工日誌不提供「累計完成金額」欄位,累計金額為系統推導值、不會回退,此項無從驗起' },
];

// J1 天氣值域。取自實測與一般公共工程用語;不在集合內只給軟警告,
// 因為各廠商用詞不完全一致(「晴時多雲」「陣雨」),判硬錯會製造大量假警報。
const WEATHER = new Set(['晴', '陰', '多雲', '雨', '陣雨', '雷雨', '颱風', '霧', '雪', '晴時多雲', '多雲時晴', '陰時多雲']);

// J2 單位字典。同樣只給軟警告——這條真正的用途是抓「讀取器把項目名稱吃進單位欄」
// (金大實測項次 7、8 的單位被讀成 "RC"),而不是規範廠商用詞。
const UNITS = new Set(['式', 'M', 'M2', 'M3', 'm', 'm2', 'm3', '組', '間', '處', '才', '座',
  '片', '面', '個', '支', '只', '台', '套', '噸', 'KG', 'kg', '公斤', '公尺', '平方公尺',
  '立方公尺', '日', '天', '人', '車', '批', '式(含)', '樘', '扇', '棟', '層', '道', '孔']);

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

// 名稱比對一律去空白:排版差異不是實質不一致(沿用 org-match 的教訓)。
// 比對用的正規化:去空白 + NFKC。
//
// NFKC 把全形英數與全形標點折成半形——「復原，既有…復原；測量」與
// 「復原,既有…復原;測量」是同一個項目,契約表(來自發包經費總表)打全形、
// 廠商日誌打半形是常態。實測富森:光是這種差異就佔掉近兩成的名稱比對
// (逐字對上率 49% → 68%)。單位也受惠(「Ｍ2」→「M2」)。
//
// **刻意不自行統一「、」與「,」**:那兩個在中文裡語意不同(頓號列舉 vs 逗號分句),
// 硬統一是把一種誤判換成另一種。實測也顯示多做這層沒有額外效益。
const squash = (s) => String(s == null ? '' : s).normalize('NFKC').replace(/[\s　]/g, '');
// D5 的目的在於確認「是否有這一項」，不是審核標點。PDF 文字層常把全半形
// 標點、括號與換行轉成不同字元；只移除標點後仍須是唯一名稱才允許對應。
const looseName = (s) => squash(s).replace(/[、，,;；:：()（）\[\]【】]/g, '');

// 項次比對用的正規化。除了 squash,還要把**中文數字大寫的異體字**折成同一個字:
// 同一個工程的兩份文件會各寫各的(實測宜謙:發包後經費總表寫「参」U+53C2、
// 簡易棒球場的日誌寫「參」U+53C3)。NFKC 不折這一組(它們是異體字不是相容字),
// 於是 contractByNo 逐字相等永遠對不上、名稱又剛好也不同 → 名稱後備索引也救不了,
// 結果是**每天一個 E1 硬錯、86 天整份被擋**。
// 只折「同一個數字的不同寫法」,不碰語意不同的字。
const normNo = normalizeItemNo;
const tailNo = (s) => normNo(s).split('.').pop();

// 費用項目也要認名字,不能只看「項次不是阿拉伯數字」。
// 有一整類格式**沒有項次欄**,讀取器只能用出現序補(德信 14~18、以勒 5~9),
// 於是費用項的項次變成純數字,B2/F1/B3/C1 的降級分支就全部失效——
// 以勒實測:廠商把費用項的累計填成 1.028(契約數量 1),生出 5 個假硬錯。
// 名稱刻意只收工程會標準表單那幾個固定費用名目,不含「環境保護與清潔」這種
// 可能是真施工項目的字眼。
const FEE_NAME = /(職業安全衛生管理費|安全衛生管理費|品質管制作業費|包商管理費|包商利潤|管理費及利潤|利潤及管理費|營造綜合保險費|^保險費|營業稅|空氣污染防治費|營造廢棄物清運證明與環境清潔保護費)/;

const MS_PER_DAY = 86400000;
const dayNum = (iso) => {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? Math.round(t / MS_PER_DAY) : null;
};
// 週六日不填是常態(金大 04/10 週五之後直接跳到 04/13 週一),把假日當漏填
// 會讓每一份日誌都掛滿跳空警告。
const isWeekend = (serial) => {
  const wd = new Date(serial * MS_PER_DAY).getUTCDay();
  return wd === 0 || wd === 6;
};

/**
 * 找出「整份日誌都沒有值」的 header 欄位。
 * @returns {Set<string>}
 */
function absentHeaderFields(days) {
  const out = new Set();
  // 只有一天時,「整份都缺」與「這天漏填」是同一件事,分不出來。分不出來就
  // 不放行——寧可要承辦人確認一次,也不要把漏填當成格式限制放過去。
  if (days.length < 2) return out;
  const named = new Set(HEADER_FIELD_RULES.flatMap((r) => r.fields));
  for (const f of named) {
    if (days.every((d) => isBlank((d.header || {})[f]))) out.add(f);
  }
  return out;
}

/**
 * 驗證一批施工日誌。
 *
 * @param {object} input
 * @param {Array<{header:object, dailyRows:Array}>} input.days parseAll 的輸出
 * @param {Array} input.contract 契約詳細價目表項目(SP2 的 contract_items)
 * @param {object} input.project 專案主檔
 * @returns {{errors:Array, warnings:Array, skipped:Array}}
 *   errors/warnings 元素為 { code, 日期, 項次, 訊息 }
 */
function validateDailyLog({ days = [], contract = [], project = {}, prior = {} } = {}) {
  const errors = [];
  const warnings = [];
  const skipped = [];
  // 完工日之後的硬錯改列軟警告(見 completionDay)。日期為 null 的彙總類檢查
  // (F4/C2/E2)不受影響——那是「這批日誌自己兜不起來」,與完工與否無關。
  let 完工日序 = null;
  const hard = (code, 日期, 項次, 訊息) => {
    const 這天 = 日期 == null ? null : dayNum(日期);
    if (完工日序 != null && 這天 != null && 這天 > 完工日序) {
      warnings.push({ code, 日期, 項次, 訊息: `${訊息}(完工後的資料,僅供參考)` });
      return;
    }
    errors.push({ code, 日期, 項次, 訊息 });
  };
  const soft = (code, 日期, 項次, 訊息) => warnings.push({ code, 日期, 項次, 訊息 });

  const absent = absentHeaderFields(days);
  for (const { fields, code, label } of HEADER_FIELD_RULES) {
    if (fields.every((f) => absent.has(f))) {
      skipped.push({ code, 原因: `此廠商的日誌格式不提供「${label}」欄位(整份皆空),已跳過此項檢查` });
    }
  }
  // 明細欄位同理。判定看的是「所有天的所有明細列」,單天一樣不套用(理由同上)。
  const allRows = days.flatMap((d) => (d.dailyRows || []).filter((r) => !isCategoryRow(r)));
  for (const { field, codes: cs, label } of ROW_FIELD_RULES) {
    if (days.length >= 2 && allRows.length && allRows.every((r) => r[field] == null)) {
      for (const code of cs) {
        skipped.push({ code, 原因: `此廠商的日誌格式不提供「${label}」欄位(整份皆空),已跳過此項檢查` });
      }
    }
  }
  const 無契約數量項次 = absentContractQtyItems(days);
  for (const 項次 of 無契約數量項次) {
    skipped.push({ code: 'A7', 項次,
      原因: `項次「${項次}」在本批日誌每次出現時契約數量皆空白，來源格式未提供此值，已跳過 A7` });
  }
  skipped.push(...NEVER_AVAILABLE);
  const skippedCodes = new Set(skipped.map((s) => s.code));

  // 逐項的跨日狀態:上一日累計數量、推導到目前為止的累計金額。
  // 前期累計當起點:施工日誌分批提交,第二批的累計值包含前面批次做過的量。
  // 從 0 起算的話,B3 在每一批的第一天都必然誤判,承辦人送第二批就被擋死。
  const prevCum = new Map(Object.entries(prior).map(([k, v]) => [normNo(k), Number(v.數量) || 0]));
  const cumAmount = new Map(Object.entries(prior).map(([k, v]) => [normNo(k), Number(v.金額) || 0]));
  // B3 容差要隨累加筆數放寬:數量是比例時,每日金額各自四捨五入成整數,逐日累加
  // 後誤差會累積(玉森項次4:22003×2=44006,而 0.2×220027=44005.4,差 0.6)。
  // 每一筆的捨入本來就最多差半元,固定半元容差在第二天就爆掉。
  const amountTerms = new Map(Object.entries(prior).map(([k]) => [normNo(k), 1]));
  const prevUnit = new Map();
  // F4 的期初累計優先用已寫入報表的前期資料；單獨上傳某一個月的日誌時，資料庫
  // 還沒有前期紀錄，則由該項第一筆「累計－本日」推回期初。不能把期末累計直接
  // 與本次檔案的本日加總相比，否則 8 月檔會把 7 月以前已完成的量誤判為錯誤。
  const f4Base = new Map(Object.entries(prior).map(([k, v]) => [normNo(k), Number(v.數量) || 0]));
  const f4BaseKnown = new Set(f4Base.keys());
  const dailySum = new Map();
  const lastCum = new Map();   // F4:期末(最後一天)的累計值
  let prevProgress = null;

  // 進度欄的單位:**看整份的最大值,不看單一天**。
  // 舊寫法是逐值判「<= 1 就當比例」,在工期兩端都會誤判:
  //   開工頭幾天真的只有 0.28%(百分數)→ 被放大成 28%,每天噴假的 H1(宜謙實測);
  //   完工那幾天比例制跑到 1.0000007 → 被當成 1%,同樣噴假的 H1(久木實測)。
  // 一整份的最大值就沒有這個歧義:比例制的序列頂多到 1.0 出頭(捨入),
  // 百分數制的序列會上到幾十。門檻取 1.05 留給捨入,兩者之間差了兩個數量級。
  // 兩個欄位各自判——同一列一個是百分數、另一個是比例是實測到的(國謙)。
  const progressScale = (field) => {
    const vals = days.map((d) => num((d.header || {})[field])).filter((v) => v != null);
    if (!vals.length) return 1;
    return Math.max(...vals.map(Math.abs)) <= 1.05 ? 100 : 1;
  };
  const 預定Scale = progressScale('預定進度');
  const 實際Scale = progressScale('實際進度');

  // 完工日:實際進度首次達 100% 的那一天(日期最早者,不是 days 陣列的先後——
  // 一份檔案裡日期不保證遞增,富森那份 2026 的月份排在 2025 之前)。
  //
  // 為什麼要這條:廠商常把整個月的表格一次列印出來,工程在月中完工,後面那些天
  // 照樣印著日期卻沒有實質內容,或累計已超出契約量。承辦人被 C1/C4 一路擋住,
  // 而那不是廠商填錯。故**完工日之後的硬錯一律降為軟警告**(仍要列出來)。
  //
  // 上限 150 是壞值防線:實測超額完成最高到 115.74(富森),250 那種是讀錯或
  // 填錯,不能藉「完工」把 C4 的值域檢查整條廢掉。
  const COMPLETE_MIN = 99.995;
  const COMPLETE_MAX = 150;
  const 是完工進度 = (v) => v != null && v * 實際Scale >= COMPLETE_MIN
    && v * 實際Scale <= COMPLETE_MAX;
  for (const d of days) {
    const h = d.header || {};
    if (!是完工進度(num(h.實際進度))) continue;
    const s = dayNum(h.填報日期);
    if (s != null && (完工日序 == null || s < 完工日序)) 完工日序 = s;
  }
  if (完工日序 != null) {
    const 完工日 = new Date(完工日序 * MS_PER_DAY).toISOString().slice(0, 10);
    soft('完工', 完工日, null,
      '累積進度於此日達 100%,其後各日的硬錯已降為警告(廠商常把整月表格預先列印,'
      + '完工後那幾天不是填錯)');
  }

  // 契約表以項次為鍵。SP2 建的契約詳細價目表是**唯一權威基準**——
  // 日誌自己填的契約數量/單價只是待驗資料,不能拿來當基準。
  // 鍵一律走 normNo:兩份文件常把同一個中文數字寫成異體字(参/參),逐字相等對不上。
  const contractByNo = new Map();
  for (const c of contract) {
    const key = normNo(c.項次);
    contractByNo.set(key, contractByNo.has(key) ? null : c);
  }
  // 部分日誌省略契約項次的大類前綴(契約「壹.1」、日誌「1」)。前綴最後一段
  // 只有在整份契約中唯一時才可當別名；若「一.1／二.1」同時存在，猜測會把
  // 月底完整清單誤算成已齊，必須維持原本的明確比對。
  const contractByTailNo = new Map();
  for (const c of contract) {
    const key = tailNo(c.項次);
    contractByTailNo.set(key, contractByTailNo.has(key) ? null : c);
  }
  const contractOfNo = (no) => contractByNo.get(normNo(no)) || contractByTailNo.get(tailNo(no));
  // 項次對不上時的後備索引:項目名稱 → 契約項目。**只收名稱唯一的**——
  // 同名兩筆以上就無從判斷對到哪一筆,寧可維持 E1 硬錯也不猜,猜錯會把
  // 單位/數量/單價比到別的項目上,錯得比報 E1 更隱蔽。
  //
  // 為什麼需要這層:契約表(來自發包經費總表)把費用項目編成中文大寫(貳~陸),
  // 而廠商日誌把同一批編成接續的阿拉伯數字(32~36),是實測到的常態(南陽案)。
  // 只比項次的話,同一批項目每天都被判成「契約表中不存在」——105 天 × 5 項
  // = 525 個假硬錯,而硬錯整份擋下,承辦人被永久卡住且看不出真正原因。
  const contractByName = new Map();
  const contractByLooseName = new Map();
  for (const c of contract) {
    const key = squash(c.項目);
    if (!key) continue;
    contractByName.set(key, contractByName.has(key) ? null : c); // 撞名則標記為不可用
    const loose = looseName(c.項目);
    if (loose) contractByLooseName.set(loose, contractByLooseName.has(loose) ? null : c);
  }
  const seenItemNos = new Set();
  // 這一天實際涵蓋到的契約項次(已套用 normNo 與名稱對應的結果)。
  // D5 要用它而不是原始項次:見下面 D5 的說明。
  const 當日契約項次 = new Map();
  const seenDates = new Set();

  for (const d of days) {
    const h = d.header || {};
    const 日期 = h.填報日期;

    // 填報日期是所有逐日驗證的定位點。缺了就無從說「哪一天錯」,對這天再跑其他
    // 規則只會產生一串「日期 null」的錯誤,把真正的問題淹掉。
    if (isBlank(日期)) {
      hard('A1', null, null, '填報日期未填,無法定位這一天的資料');
      continue;
    }

    // D1 同一份出現兩個相同填報日期:那是同一天被送了兩次,累計會被算兩遍
    if (seenDates.has(日期)) hard('D1', 日期, null, '這一天在同一份日誌裡出現兩次');
    seenDates.add(日期);
    const 本日項次 = new Set();
    當日契約項次.set(d, 本日項次);

    // D3 填報日期落在工期外
    const 這天 = dayNum(日期);
    const 開工 = dayNum(project.開工日期);
    const 竣工 = dayNum(project.竣工日期);
    if (這天 != null && 開工 != null && 這天 < 開工) {
      hard('D3', 日期, null, `填報日期早於開工日 ${project.開工日期}`);
    }
    if (這天 != null && 竣工 != null && 這天 > 竣工) {
      hard('D3', 日期, null, `填報日期晚於竣工日 ${project.竣工日期}`);
    }

    if (!skippedCodes.has('A2') && (isBlank(h.天氣_上午) || isBlank(h.天氣_下午))) {
      hard('A2', 日期, null, '天氣(上午/下午)未填');
    }
    if (!skippedCodes.has('A3') && isBlank(h.星期)) {
      soft('A3', 日期, null, '星期未填(可由日期回推)');
    }

    // A9 這一天有明細列,但**沒有任何一列有單位/數量/單價**——整天都被 isCategoryRow
    // 濾掉,於是下面每一條規則都不會執行,整份日誌零錯誤通過。
    // 實測優和那份:45 天 / 41 列,單位與數量欄整份全空,三道關卡與 42 條規則
    // **一條都沒觸發**,可以一路寫進監造報表。承辦人 2026-08-15 裁決這種要退回。
    // ⚠️ 只在「有列但全是大類列」時判錯;整天 0 列是「當天沒施工」,同一天裁決為不處理。
    const 明細列 = (d.dailyRows || []).filter((r) => !isCategoryRow(r));
    if ((d.dailyRows || []).length > 0 && 明細列.length === 0) {
      hard('A9', 日期, null,
        '這一天的明細只有項目名稱,沒有單位也沒有數量,無法核對進度');
    }

    for (const r of d.dailyRows || []) {
      if (isCategoryRow(r)) continue;
      const 項次 = r.項次 == null ? null : String(r.項次);
      if (isBlank(r.項次)) hard('A4', 日期, null, '項次未填');
      if (isBlank(r.工程項目)) hard('A5', 日期, 項次, '工程項目名稱未填');
      if (isBlank(r.單位)) hard('A6', 日期, 項次, '單位未填');
      if (r.契約數量 == null && !無契約數量項次.has(項次)) {
        hard('A7', 日期, 項次, '契約數量未填');
      }

      if (項次 != null) seenItemNos.add(normNo(項次));

      // J2 單位字典;J3 同一項次跨天單位一致(與 E4 互補:E4 比契約表,J3 比自己)
      if (!isBlank(r.單位)) {
        if (!UNITS.has(String(r.單位).trim())) {
          soft('J2', 日期, 項次, `單位「${r.單位}」不在已知單位字典中`);
        }
        const 前單位 = prevUnit.get(項次);
        if (前單位 != null && 前單位 !== String(r.單位).trim()) {
          soft('J3', 日期, 項次, `單位與前幾日不一致(前為「${前單位}」,本日為「${r.單位}」)`);
        }
        prevUnit.set(項次, String(r.單位).trim());
      }

      // E 類:與 SP2 建好的契約詳細價目表逐項核對
      let c = 項次 == null ? null : contractOfNo(項次);
      // 項次查無 → 退而以項目名稱對應(見 contractByName 的說明)。
      // 項次查無，或項次雖撞到但名稱指向另一個唯一項目時，皆以名稱對應。
      // 橋頭實檔的契約把「直接工程費」算作第二項、施工日誌則略過它；兩邊從費用
      // 項目開始便整體差一格。若先相信撞到的項次，會把品質管制費拿去比職安費。
      let 依名稱對應 = false;
      if (項次 != null && contract.length && !isBlank(r.工程項目)) {
        const byName = contractByName.get(squash(r.工程項目))
          || contractByLooseName.get(looseName(r.工程項目));
        if (byName && (!c || squash(r.工程項目) !== squash(c.項目))) {
          c = byName;
          依名稱對應 = true;
        }
      }
      // 這一列到底涵蓋到哪個契約項次:對得上契約就記契約的編號,對不上就記自己的。
      // D5 靠這個集合判斷月末清單完不完整。
      if (c) 本日項次.add(normNo(c.項次));
      else if (項次 != null) 本日項次.add(normNo(項次));

      if (項次 != null && contract.length && !c) {
        hard('E1', 日期, 項次, '此項次在契約詳細價目表中不存在');
      } else if (c) {
        // 編號對不上仍要讓承辦人知道(兩份文件的編號體系不同),但不擋:
        // 名稱唯一相同已足以確認是同一項,擋下來只會讓整份日誌無法歸檔。
        if (依名稱對應) {
          soft('E1', 日期, 項次, `項次與契約表不同(契約表為「${c.項次}」),已依項目名稱對應`);
          // 對應成功代表這個契約項目其實有出現,只是編號不同。不補記的話
          // E2 會再補一刀「整期未出現」,同一件事被判錯兩次。
          seenItemNos.add(String(c.項次));
        }
        if (squash(r.工程項目) !== squash(c.項目)) {
          soft('E3', 日期, 項次, `項目名稱與契約表不一致(契約表:${c.項目})`);
        }
        if (!isBlank(r.單位) && squash(r.單位) !== squash(c.單位)) {
          hard('E4', 日期, 項次, `單位與契約表不一致(契約表:${c.單位})`);
        }
        if (num(r.契約數量) != null && !approx(num(r.契約數量), Number(c.數量))) {
          hard('E5', 日期, 項次, `契約數量與契約表不一致(契約表:${c.數量})`);
        }
        if (num(r.契約單價) != null && !approxPrice(num(r.契約單價), Number(c.單價))) {
          hard('E6', 日期, 項次, `契約單價與契約表不一致(契約表:${c.單價})`);
        }
      }

      // 跨日累計與金額一律使用已對應到的完整契約項次。若兩個大類底下都叫「1」，
      // 用日誌的裸項次當 key 會讓後一類覆蓋前一類。
      const 狀態項次 = c ? normNo(c.項次) : normNo(項次);

      const 本日量 = num(r.本日完成數量);
      const 本日金額 = num(r.本日完成金額);
      const 累計量 = num(r.累計完成數量);
      const 單價 = num(r.契約單價);
      const 契約量 = num(r.契約數量);

      if (本日量 != null && 本日量 > 0 && 本日金額 == null && !skippedCodes.has('B3')) {
        hard('A8', 日期, 項次, '本日有施工,但本日完成金額讀不到');
      }

      // B2 累計 = 前一日累計 + 本日完成
      // 費用項目(貳~陸)的數量欄語意各家不一:金大填「完成比例」、玉森的累計欄
      // 填的是本日值(天1 與天2 都是 0.012233,而同一天的施工項目正確累加)。
      // 硬套會生出 238 個假硬錯,把施工項目真正的累計錯誤淹掉。
      const 是費用項目 = !/^\d+$/.test(tailNo(狀態項次)) || FEE_NAME.test(squash(r.工程項目));
      const 前一日 = prevCum.get(狀態項次);
      if (累計量 != null && 本日量 != null && 前一日 != null
        && !approx(累計量, 前一日 + 本日量)) {
        const m = `累計完成數量 ${累計量} 不等於前一日累計 ${前一日} 加本日完成 ${本日量}`;
        if (是費用項目) soft('B2', 日期, 項次, `${m}(費用項目的數量欄語意各家不一,僅供參考)`);
        else hard('B2', 日期, 項次, m);
      }
      // F1 累計不得逐日變小:做過的量不會消失,變小代表某一天填錯了
      if (累計量 != null && 前一日 != null && lt(累計量, 前一日)) {
        const m = `累計完成數量從 ${前一日} 掉到 ${累計量}`;
        if (是費用項目) soft('F1', 日期, 項次, `${m}(費用項目的累計欄語意各家不一,僅供參考)`);
        else hard('F1', 日期, 項次, m);
      }
      if (累計量 != null) prevCum.set(狀態項次, 累計量);
      // F4 用的:期初累計 + 各日本日完成的總和 = 期末累計。
      // 若沒有資料庫的前期紀錄，第一筆同時有累計／本日數量的資料可以反推期初。
      // 缺任一欄便不做 F4 部分加總比對，避免把「讀不到」誤報為「不相符」。
      if (!f4BaseKnown.has(狀態項次) && 累計量 != null && 本日量 != null) {
        f4Base.set(狀態項次, 累計量 - 本日量);
        f4BaseKnown.add(狀態項次);
      }
      if (本日量 != null) dailySum.set(狀態項次, (dailySum.get(狀態項次) || 0) + 本日量);
      if (累計量 != null) lastCum.set(狀態項次, 累計量);

      // B3 兩種算法交叉核對:逐日累加的本日完成金額 vs 累計完成數量×契約單價。
      // 讀取器不提供「累計完成金額」,故累計金額一律由前者推導(總覽 spec §5)。
      if (!skippedCodes.has('B3') && 本日金額 != null) {
        const 累計金額 = (cumAmount.get(狀態項次) || 0) + 本日金額;
        cumAmount.set(狀態項次, 累計金額);
        const 筆數 = (amountTerms.get(狀態項次) || 0) + 1;
        amountTerms.set(狀態項次, 筆數);
        if (累計量 != null && 單價 != null
          && Math.abs(累計金額 - 累計量 * 單價) >= 0.5 * 筆數) {
          // 費用項目(貳~陸)的「完成數量」是**完成比例**而非數量(金大實測:貳的
          // 本日完成數量 0.003、金額 45,而 0.003×15996≈48),金額由廠商按自己的
          // 計價基準算,與「數量×單價」本來就不相乘。判硬錯會生出 317 個假警報,
          // 把施工項目那 1 個真問題淹掉——但也不能不報,故降為軟警告。
          const 訊息 = `累加的完成金額 ${顯示數(累計金額)} 與「累計數量 ${顯示數(累計量)}`
            + ` × 單價 ${顯示數(單價)}」不符`;
          if (是費用項目) {
            soft('B3', 日期, 項次, `${訊息}(費用項目的完成數量是比例,僅供參考)`);
          } else {
            hard('B3', 日期, 項次, 訊息);
          }
        }
      }

      // C1/C3 逐列範圍檢查。
      // C1 與 B2/F1/B3 同樣要放過費用項目:那幾列的「完成數量」各家語意不一,
      // 有的填比例、有的直接填金額(國謙實測填 56.53 元而契約數量是 1 式),
      // 判硬錯會生出 210 個假警報(5 項 × 42 天)把真問題淹掉。降為軟警告但仍要報。
      if (累計量 != null && 契約量 != null && gt(累計量, 契約量)) {
        const m = `累計完成數量 ${累計量} 超過契約數量 ${契約量}`;
        if (是費用項目) soft('C1', 日期, 項次, `${m}(費用項目的完成數量欄語意各家不一,僅供參考)`);
        else hard('C1', 日期, 項次, m);
      }
      for (const [欄, v] of [['本日完成數量', 本日量], ['本日完成金額', 本日金額],
        ['累計完成數量', 累計量]]) {
        if (v != null && v < 0) hard('C3', 日期, 項次, `${欄}為負值(${v})`);
      }
    }

    // B4 header 的本日累計金額 vs 各項「累計數量 × 單價」的總和。
    //
    // 不能用 cumAmount(本次匯入的本日金額累加)做這個比對:使用者可以只匯入
    // 某一段日期,但表尾的累計金額包含更早已施工的天數。這時本次本日金額合計
    // 會小於真正的各項累計金額,把正確資料誤判為 B4 錯誤。累計數量是每一天
    // 明細列本身提供的完整累計,乘上單價才是同一時間點、可直接與表尾相比的值。
    if (!skippedCodes.has('B4') && h.本日累計金額 != null) {
      const 累計金額列 = (d.dailyRows || []).filter((r) => !isCategoryRow(r))
        .map((r) => {
          const 累計量 = num(r.累計完成數量);
          const 單價 = num(r.契約單價);
          return 累計量 != null && 單價 != null ? 累計量 * 單價 : null;
        });
      // 有任何一個明細缺少推導所需數字時不能只拿部分列相加,否則會把「讀不到」
      // 誤報成「金額不符」。這種情況仍由 A7/E6/B3 等各自的規則指出原因。
      const 可比對 = 累計金額列.length > 0 && 累計金額列.every((v) => v != null);
      const 總和 = 可比對 ? 累計金額列.reduce((s, v) => s + v, 0) : null;
      // 容差隨累加的項目數放寬(同 B3 隨筆數放寬的理由)。header 這個值是廠商把
      // M 個「各自四捨五入成整數」的累計金額相加,與真值的距離上界就是 0.5 × M。
      // 固定 0.5 元的話,賜利發實測 33 項 21 天裡有 19 天被判硬錯(最大差 4 元)——
      // 整份日誌永遠歸不了檔,而承辦人怎麼查都查不出哪裡錯,因為根本沒錯。
      // 放寬到 0.5 × M(33 項 = 16.5 元)不會藏住真問題:漏一個項目的金額是
      // 幾千到幾十萬,遠在這個上界之外。
      const 容差 = Math.max(0.5, 0.5 * 累計金額列.length);
      if (總和 != null && Math.abs(Number(h.本日累計金額) - 總和) >= 容差) {
        hard('B4', 日期, null,
          `本日累計金額 ${顯示數(h.本日累計金額)} 與各項累計金額總和 ${顯示數(總和)} 不符`);
      }
    }

    // C4 進度值域。實測三家給的是比例(0.75/0.477)而非百分數,兩種都合法——
    // 這條擋的是 -3 或 250 這種明顯壞掉的值。
    for (const 欄 of ['預定進度', '實際進度']) {
      const v = num(h[欄]);
      if (v == null || (v >= 0 && v <= 100)) continue;
      // 超過 100 的那個值,在完工當天就已經出現(富森實測完工日自己是 100.27)。
      // 只降級「完工日之後」會留下這一個硬錯,整份照樣被擋 → 完工日當天也放行。
      if (v > 100 && 完工日序 != null && 這天 != null && 這天 >= 完工日序) {
        soft('C4', 日期, null, `${欄} ${v} 超過 100(已達完工進度,僅供參考)`);
      } else {
        hard('C4', 日期, null, `${欄} ${v} 不在 0~100`);
      }
    }

    // F3 實際進度不得逐日變小(軟警告:也可能是廠商重新估算)
    const 實際 = num(h.實際進度);
    if (實際 != null && prevProgress != null && lt(實際, prevProgress)) {
      soft('F3', 日期, null, `實際進度從 ${prevProgress} 掉到 ${實際}`);
    }
    if (實際 != null) prevProgress = 實際;

    // H1 落後門檻:實際比預定低 10 個百分點以上。各家給的是比例(0.75)或
    // 百分數(75),要先統一單位再比。**單位一律看整份的最大值決定,不看單一天**
    // (見 progressScale 的說明)。
    const 預定 = num(h.預定進度);
    if (實際 != null && 預定 != null) {
      if (實際 * 實際Scale - 預定 * 預定Scale < -10) {
        soft('H1', 日期, null,
          `實際進度落後預定超過 10%(預定 ${預定}、實際 ${實際})`);
      }
    }

    // J1 天氣值域
    for (const 欄 of ['天氣_上午', '天氣_下午']) {
      const w = h[欄];
      if (!isBlank(w) && !WEATHER.has(String(w).trim())) {
        soft('J1', 日期, null, `${欄}「${w}」不在已知天氣用語中`);
      }
    }

    // J4 星期與日期推算不符。格式有「星期三」與「三」兩種(實測金大 vs 晉林)
    if (!isBlank(h.星期) && 這天 != null) {
      const 應為 = WEEKDAY[new Date(這天 * MS_PER_DAY).getUTCDay()];
      if (!String(h.星期).includes(應為)) {
        soft('J4', 日期, null, `星期「${h.星期}」與日期推算的「星期${應為}」不符`);
      }
    }

    // G 類:日誌 header 與專案主檔比對。名稱類差空白不算不一致。
    if (!isBlank(h.工程名稱) && !isBlank(project.工程名稱)
      && squash(h.工程名稱) !== squash(project.工程名稱)) {
      soft('G1', 日期, null, `工程名稱與主檔不一致(主檔:${project.工程名稱})`);
    }
    if (!isBlank(h.承包廠商) && !isBlank(project.承包廠商)
      && squash(h.承包廠商) !== squash(project.承包廠商)) {
      soft('G2', 日期, null, `承包廠商與主檔不一致(主檔:${project.承包廠商})`);
    }
    if (!isBlank(h.開工日期) && !isBlank(project.開工日期)
      && String(h.開工日期) !== String(project.開工日期)) {
      soft('G3', 日期, null, `開工日期與主檔不一致(主檔:${project.開工日期})`);
    }
    if (num(h.契約金額) != null && num(project.契約金額) != null
      && !approx(num(h.契約金額), num(project.契約金額))) {
      soft('G4', 日期, null, `契約金額與主檔不一致(主檔:${project.契約金額})`);
    }
  }

  // F4 期末累計 = 期初累計 + 各日本日完成的總和。**期末指這批日誌的最後一天**,
  // 不是竣工日；分批上傳時仍能核對本批增量，而不會把前期已完成的量算成錯。
  for (const [項次, 累計] of lastCum) {
    const 總和 = dailySum.get(項次);
    const 期初 = f4Base.get(項次);
    if (總和 != null && f4BaseKnown.has(項次) && !approx(累計, 期初 + 總和)) {
      const m = `期末累計 ${顯示數(累計)} 不等於期初累計 ${顯示數(期初)} 加各日本日完成總和 ${顯示數(總和)}`;
      if (!/^[0-9]+$/.test(tailNo(項次))) soft('F4', null, 項次, `${m}(費用項目的累計欄語意各家不一,僅供參考)`);
      else hard('F4', null, 項次, m);
    }
  }

  // E2 契約表有、日誌整期都沒出現過。可能是漏做也可能是還沒做到那一項,
  // 故軟警告——判硬錯會讓工程做到一半時每次都被擋。
  for (const c of contract) {
    if (!seenItemNos.has(normNo(c.項次))) {
      soft('E2', null, String(c.項次), `契約項目「${c.項目}」在這批日誌裡整期都沒出現過`);
    }
  }

  // D4 工期內連續多個工作日整天沒資料。假日不填是常態,只數工作日。
  const dates = days.map((d) => dayNum((d.header || {}).填報日期)).filter((v) => v != null)
    .sort((a, b) => a - b);
  for (let i = 1; i < dates.length; i++) {
    let gap = 0;
    for (let s = dates[i - 1] + 1; s < dates[i]; s++) if (!isWeekend(s)) gap++;
    if (gap > 0) {
      soft('D4', null, null,
        `${new Date(dates[i - 1] * MS_PER_DAY).toISOString().slice(0, 10)} 與 ` +
        `${new Date(dates[i] * MS_PER_DAY).toISOString().slice(0, 10)} 之間有 ${gap} 個工作日沒有資料`);
    }
  }

  // J5 名稱形狀健檢(見檔頭)。軟警告:形狀可疑不等於一定錯——來源本身就可能少打
  // 一個右括號(以勒實測,`基本資料!K8` 就是那樣),照擋會把來源的錯算到廠商頭上。
  // 真正的用途是讓「讀取器把名稱切錯」在產線上**看得見**,而不是靜靜寫進報表。
  for (const a of detectNameAnomalies(days.flatMap((d) => d.dailyRows || []))) {
    soft('J5', null, a.項次, `項目名稱形狀可疑(${a.code}):「${a.名稱}」——${a.why}`);
  }

  // D5 每個月的最後一天要列出全部項目(承辦人 2026-08-15 裁決)。
  // 有些格式**逐日只列當天施作的項目**(利成 96 天 86 列、沅隆、嘉原),平常沒問題,
  // 但這樣就沒有任何一天可以拿來對「到這個月為止總共做了多少」。
  // 折衷:平日照舊,**當月最後一天必須是完整清單**,承辦人才有月結的對帳點。
  // 基準優先用真實契約表;沒有契約表時(自我基準)用這批日誌出現過的全部項次。
  // ⚠️ 比對一律走 normNo,而且用**已對應到契約的項次**(當日契約項次),不是原始項次。
  // 廠商把費用項目編成接續的阿拉伯數字(南陽 32~36)或異體中文數字(参),E1 早就
  // 依項目名稱對回契約的「貳~陸」並放行;D5 若還逐字比原始項次,同一批項目每個
  // 月末都會被判成「缺 5 項」——2026-08-17 實測元長鋪面、橋頭許厝分校、鹿場
  // 三案全中,而 D5 是硬錯,整份日誌卡住且訊息完全指不到真正原因。
  const 應有項次 = contract.length ? contract.map((c) => String(c.項次)) : [...seenItemNos];
  const 月末 = new Map();
  for (const d of days) {
    const 日 = (d.header || {}).填報日期;
    if (isBlank(日)) continue;
    const 月 = String(日).slice(0, 7);
    const cur = 月末.get(月);
    if (!cur || 日 > cur.日) 月末.set(月, { 日, d });
  }
  // 只驗**已經收完**的月份。月中上傳是常態(廠商 7 月的檔裡常多印幾天,或整月
  // 表格預先列印到下個月),那時「這批的最後一天」不是月結點,拿它要求完整清單
  // 就是硬擋一份沒有錯的日誌——2026-08-17 實測元長鋪面被判 8/7、橋頭許厝分校
  // 被判 9/12,承辦人歸檔不了。判準二選一:那天就是該月最後一天(廠商真的做到
  // 月底),或後面還有別的月份的資料(有後續就代表這個月收完了)。
  const 月末的月 = [...月末.keys()].sort();
  const 是月底 = (iso) => {
    const [y, m, dd] = String(iso).split('-').map(Number);
    return dd === new Date(Date.UTC(y, m, 0)).getUTCDate();
  };
  for (const [月, { 日, d }] of 月末) {
    if (!是月底(日) && 月 === 月末的月[月末的月.length - 1]) continue;
    const 有 = 當日契約項次.get(d) || new Set();
    const 缺 = 應有項次.filter((n) => !有.has(normNo(n)));
    if (缺.length) {
      hard('D5', 日, null,
        `當月最後一天只列了 ${有.size} 項,缺 ${缺.length} 項(${缺.slice(0, 5).join('、')}`
        + `${缺.length > 5 ? '…' : ''});月結要有一天是完整清單才對得起來`);
    }
  }

  // C2 全案累計完成金額不得超過契約金額
  if (!skippedCodes.has('C2') && project.契約金額 != null) {
    const 總累計 = [...cumAmount.values()].reduce((s, v) => s + v, 0);
    if (gt(總累計, Number(project.契約金額))) {
      hard('C2', null, null,
        `累計完成金額 ${總累計} 超過契約金額 ${project.契約金額}`);
    }
  }

  return { errors, warnings, skipped };
}

module.exports = { validateDailyLog, isCategoryRow, detectNameAnomalies, NAME_RULES };
