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

/** 進度分頁 → 日期(Excel 序號) → 每日預計進度。 */
function progressByDate(grid) {
  const map = new Map();
  for (const r of grid || []) {
    const serial = numOf((r || [])[0]);
    const v = numOf((r || [])[2]);
    if (serial != null && v != null) map.set(serial, v);
  }
  return map;
}

function findItemSheet(wb) {
  const name = wb.sheetNames.find((n) => ITEM_SHEET_RE.test(n));
  return name ? wb.sheets[name] : null;
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft) throw new Error('缺少 ctx.filetypes(檔型工具需由 registry 注入)');
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
  const prog = progressByDate([[46113, 1, 0.38], [46114, 2, 0.38]]);
  return prog.get(46113) === 0.38;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '預定進度',
      '項次', '工程項目', '單位', '契約單價', '契約數量',
      '本日完成數量', '本日完成金額', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parseItemRows, progressByDate, projectName, numOf },
};
