/**
 * zhendian.pmisparser.js — 振典實業施工日誌讀取器(宜梧國中 / 溝壩國小 / 永慶沙灘排球)
 *
 * vendorKey 取自**決標公告的得標廠商**(三案皆為振典實業有限公司),日誌 a+2 欄 9 的
 * 「廠商名稱」也載明同一個名稱,兩邊一致。
 *
 * ── 版面事實(三案實測一致)──
 * xlsx,分頁以月份命名(「10月」「114年1月」「115年1月」…),另有非日誌的「進度」分頁;
 * **不挑分頁名**,而是掃每張分頁找欄 0 的「表報編號：」當天區塊起點——月份的寫法
 * 三案都不一樣(有的帶民國年、有的分頁名尾端還有空白),挑名字遲早會漏。
 *
 * 相對錨點列 a:
 *   a+1  欄3=上午天氣  欄5=下午天氣  欄9=填表日期(Excel 序號)
 *   a+2  欄2=工程名稱  欄9=廠商名稱
 *   a+4  欄3=開工日期(序號)
 *   a+5  欄3=本日預定進度  欄9=本日實際進度
 *   a+6  欄3=累計預定進度  欄9=累計實際進度   ← schema 的進度取這一組(見下)
 *   a+8  明細表頭        a+9 起是明細
 *
 * 明細欄:項次 0 / 施工項目 1 / 單位 4 / 契約數量 5 / 本日完成數量 7 / 累計完成數量 9 /
 *         單價 14 / 本日完成金額 15。
 *
 * ⚠️ **欄 6 不是契約數量。** 表頭那格「契約數量」橫跨欄 5~6,合併填充後兩欄的表頭
 * 一模一樣,但資料列裡兩欄的值不同:溝壩項次 9 的契約數量是 48、欄 6 卻是 1261,
 * 而 1261 從項次 9 一路重複到項次 25——那是別的工程留下來的殘值。照表頭收欄 6
 * 會讓契約數量整片變成同一個數字,而每一格都還是「有值」,完整性關卡看不見。
 *
 * ⚠️ **表尾的位移不固定**:「本日合計」「累計合計金額」「工別」的列號隨明細項數而變
 * (宜梧 17 項、溝壩 25 項),一律以標籤字串定位,不寫死 a+30。
 *
 * ── 進度取「累計」那一組 ──
 * SP3 的 F3(實際進度不得逐日變小)與 C4(0~100)驗的都是累計語意;此格式兩組都有,
 * 取本日那組會讓 F3 每天誤報。其他家的表單只有一組,實測也是累計值。
 *
 * ── 金額欄的語意用算式核對過,不照標籤收 ──
 * 欄 15 的表頭寫「總價」,值卻是**當日**金額:宜梧 12/13 項次 6 單價 475000 × 本日 0.1
 * = 47500,與表尾「本日合計」一致;欄 18(無表頭)才是累計金額 475000 × 累計 0.5
 * = 237500,與「累計合計金額」一致。標籤不是證據(祥賀踩過反向的同一個坑)。
 */

const META_VENDOR_KEY = '振典實業有限公司';

const ANCHOR_RE = /^表\s*報\s*編\s*號[:：]?$/;

// 相對錨點列的位移(實測三案一致)
const OFF = { 天氣: 1, 名稱: 2, 開工: 4, 本日進度: 5, 累計進度: 6, 表頭: 8 };

const COL = {
  項次: 0, 單位: 4, 契約數量: 5,
  本日完成數量: 7, 累計完成數量: 9, 契約單價: 14, 本日完成金額: 15,
};
// 施工項目是欄 1~3 的合併區。**不能只讀欄 1**:溝壩項次 18 那一列的合併範圍與別列
// 不同(只合併 2~3),欄 1 是空的,只讀欄 1 會讓那一列的名稱憑空消失(A5 硬錯)。
const NAME_COLS = [1, 2, 3];

// 表尾標籤(位移隨明細項數而變,一律用字串找)
const LABEL_累計金額 = '累計合計金額';
const LABEL_工別 = '工別';

/** 儲存格取值:空白/`-`/`－` 一律 null(無資料標記,不是 0)。 */
function cell(grid, r, c) {
  const row = grid[r];
  if (!row) return null;
  const v = row[c];
  if (v == null) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    return s === '' || s === '-' || s === '－' ? null : s;
  }
  return v;
}

/** 數值:非數字回 null,絕不編造 0。 */
function num(grid, r, c) {
  const v = cell(grid, r, c);
  if (v == null) return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * 單位。此格式用的是全形方公尺 `㎡`(U+33A1)與 `㎝`,NFKC 折成 'm2'/'cm' 之後
 * 才對得上 SP3 的單位字典(否則 J2 每一列都軟警告)。這是既有慣例:
 * filetypes/pdf.js 對抽出的文字也做 NFKC。
 */
function unit(grid, r, c) {
  const v = cell(grid, r, c);
  return v == null ? null : String(v).normalize('NFKC').trim() || null;
}

function iso(v, serialToISO) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return serialToISO ? serialToISO(v) : null;
  const m = /(\d{2,4})[年/-](\d{1,2})[月/-](\d{1,2})/.exec(String(v));
  if (!m) return null;
  let y = Number(m[1]);
  if (y < 1911) y += 1911;                                  // 民國
  const p = (n) => String(Number(n)).padStart(2, '0');
  return `${y}-${p(m[2])}-${p(m[3])}`;
}

/** 在區塊範圍內找欄 c 等於某標籤的列;找不到回 -1。 */
function findLabelRow(grid, from, to, c, label) {
  for (let r = from; r < Math.min(to, grid.length); r++) {
    const v = cell(grid, r, c);
    if (v != null && String(v).trim() === label) return r;
  }
  return -1;
}

/**
 * 解析一天區塊(純函式;selfTest 重用之)。
 * @param {Array<Array>} grid
 * @param {number} a 錨點列(欄 0 === '表報編號：')
 * @param {number} end 下一個錨點列(或 grid 尾)
 * @param {(serial:number)=>string|null} [serialToISO]
 */
function parseBlock(grid, a, end, serialToISO) {
  const dailyRows = [];
  for (let r = a + OFF.表頭 + 1; r < end; r++) {
    const 項次 = cell(grid, r, COL.項次);
    let 工程項目 = null;
    for (const c of NAME_COLS) {
      const v = cell(grid, r, c);
      if (v != null) { 工程項目 = v; break; }
    }
    if (項次 == null && 工程項目 == null) break;              // 明細結束(表尾的合計列)
    dailyRows.push({
      項次: 項次 == null ? null : String(項次),
      工程項目: 工程項目 == null ? null : String(工程項目),
      單位: unit(grid, r, COL.單位),
      契約單價: num(grid, r, COL.契約單價),
      契約數量: num(grid, r, COL.契約數量),
      本日完成數量: num(grid, r, COL.本日完成數量),
      本日完成金額: num(grid, r, COL.本日完成金額),
      累計完成數量: num(grid, r, COL.累計完成數量),
    });
  }

  const cumRow = findLabelRow(grid, a + OFF.表頭, end, 1, LABEL_累計金額);
  const 本日累計金額 = cumRow < 0 ? null : num(grid, cumRow, 11);

  // 出工與機具。本日人數在欄 4、累計在欄 5;沒出工時廠商只填累計那一欄,
  // 取錯欄會讓出工總人數整份偏高。
  const extras = {};
  let 出工總人數 = null;
  const crewRow = findLabelRow(grid, a + OFF.表頭, end, 0, LABEL_工別);
  if (crewRow >= 0) {
    const 出工明細 = [];
    const 主要機具 = [];
    for (let r = crewRow + 1; r < end; r++) {
      const 工別 = cell(grid, r, 0);
      if (工別 == null || /^[一二三四五六七八]、/.test(String(工別))) break;
      出工明細.push({ 工別: String(工別), 人數: num(grid, r, 4) });
      const 機具 = cell(grid, r, 7);
      if (機具 != null) 主要機具.push({ 名稱: String(機具), 數量: num(grid, r, 9) });
    }
    if (出工明細.length) {
      extras.出工明細 = 出工明細;
      const n = 出工明細.filter((c) => c.人數 != null);
      if (n.length) 出工總人數 = n.reduce((s, c) => s + c.人數, 0);
    }
    if (主要機具.length) extras.主要機具 = 主要機具;
  }

  return {
    header: {
      工程名稱: cell(grid, a + OFF.名稱, 2) == null ? null : String(cell(grid, a + OFF.名稱, 2)),
      填報日期: iso(cell(grid, a + OFF.天氣, 9), serialToISO),
      星期: null,                                             // 此格式不提供
      天氣_上午: cell(grid, a + OFF.天氣, 3) == null ? null : String(cell(grid, a + OFF.天氣, 3)),
      天氣_下午: cell(grid, a + OFF.天氣, 5) == null ? null : String(cell(grid, a + OFF.天氣, 5)),
      預定進度: num(grid, a + OFF.累計進度, 3),
      實際進度: num(grid, a + OFF.累計進度, 9),
      出工總人數,
      本日累計金額,
      承包廠商: cell(grid, a + OFF.名稱, 9) == null ? null : String(cell(grid, a + OFF.名稱, 9)),
      開工日期: iso(cell(grid, a + OFF.開工, 3), serialToISO),
    },
    dailyRows,
    extras,
  };
}

/**
 * 「還沒填的未來日期」判定。
 *
 * 廠商把整個工期的區塊一次建好再逐日填,交檔當下工期還沒結束,檔尾因此有一批
 * 只有公式算出的日期與進度、其餘全空的區塊(20251117 那份實測 14 天,正好是 11/18
 * 之後到工期末的天數)。收下來 SP3 會噴 A2(天氣未填)一整片,把真正的問題淹掉。
 *
 * **只憑「天氣沒填」就丟掉是危險的**——真的漏填天氣卻有施工的日子會靜默消失,
 * 故要求整天也沒有任何本日完成量。「沒填」在此格式是空白**或 0**(金額欄是公式)。
 */
function isUnfilledBlock(day) {
  if (day.header.天氣_上午 != null || day.header.天氣_下午 != null) return false;
  const blank = (v) => v == null || v === 0;
  return (day.dailyRows || []).every((r) => blank(r.本日完成數量) && blank(r.本日完成金額));
}

function blockStarts(grid) {
  const out = [];
  for (let r = 0; r < grid.length; r++) {
    const v = cell(grid, r, 0);
    if (v != null && ANCHOR_RE.test(String(v).trim())) out.push(r);
  }
  return out;
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.readWorkbook !== 'function') {
    throw new Error('缺少注入的 filetypes.readWorkbook');
  }
  const wb = ft.readWorkbook(filePath);
  const out = [];
  let anchors = 0;
  for (const name of wb.sheetNames) {
    const grid = wb.sheets[name];
    if (!grid || !grid.length) continue;
    const starts = blockStarts(grid);                        // 「進度」等輔助分頁沒有錨點
    anchors += starts.length;
    for (let i = 0; i < starts.length; i++) {
      const end = i + 1 < starts.length ? starts[i + 1] : grid.length;
      const day = parseBlock(grid, starts[i], end, ft.excelSerialToISO);
      if (day.header.填報日期 == null && !day.dailyRows.length) continue;
      if (isUnfilledBlock(day)) continue;
      out.push(day);
    }
  }
  // 找不到任何天區塊 = 這個檔根本讀不動(此案的 PDF 是 50MB 的掃描件,沒有文字層,
  // SheetJS 對它會回一份空活頁簿)。回空陣列會被上游當成「這份沒有資料」而靜靜略過,
  // 那是最糟的失敗方式——明講出來。
  if (!anchors) throw new Error('找不到「表報編號」天區塊(此檔非振典格式,或是無文字層的掃描件)');
  return out;
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest 用**真實座標**造一個最小區塊(取自宜梧 12 月第 41 天,只換工程名稱)。
 * 要驗的是三件最容易寫錯的事:欄 6 的殘值不可當契約數量、金額欄的語意、
 * 表尾標籤定位(不寫死位移)。
 */
function selfTest(ft) {
  const grid = [];
  const set = (r, c, v) => { (grid[r] = grid[r] || [])[c] = v; };
  set(0, 0, '表報編號：'); set(0, 2, 41);
  set(1, 0, '本日天氣：'); set(1, 3, '晴'); set(1, 5, '陰'); set(1, 9, 45635);
  set(2, 0, '工程名稱'); set(2, 2, '測試工程'); set(2, 9, META_VENDOR_KEY);
  set(4, 0, '開工日期'); set(4, 3, 45595);
  set(5, 0, '本日預定進度(%)'); set(5, 3, 0.239); set(5, 9, 0.69);
  set(6, 0, '累計預定進度(%)'); set(6, 3, 7.195); set(6, 9, 9.84);
  set(8, 0, '項次'); set(8, 1, '施工項目'); set(8, 4, '單位'); set(8, 5, '契約數量');
  set(8, 6, '契約數量'); set(8, 7, '本日完成數量'); set(8, 9, '累計完成數量'); set(8, 14, '單價');
  set(9, 0, '壹'); set(9, 1, '直接工程');
  // 項次 6:本日 0.1 × 單價 475000 = 47500(欄 15),累計 0.5 × 475000 = 237500(欄 18)。
  // 欄 6 的 183.6 是別的工程留下的殘值,契約數量其實是 1。
  set(10, 0, 6); set(10, 1, '內水溝邊設置細縫溝'); set(10, 4, '式');
  set(10, 5, 1); set(10, 6, 183.6); set(10, 7, 0.1); set(10, 9, 0.5);
  set(10, 14, 475000); set(10, 15, 47500); set(10, 18, 237500);
  set(11, 0, 7); set(11, 1, '球場鋪設15㎝碎石級配灑水壓實'); set(11, 4, '㎡');
  set(11, 5, 1554); set(11, 6, 1192); set(11, 9, 0); set(11, 14, 200); set(11, 15, 0);
  // 名稱是欄 1~3 的合併區,但**這一列的合併範圍與別列不同**(只合併 2~3,欄 1 是空的):
  // 只讀欄 1 的話這一列的名稱會憑空消失。真實案例:溝壩 2025-09-05 的項次 18。
  set(12, 0, 18); set(12, 2, '鋪設碎石級配(H15cm)，灑水壓密'); set(12, 3, '鋪設碎石級配(H15cm)，灑水壓密');
  set(12, 4, '㎡'); set(12, 5, 539); set(12, 9, 0); set(12, 14, 200); set(12, 15, 0);
  set(14, 1, '本日合計'); set(14, 11, 47500);
  set(15, 1, '累計合計金額'); set(15, 11, 674443);
  set(18, 0, '工別'); set(18, 4, '本日人數'); set(18, 5, '累計人數'); set(18, 7, '機具名稱');
  set(19, 0, '技術工'); set(19, 5, 3); set(19, 7, '貨車'); set(19, 9, 0);
  set(20, 0, '體力工'); set(20, 4, 2); set(20, 5, 5); set(20, 7, '挖土機');
  set(21, 0, '四、本日施工項目是否有須依');

  const serial = ft && typeof ft.excelSerialToISO === 'function' ? ft.excelSerialToISO : null;
  const d = parseBlock(grid, 0, grid.length, serial);
  if (d.header.工程名稱 !== '測試工程') return false;
  if (d.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (serial && d.header.填報日期 !== '2024-12-09') return false;
  if (serial && d.header.開工日期 !== '2024-10-30') return false;
  if (d.header.天氣_上午 !== '晴' || d.header.天氣_下午 !== '陰') return false;
  // 進度取「累計」那組;取到本日那組(0.239/0.69)的話 F3 會每天誤報
  if (d.header.預定進度 !== 7.195 || d.header.實際進度 !== 9.84) return false;
  if (d.header.本日累計金額 !== 674443) return false;         // 標籤定位,不寫死位移
  if (d.dailyRows.length !== 4) return false;
  const [cat, r1, r2, r3] = d.dailyRows;
  if (r3.項次 !== '18' || r3.工程項目 !== '鋪設碎石級配(H15cm)，灑水壓密') return false;
  if (cat.項次 !== '壹' || cat.單位 !== null || cat.契約數量 !== null) return false;
  if (r1.項次 !== '6' || r1.單位 !== '式') return false;
  if (r1.契約數量 !== 1) return false;                        // 欄 6 的 183.6 不可當契約數量
  if (r1.本日完成數量 !== 0.1 || r1.累計完成數量 !== 0.5) return false;
  if (r1.契約單價 !== 475000 || r1.本日完成金額 !== 47500) return false;  // 47500 = 475000×0.1
  if (r2.契約數量 !== 1554) return false;                     // 欄 6 的 1192 是殘值
  if (r2.單位 !== 'm2') return false;                         // ㎡ 經 NFKC 才對得上單位字典
  if (d.header.出工總人數 !== 2) return false;                // 技術工只有累計欄,不計
  const 技術工 = d.extras.出工明細.find((c) => c.工別 === '技術工');
  if (!技術工 || 技術工.人數 !== null) return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '出工總人數', '本日累計金額', '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約單價', '契約數量',
      '本日完成數量', '本日完成金額', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parseBlock, blockStarts, num, unit, iso },
};
