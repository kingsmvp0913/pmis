/**
 * yusen.pmisparser.js — 玉森(大有國小)施工日誌第二聯讀取器
 *
 * 來源:`玉森大有國小公共工程施工日誌第二聯.xls`,2 分頁:
 *   - `進度`                     日期 / 累計天數 / 每日預計進度 / 累計預計進度
 *   - `施工日誌(第二聯)-全 (修)` 91 個天區塊,間距 45,八欄俱全
 *
 * vendorKey 曾被**推定**為「玉森營造有限公司」(樣本檔的第二聯簽名欄與進度分頁
 * 都沒有廠商全名,當初依同批其他廠商的命名慣例猜的)。2026-08-07 以 5 個舊案的
 * **決標公告**核對,得標廠商一致是「玉森土木包工業」,已更正。
 *
 * 這個字串猜錯的後果沒有任何錯誤訊息:`org-match.findByName` 是逐字相等,
 * 名字不符就查不到廠商,讀取器明明完全讀得動也永遠叫不出來——看起來就像
 * 「這家還沒有讀取器」。5 案 71 份日誌都因此閒置。
 * **vendorKey 的權威來源是決標公告的得標廠商,不是樣本檔、更不是命名慣例。**
 *
 * ── 版面事實(實測)──
 * 天區塊起始 = 第 0 欄為「第二聯」的列;表頭在 +2、明細自 +3 起,
 * 讀到項次不再是數字/中文大寫即停(其後是「累計(本日完成金額)」與簽名欄)。
 * 欄位:項次 0 / 工程項目 1 / 單位 2 / 契約單價 3 / 契約數量 4 /
 *       本日完成數量 6 / 本日完成金額 7 / 累計完成數量 8 / 契約複價 10
 * 日期在天區塊 +1 列的第 5 欄,是 Excel 序號(非文字)。
 *
 * 預定進度取自 `進度` 分頁(依日期對照);天氣、實際進度、星期、出工人數
 * 此格式不提供,一律 null 不硬湊。
 */

const META_VENDOR_KEY = '玉森土木包工業';

const ITEM_SHEET_RE = /第二聯/;
const PROGRESS_SHEET = '進度';
const BLOCK_MARK = '第二聯';
const ITEM_FIRST_OFFSET = 3;
const DATE_OFFSET = 1;
const DATE_COL = 5;

const COL = {
  項次: 0, 工程項目: 1, 單位: 2, 契約單價: 3, 契約數量: 4,
  本日完成數量: 6, 本日完成金額: 7, 累計完成數量: 8,
};

// 明細列的項次:阿拉伯數字或中文大寫(費用項目)。其餘代表已離開明細區。
const ITEM_NO_RE = /^(\d+|[壹貳參参肆伍陸柒捌玖拾])$/;

const text = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
};

/** 無資料標記(`-`/`－`/空白)一律 null:語意是「無資料」而非 0。 */
function numOf(v) {
  const s = v == null ? '' : String(v).replace(/[,\s　]/g, '');
  if (s === '' || s === '-' || s === '－') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 「工程名稱：雲林縣大有國民小學…」→ 去掉標籤。 */
function projectName(v) {
  const s = text(v);
  if (s == null) return null;
  return text(s.replace(/^工程名稱[:：]?/, ''));
}

/**
 * 一天的明細(純函式)。各天的項目數不同,讀到非項次列即停——
 * 寫死列數會把「累計」列與簽名欄吃進來變成假項目。
 */
function parseItemRows(grid, start) {
  const out = [];
  for (let i = start + ITEM_FIRST_OFFSET; i < grid.length; i++) {
    const r = grid[i] || [];
    const 項次 = text(r[COL.項次]);
    if (項次 == null || !ITEM_NO_RE.test(項次)) break;
    out.push({
      項次,
      工程項目: text(r[COL.工程項目]),
      單位: text(r[COL.單位]),
      契約單價: numOf(r[COL.契約單價]),
      契約數量: numOf(r[COL.契約數量]),
      本日完成數量: numOf(r[COL.本日完成數量]),
      本日完成金額: numOf(r[COL.本日完成金額]),
      累計完成數量: numOf(r[COL.累計完成數量]),
    });
  }
  return out;
}

/**
 * 進度分頁 → 日期(Excel 序號) → **累計**預計進度。
 *
 * 分頁的欄是「日期 / 累計天數 / 每日預計進度 / (無表頭)累計」。
 * 原本取欄 2 的「每日預計進度」,那是每天固定的增量(鹿場整份都是 0.28),
 * 而監造報表的「預定進度(%)」要的是累計——其他讀取器(賜利發)也一律取累計那一組。
 * 接上第一聯之後這件事才現形:第一聯印的「累計預定進度」是 0.28/0.56/0.84…,
 * 與**欄 3** 逐格吻合,與欄 2 每天都對不上,合併時 11 天噴 10 個 conflict。
 * 7 份第二聯樣本(6 案)的欄位排列一致,欄 3 只是沒有表頭而已。
 */
const PROGRESS_CUM_COL = 3;

function progressByDate(grid) {
  const map = new Map();
  for (const r of grid || []) {
    const serial = numOf((r || [])[0]);
    const v = numOf((r || [])[PROGRESS_CUM_COL]);
    if (serial != null && v != null) map.set(serial, v);
  }
  return map;
}

function findItemSheet(wb) {
  const name = wb.sheetNames.find((n) => ITEM_SHEET_RE.test(n));
  return name ? wb.sheets[name] : null;
}

// ── 第一聯(.docx)────────────────────────────────────────────────
// 兩聯分成兩個檔:第二聯(.xls)有完整明細含單價與金額,**但沒有天氣、星期、
// 實際進度、出工人數**;那些只在第一聯(.docx)上。只讀第二聯不會有任何欄位
// 「看起來」有問題——SP3 只會說「此格式不提供」然後放行,天氣欄就一路空到監造報表。
// 兩聯以填報日期配對,由 daily-log-merge 合併(與明德那家同一條路)。

const nfkc = (v) => String(v == null ? '' : v).normalize('NFKC');
const despace = (v) => nfkc(v).replace(/[\s　]/g, '');

/**
 * 「115年7月21日(星期二)」/「115.7.21」→ 西元 ISO。
 * 民國與西元雙制:4 位數年份當西元,其餘 +1911。
 */
function rocDate(v) {
  const s = despace(v);
  const m = s.match(/(\d{2,4})[年./-](\d{1,2})[月./-](\d{1,2})/);
  if (!m) return null;
  const y = Number(m[1]);
  return `${y < 1911 ? y + 1911 : y}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
}

/**
 * 表頭列 → 每個標籤佔的欄區段。
 *
 * **不可以拿「連續同值只留一個」去壓資料列**:合併填充讓「本日」「累計」各佔 3 欄,
 * 而當天沒填的那兩欄都是空字串,壓縮會把它們併成一格,整列往左錯位一欄——
 * 於是「體力工 本日 2 累計 2」讀成「體力工 2」,再也分不出哪個是本日。
 * 表頭列每格都有值,壓縮才是安全的,所以用**表頭定欄區段**,資料列照區段取。
 */
function headerSegments(row) {
  const out = [];
  (row || []).forEach((c, i) => {
    const v = despace(c);
    const last = out[out.length - 1];
    if (last && last.label === v) { last.to = i; return; }
    if (v === '') { out.push({ label: '', from: i, to: i }); return; }
    out.push({ label: v, from: i, to: i });
  });
  return out.filter((s) => s.label !== '');
}

/** 資料列在某個欄區段裡的第一個非空值。 */
const segValue = (row, seg) => {
  for (let i = seg.from; i <= seg.to; i++) {
    const v = text((row || [])[i]);
    if (v != null) return v;
  }
  return null;
};

/**
 * 「標籤 值 標籤 值…」那幾列。每格都有值,可以安全地壓縮連續同值再兩兩配對。
 * 回 Map(標籤 → 值)。
 */
function labelPairs(rows) {
  const map = new Map();
  for (const row of rows) {
    const seq = [];
    for (const c of row || []) {
      const v = String(c == null ? '' : c);
      if (!seq.length || seq[seq.length - 1] !== v) seq.push(v);
    }
    for (let i = 0; i < seq.length - 1; i += 2) {
      const k = despace(seq[i]);
      if (k && !map.has(k)) map.set(k, seq[i + 1]);
    }
  }
  return map;
}

/** 「上午:晴下午:雨」→ { 上午, 下午 }。 */
function weather(v) {
  const s = despace(v);
  const m = s.match(/上午[:：]?(.*?)下午[:：]?(.*)$/);
  if (!m) return { 上午: null, 下午: null };
  return { 上午: text(m[1]), 下午: text(m[2]) };
}

/**
 * 進度值。第一聯印的是百分數(`0.28%`),第二聯的「進度」分頁給的是 `0.28`
 * ——**同一個意思、同一個數字**,所以這裡只去掉百分號,不做 ÷100。
 * 換算了反而讓同一家兩種載體差 100 倍,合併時變成 conflict。
 */
const pct = (v) => numOf(String(v == null ? '' : v).replace(/[%％]/g, ''));

/** 「一、出工人數」「二、機具使用情形」那張橫表:回本日那一列的值。 */
function crewTable(rows, hi) {
  const segs = headerSegments(rows[hi]);
  const 人 = []; const 機具 = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || headerSegments(row).some((s) => /^[一二三四五六七八九十]、/.test(s.label))) break;
    // 表頭是「工別 本日 累計」重複兩組 + 「機具名稱 本日使用數量 累計使用數量」一組
    for (let k = 0; k < segs.length; k++) {
      const lab = segs[k].label;
      if (lab !== '工別' && lab !== '機具名稱') continue;
      const 名 = segValue(row, segs[k]);
      if (名 == null) continue;
      const 本日 = segs[k + 1] ? numOf(segValue(row, segs[k + 1])) : null;
      (lab === '工別' ? 人 : 機具).push(lab === '工別'
        ? { 工別: 名, 人數: 本日 }
        : { 名稱: 名, 數量: 本日 });
    }
  }
  return { 人, 機具 };
}

/** 「三、重要材料使用情形」:表頭是「材料名稱 單位 契約數量 本日使用數量 累計使用數量」×2 組。 */
function materialTable(rows, hi) {
  const segs = headerSegments(rows[hi]);
  const out = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || headerSegments(row).some((s) => /^[一二三四五六七八九十]、/.test(s.label))) break;
    for (let k = 0; k < segs.length; k++) {
      if (segs[k].label !== '材料名稱') continue;
      const 名 = segValue(row, segs[k]);
      if (名 == null) continue;
      out.push({
        名稱: 名,
        單位: segs[k + 1] ? segValue(row, segs[k + 1]) : null,
        數量: segs[k + 3] ? numOf(segValue(row, segs[k + 3])) : null,
      });
    }
  }
  return out;
}

const 段落標題 = (rows, re) => rows.findIndex((r) => (r || []).some((c) => re.test(despace(c))));

/** 第一聯的一天:表格 + 它前面那段含日期的段落。 */
function parseFirstCopy(rows, 前段) {
  const pairs = labelPairs(rows.slice(0, 7));
  const w = weather(pairs.get('本日氣候'));
  const d = despace(前段);
  const 星期 = (d.match(/[(（]星期(.)[)）]/) || [])[1];
  const header = {
    工程名稱: text(pairs.get('工程名稱')),
    填報日期: rocDate((d.match(/日期[:：]([^()（]*)/) || [])[1] || ''),
    星期: 星期 ? `星期${星期}` : null,
    天氣_上午: w.上午,
    天氣_下午: w.下午,
    // 累計那組才是監造報表要的;本日那組是當天增量(cilifa 同樣的立場)
    預定進度: pct(pairs.get('累計預定進度')),
    實際進度: pct(pairs.get('累計實際進度')),
    出工總人數: null,
    本日累計金額: null,
    承包廠商: text(pairs.get('承攬廠商')),
    開工日期: rocDate(pairs.get('開工日期') || ''),
  };
  const extras = {};
  const ci = 段落標題(rows, /^一、出工人數/);
  if (ci >= 0 && rows[ci + 1]) {
    const { 人, 機具 } = crewTable(rows, ci + 1);
    if (人.length) {
      extras.出工明細 = 人;
      const n = 人.map((x) => x.人數).filter((x) => x != null);
      if (n.length) header.出工總人數 = n.reduce((a, b) => a + b, 0);
    }
    if (機具.length) extras.主要機具 = 機具;
  }
  const mi = 段落標題(rows, /^三、重要材料使用情形/);
  if (mi >= 0 && rows[mi + 1]) {
    const list = materialTable(rows, mi + 1);
    if (list.length) extras.主要材料 = list;
  }
  // 第一聯沒有工程項目明細(「四、營造專業工程特定施工項目」是技術士用的,不是契約項目)。
  // 空著讓 daily-log-merge 去挑第二聯的——它以「有幾列有契約單價」判完整度。
  return { header, dailyRows: [], extras };
}

async function parseFirstCopyFile(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.readDocx !== 'function') throw new Error('缺少 ctx.filetypes.readDocx');
  const { blocks } = await ft.readDocx(filePath);
  const days = [];
  let 前段 = '';
  for (const b of blocks) {
    if (b.type === 'p') { if (/日期[:：]/.test(despace(b.text))) 前段 = b.text; continue; }
    // 一天一個表格,日期印在**表格前面的段落**上,不在表格裡
    if (!前段) continue;
    days.push(parseFirstCopy(b.rows, 前段));
    前段 = '';
  }
  // 共通表單的錨點別家也有;全部讀不到日期一律 throw——回空陣列會被上游當成
  // 「這份沒有資料」靜靜略過。
  if (!days.length || !days.some((d) => d.header.填報日期)) {
    throw new Error('這份 .docx 讀不到任何施工日誌日期,可能不是玉森的第一聯');
  }
  return days;
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft) throw new Error('缺少 ctx.filetypes(檔型工具需由 registry 注入)');
  if (/\.docx$/i.test(filePath)) return parseFirstCopyFile(filePath, ctx);
  const wb = ft.readWorkbook(filePath);
  const grid = findItemSheet(wb);
  if (!grid) throw new Error('找不到「第二聯」分頁');
  const prog = progressByDate(wb.sheets[PROGRESS_SHEET]);

  const starts = [];
  grid.forEach((r, i) => { if (text((r || [])[0]) === BLOCK_MARK) starts.push(i); });

  return starts.map((start) => {
    const dateRow = grid[start + DATE_OFFSET] || [];
    const serial = numOf(dateRow[DATE_COL]);
    return {
      header: {
        工程名稱: projectName(dateRow[0]),
        填報日期: serial == null ? null : ft.excelSerialToISO(serial),
        星期: null,
        天氣_上午: null,
        天氣_下午: null,
        預定進度: serial == null ? null : (prog.get(serial) == null ? null : prog.get(serial)),
        實際進度: null,
        出工總人數: null,
        本日累計金額: null,
      },
      dailyRows: parseItemRows(grid, start),
      extras: {},
    };
  });
}

async function parse(filePath, ctx) {
  const all = await parseAll(filePath, ctx);
  return all[0] || null;
}

// 內建 grid 小樣本,不需注入也不 require node_modules(讀取器安裝目錄沒有它)。
function selfTest() {
  const g = [];
  g[1] = ['第二聯'];
  g[2] = ['工程名稱：測試工程', '', '', '', '', 46113];
  g[3] = ['項次', '工程項目', '單位', '契約單價', '契約數量'];
  g[4] = ['1', '乙種施工圍籬', '式', '5000', '1', '', '0.2', '1000', '0.2'];
  g[5] = ['2', '工程告示牌', '式', '5000', '1', '', '', '0'];
  g[6] = ['累　計(本日完成金額)'];
  const rows = parseItemRows(g, 1);
  if (rows.length !== 2) return false;                       // 「累計」列必須被擋掉
  if (rows[0].契約單價 !== 5000 || rows[0].本日完成數量 !== 0.2) return false;
  if (rows[1].本日完成金額 !== 0) return false;              // 0 是真的 0,不可變 null
  if (rows[1].本日完成數量 !== null) return false;           // 空白才是 null
  if (projectName(g[2][0]) !== '測試工程') return false;
  // 欄 2 是每日增量、欄 3 才是累計:拿兩個不同的值,取錯欄就驗得出來
  const prog = progressByDate([[46113, 1, 0.38, 0.38], [46114, 2, 0.38, 0.76]]);
  if (prog.get(46114) !== 0.76) return false;

  // 第一聯(.docx)那條路:rows 取自鹿場真實檔第 1 天,只留會影響判讀的欄。
  // 合併填充讓每個標籤/值各佔數欄,**照抄真實形狀**——自己編一組一格一值的
  // 樣本會驗不到「相鄰空格被壓縮就整列左移」這個真正會出錯的地方。
  const 一 = ['工程名稱', '工程名稱', '測試工程', '測試工程', '本日氣候', '本日氣候', '上午：晴下午：雨', '上午：晴下午：雨'];
  const 二 = ['承攬廠商', '承攬廠商', '玉森土木包工業', '玉森土木包工業', '開工日期', '開工日期', '115.7.21', '115.7.21'];
  const 三 = ['累計預定進度', '累計預定進度', '0.56%', '0.56%', '累計實際進度', '累計實際進度', '0.96%', '0.96%'];
  const 標 = ['一、出工人數：', '一、出工人數：', '一、出工人數：', '一、出工人數：', '一、出工人數：', '一、出工人數：'];
  const 頭 = ['工 別', '本日', '本日', '累計', '累計', '機具名稱'];
  const 值 = ['體力工', '', '', '2', '2', '挖土機'];
  const d = parseFirstCopy([一, 二, 三, 標, 頭, 值], '第一聯 表報編號： 日期：115年7月21日（星期二）');
  if (d.header.填報日期 !== '2026-07-21' || d.header.星期 !== '星期二') return false;
  if (d.header.天氣_上午 !== '晴' || d.header.天氣_下午 !== '雨') return false;
  // 百分號去掉就好,不可以再除以 100——第二聯的進度分頁給的是同一個數字
  if (d.header.預定進度 !== 0.56 || d.header.實際進度 !== 0.96) return false;
  if (d.header.承包廠商 !== META_VENDOR_KEY || d.header.開工日期 !== '2026-07-21') return false;
  // 「本日」佔兩欄且都空、「累計」佔兩欄且都是 2:壓縮相鄰空格的話這裡會讀成 2
  if (d.extras.出工明細[0].人數 !== null) return false;
  if (d.header.出工總人數 !== null) return false;
  return d.dailyRows.length === 0;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.1.0',
    targetFields: [
      // 第二聯(.xls)
      '工程名稱', '填報日期', '預定進度',
      '項次', '工程項目', '單位', '契約單價', '契約數量',
      '本日完成數量', '本日完成金額', '累計完成數量',
      // 第一聯(.docx)獨有
      '星期', '天氣_上午', '天氣_下午', '實際進度', '出工總人數', '承包廠商', '開工日期',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: {
    parseItemRows, progressByDate, projectName, numOf,
    parseFirstCopy, headerSegments, labelPairs, weather, rocDate,
  },
};
