/**
 * daily-log-validate.js — 施工日誌驗證(SP3,純函式)
 *
 * 依 `docs/samples/驗證清單/監造報表_施工日誌驗證檢查清單_v1.xlsx` 實作。
 * 該清單共 46 條,客戶勾除 7 條(B1/D2/G5/H2/I1/I2/I3),實作 39 條。
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

// 金額與數量在 PDF/Excel 來回轉換後會帶浮點尾差(實測金大 header 的本日累計金額
// 是 10400.248),用嚴格相等會把整份日誌判成錯。容差取 0.01 元/單位。
const approx = (a, b) => Math.abs(a - b) < 0.01;
// 大小比較同樣要吃掉尾差。晉林那份實測跑出 81 個「累計 1.0000000000000002 超過
// 契約數量 1」的假硬錯,全是浮點累加誤差——承辦人會在假警報裡找不到真問題。
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
const squash = (s) => String(s == null ? '' : s).replace(/[\s　]/g, '');

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
function validateDailyLog({ days = [], contract = [], project = {} } = {}) {
  const errors = [];
  const warnings = [];
  const skipped = [];
  const hard = (code, 日期, 項次, 訊息) => errors.push({ code, 日期, 項次, 訊息 });
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
  skipped.push(...NEVER_AVAILABLE);
  const skippedCodes = new Set(skipped.map((s) => s.code));

  // 逐項的跨日狀態:上一日累計數量、推導到目前為止的累計金額。
  const prevCum = new Map();
  const cumAmount = new Map();
  const prevUnit = new Map();
  const dailySum = new Map();  // F4:各日本日完成的累加
  const lastCum = new Map();   // F4:期末(最後一天)的累計值
  let prevProgress = null;

  // 契約表以項次為鍵。SP2 建的契約詳細價目表是**唯一權威基準**——
  // 日誌自己填的契約數量/單價只是待驗資料,不能拿來當基準。
  const contractByNo = new Map(contract.map((c) => [String(c.項次), c]));
  const seenItemNos = new Set();
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

    for (const r of d.dailyRows || []) {
      if (isCategoryRow(r)) continue;
      const 項次 = r.項次 == null ? null : String(r.項次);
      if (isBlank(r.項次)) hard('A4', 日期, null, '項次未填');
      if (isBlank(r.工程項目)) hard('A5', 日期, 項次, '工程項目名稱未填');
      if (isBlank(r.單位)) hard('A6', 日期, 項次, '單位未填');
      if (r.契約數量 == null) hard('A7', 日期, 項次, '契約數量未填');

      if (項次 != null) seenItemNos.add(項次);

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
      const c = 項次 == null ? null : contractByNo.get(項次);
      if (項次 != null && contract.length && !c) {
        hard('E1', 日期, 項次, '此項次在契約詳細價目表中不存在');
      } else if (c) {
        if (squash(r.工程項目) !== squash(c.項目)) {
          soft('E3', 日期, 項次, `項目名稱與契約表不一致(契約表:${c.項目})`);
        }
        if (!isBlank(r.單位) && squash(r.單位) !== squash(c.單位)) {
          hard('E4', 日期, 項次, `單位與契約表不一致(契約表:${c.單位})`);
        }
        if (num(r.契約數量) != null && !approx(num(r.契約數量), Number(c.數量))) {
          hard('E5', 日期, 項次, `契約數量與契約表不一致(契約表:${c.數量})`);
        }
        if (num(r.契約單價) != null && !approx(num(r.契約單價), Number(c.單價))) {
          hard('E6', 日期, 項次, `契約單價與契約表不一致(契約表:${c.單價})`);
        }
      }

      const 本日量 = num(r.本日完成數量);
      const 本日金額 = num(r.本日完成金額);
      const 累計量 = num(r.累計完成數量);
      const 單價 = num(r.契約單價);
      const 契約量 = num(r.契約數量);

      if (本日量 != null && 本日量 > 0 && 本日金額 == null && !skippedCodes.has('B3')) {
        hard('A8', 日期, 項次, '本日有施工,但本日完成金額讀不到');
      }

      // B2 累計 = 前一日累計 + 本日完成
      const 前一日 = prevCum.get(項次);
      if (累計量 != null && 本日量 != null && 前一日 != null
        && !approx(累計量, 前一日 + 本日量)) {
        hard('B2', 日期, 項次,
          `累計完成數量 ${累計量} 不等於前一日累計 ${前一日} 加本日完成 ${本日量}`);
      }
      // F1 累計不得逐日變小:做過的量不會消失,變小代表某一天填錯了
      if (累計量 != null && 前一日 != null && lt(累計量, 前一日)) {
        hard('F1', 日期, 項次, `累計完成數量從 ${前一日} 掉到 ${累計量}`);
      }
      if (累計量 != null) prevCum.set(項次, 累計量);
      // F4 用的:各日本日完成的總和,最後與期末累計對照
      if (本日量 != null) dailySum.set(項次, (dailySum.get(項次) || 0) + 本日量);
      if (累計量 != null) lastCum.set(項次, 累計量);

      // B3 兩種算法交叉核對:逐日累加的本日完成金額 vs 累計完成數量×契約單價。
      // 讀取器不提供「累計完成金額」,故累計金額一律由前者推導(總覽 spec §5)。
      if (!skippedCodes.has('B3') && 本日金額 != null) {
        const 累計金額 = (cumAmount.get(項次) || 0) + 本日金額;
        cumAmount.set(項次, 累計金額);
        if (累計量 != null && 單價 != null && !approx(累計金額, 累計量 * 單價)) {
          hard('B3', 日期, 項次,
            `累加的完成金額 ${累計金額} 與「累計數量 ${累計量} × 單價 ${單價}」不符`);
        }
      }

      // C1/C3 逐列範圍檢查
      if (累計量 != null && 契約量 != null && gt(累計量, 契約量)) {
        hard('C1', 日期, 項次, `累計完成數量 ${累計量} 超過契約數量 ${契約量}`);
      }
      for (const [欄, v] of [['本日完成數量', 本日量], ['本日完成金額', 本日金額],
        ['累計完成數量', 累計量]]) {
        if (v != null && v < 0) hard('C3', 日期, 項次, `${欄}為負值(${v})`);
      }
    }

    // B4 header 的本日累計金額 vs 各項推導累計金額的總和。
    // header 值是廠商自己填的日層級權威值,與逐項加總對不上就是兩邊兜不起來。
    if (!skippedCodes.has('B4') && h.本日累計金額 != null) {
      const 總和 = [...cumAmount.values()].reduce((s, v) => s + v, 0);
      if (!approx(Number(h.本日累計金額), 總和)) {
        hard('B4', 日期, null,
          `本日累計金額 ${h.本日累計金額} 與各項累計金額總和 ${總和} 不符`);
      }
    }

    // C4 進度值域。實測三家給的是比例(0.75/0.477)而非百分數,兩種都合法——
    // 這條擋的是 -3 或 250 這種明顯壞掉的值。
    for (const 欄 of ['預定進度', '實際進度']) {
      const v = num(h[欄]);
      if (v != null && (v < 0 || v > 100)) hard('C4', 日期, null, `${欄} ${v} 不在 0~100`);
    }

    // F3 實際進度不得逐日變小(軟警告:也可能是廠商重新估算)
    const 實際 = num(h.實際進度);
    if (實際 != null && prevProgress != null && lt(實際, prevProgress)) {
      soft('F3', 日期, null, `實際進度從 ${prevProgress} 掉到 ${實際}`);
    }
    if (實際 != null) prevProgress = 實際;

    // H1 落後門檻:實際比預定低 10 個百分點以上。實測各家給的是比例(0.75)或
    // 百分數(75),故先統一換算再比,否則比例制的案子永遠不會觸發。
    const 預定 = num(h.預定進度);
    if (實際 != null && 預定 != null) {
      const toPct = (v) => (Math.abs(v) <= 1 ? v * 100 : v);
      if (toPct(實際) - toPct(預定) < -10) {
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

  // F4 期末累計 = 各日本日完成的總和。**期末指這批日誌的最後一天**,不是竣工日:
  // 跨批次提交時等竣工才驗會太晚,而每一批自己都該兜得起來。
  for (const [項次, 累計] of lastCum) {
    const 總和 = dailySum.get(項次);
    if (總和 != null && !approx(累計, 總和)) {
      hard('F4', null, 項次, `期末累計 ${累計} 與各日本日完成的總和 ${總和} 不符`);
    }
  }

  // E2 契約表有、日誌整期都沒出現過。可能是漏做也可能是還沒做到那一項,
  // 故軟警告——判硬錯會讓工程做到一半時每次都被擋。
  for (const c of contract) {
    if (!seenItemNos.has(String(c.項次))) {
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

module.exports = { validateDailyLog, isCategoryRow };
