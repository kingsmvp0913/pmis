/**
 * zhengyu.pmisparser.js — 正郁室內裝修施工日誌讀取器(成功國小思源堂 / 林內國中教室整修)
 *
 * vendorKey 取自**決標公告的得標廠商**(兩案皆為正郁室內裝修),
 * 日誌 a+2 欄 7 的「承攬商名稱」也載明同一個名稱,兩邊一致。
 * ⚠️ 這家名稱**不帶「有限公司」**,照慣例補上就對不到 vendors 表。
 *
 * ── 版面事實(兩案實測一致)──
 * .xlsx,分頁以月份命名(「2月 」「115年1月」…,名稱含尾隨空白),一天一區塊垂直堆疊,
 * 以欄 0 的「表報編號：」為起點。掃所有分頁,不挑名字。
 *
 * 相對錨點列 a:
 *   a+1  欄0=「本日天氣：上午：X 下午：Y」(標籤與值全黏在同一格)
 *        欄7=填表日期(Excel 序號)  欄9=「(星期六)」
 *   a+2  欄2=工程名稱  欄7=承攬商名稱
 *   a+5  欄2=開工日期(字串「113年12月16日」)
 *   a+6  欄2=預定進度  欄7=實際進度
 *   a+8  明細表頭:欄0=施工項目 欄3=單位 欄4=契約數量 欄5=本日完成數量 欄7=累計完成數量
 *   a+9 起明細,到欄 0 的「營造業專業工程特定施工項目」為止
 *
 * ── 項次與名稱擠在同一格 ──
 * 明細的欄 0 是「1 工程告示牌(租用)」「貳 職業安全衛生管理費（壹*1%）」這種形狀,
 * 項次與名稱之間只隔一個空白。切錯的話名稱會多一截編號、而 SP3 拿名稱對契約表時
 * 就對不上——**名稱錯了不會讓任何欄位變 null**,完整性關卡看不見。
 * 大類列(「壹、直接工程費」)沒有那個空白,整格都是名稱。
 *
 * ── 金額欄在表格右外側,但這次對得上 ──
 * 欄 10=單價、欄 11=本日完成金額。與寶樹那種「錯開一列」的計算區不同:
 * 這裡逐列對齊,且表尾有「本日完成合計:」可交叉核對(Σ欄11)。收下來之前驗過。
 */

const META_VENDOR_KEY = '正郁室內裝修';

const ANCHOR = '表報編號：';
const END_MARK = '營造業專業工程特定施工項目';

const OFF = { 天氣: 1, 名稱: 2, 開工: 5, 進度: 6, 表頭: 8 };
const COL = {
  工程項目: 0, 單位: 3, 契約數量: 4, 本日完成數量: 5, 累計完成數量: 7,
  契約單價: 10, 本日完成金額: 11,
  填報日期: 7, 星期: 9, 工程名稱: 2, 承包廠商: 7, 開工: 2, 預定進度: 2, 實際進度: 7,
};
const CREW = { 工別: 0, 本日人數: 2, 機具: 4, 本日使用: 6 };

const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'm', 'm2', 'm3', 'CM', 'MM', 'KG', 'kg',
  '噸', 'T', '面', '座', '組', '場', '棵', '株', '處', '個', '支', '片', '只', '間',
  '天', '日', '趟', '才', '公尺', '公斤', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '張', '盞']);

const despace = (v) => String(v == null ? '' : v).replace(/[\s　]/g, '');

const text = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s === '' || s === '-' || s === '－' ? null : s;
};

function numOf(v) {
  const s = v == null ? '' : String(v).replace(/[,\s　]/g, '');
  if (s === '' || s === '-' || s === '－') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const at = (grid, r, c) => (grid && grid[r] ? grid[r][c] : undefined);

function unitOf(v) {
  const s = text(v);
  if (s == null) return null;
  const n = String(s).normalize('NFKC').trim();
  return KNOWN_UNITS.has(n) ? n : null;
}

/**
 * 「1 工程告示牌(租用)」→ { 項次:'1', 名稱:'工程告示牌(租用)' }。
 *
 * **兩案的分隔符不同**:成功國小用空白(「貳 職業安全衛生管理費」),
 * 林內國中用頓號(「貳、職業安全衛生管理費」)。只認空白的話林內那 5 個費用項
 * 每天都會 A4(項次未填)。大類列「壹、直接工程費」也會被切開,那其實更正確
 * ——「壹」本來就是它的編號,而 SP3 認大類是看單位/數量是否皆空,不看項次。
 *
 * 名稱本身常含換行(「…底部30cm，刷3mm \nPU防水層…」),`.` 不吃 \n,
 * 用 `.+` 會整串比對失敗 → 項次變 null。
 */
function splitItemNo(raw) {
  const s = String(raw).trim();
  const m = /^([^\s、]+)[、 \t　]+([\s\S]+)$/.exec(s);
  if (!m) return { 項次: null, 名稱: s };
  return { 項次: m[1], 名稱: m[2].trim() };
}

/** 「本日天氣：上午：晴天 下午：晴天」→ ['晴天','晴天']。 */
function weatherOf(v) {
  const s = despace(v);
  const m = /上午[:：](.{1,3}?)下午[:：](.{1,3})$/.exec(s);
  return m ? [text(m[1]), text(m[2])] : [null, null];
}

/** 「(星期六)」→「星期六」。 */
function weekdayOf(v) {
  const m = /(星期.)/.exec(despace(v));
  return m ? m[1] : null;
}

/** 「113年12月16日」→ 'YYYY-MM-DD'(民國/西元雙制)。 */
function rocTextToISO(v) {
  const m = /(\d{2,4})年(\d{1,2})月(\d{1,2})日/.exec(despace(v));
  if (!m) return null;
  let y = Number(m[1]);
  if (y < 1911) y += 1911;
  const p = (n) => String(Number(n)).padStart(2, '0');
  return `${y}-${p(m[2])}-${p(m[3])}`;
}

/**
 * 解析一天區塊(純函式;selfTest 重用之)。
 * @param {Array<Array>} grid
 * @param {number} a 錨點列
 * @param {number} end 下一個錨點列(或 grid 尾)
 * @param {(serial:number)=>string|null} [serialToISO]
 */
function parseBlock(grid, a, end, serialToISO) {
  const dailyRows = [];
  for (let r = a + OFF.表頭 + 1; r < end; r++) {
    const raw = text(at(grid, r, COL.工程項目));
    if (raw == null || raw === END_MARK) break;
    const { 項次, 名稱 } = splitItemNo(raw);
    dailyRows.push({
      項次,
      工程項目: 名稱,
      單位: unitOf(at(grid, r, COL.單位)),
      契約單價: numOf(at(grid, r, COL.契約單價)),
      契約數量: numOf(at(grid, r, COL.契約數量)),
      本日完成數量: numOf(at(grid, r, COL.本日完成數量)),
      本日完成金額: numOf(at(grid, r, COL.本日完成金額)),
      累計完成數量: numOf(at(grid, r, COL.累計完成數量)),
    });
  }

  const extras = {};
  let 出工總人數 = null;
  let crewRow = -1;
  for (let r = a + OFF.表頭; r < end; r++) {
    if (despace(at(grid, r, 0)) === '工別') { crewRow = r; break; }
  }
  if (crewRow >= 0) {
    const 出工明細 = [];
    const 主要機具 = [];
    for (let r = crewRow + 1; r < end; r++) {
      const 工別 = text(at(grid, r, CREW.工別));
      if (工別 != null && /^[一二三四五六七八]、/.test(工別)) break;
      const 機具 = text(at(grid, r, CREW.機具));
      if (工別 != null) 出工明細.push({ 工別, 人數: numOf(at(grid, r, CREW.本日人數)) });
      if (機具 != null) 主要機具.push({ 名稱: 機具, 數量: numOf(at(grid, r, CREW.本日使用)) });
    }
    if (出工明細.length) {
      extras.出工明細 = 出工明細;
      const n = 出工明細.filter((c) => c.人數 != null);
      if (n.length) 出工總人數 = n.reduce((s, c) => s + c.人數, 0);
    }
    if (主要機具.length) extras.主要機具 = 主要機具;
  }

  const [上午, 下午] = weatherOf(at(grid, a + OFF.天氣, 0));
  const serial = numOf(at(grid, a + OFF.天氣, COL.填報日期));
  return {
    header: {
      工程名稱: text(at(grid, a + OFF.名稱, COL.工程名稱)),
      填報日期: serial != null && serialToISO ? serialToISO(serial) : null,
      星期: weekdayOf(at(grid, a + OFF.天氣, COL.星期)),
      天氣_上午: 上午,
      天氣_下午: 下午,
      預定進度: numOf(at(grid, a + OFF.進度, COL.預定進度)),
      實際進度: numOf(at(grid, a + OFF.進度, COL.實際進度)),
      出工總人數,
      // 表尾只有「本日完成合計」(當日金額),沒有逐日的累計金額;不自行累加。
      本日累計金額: null,
      承包廠商: text(at(grid, a + OFF.名稱, COL.承包廠商)),
      開工日期: rocTextToISO(at(grid, a + OFF.開工, COL.開工)),
    },
    dailyRows,
    extras,
  };
}

function blockStarts(grid) {
  const out = [];
  for (let r = 0; r < grid.length; r++) {
    if (despace(at(grid, r, 0)) === ANCHOR) out.push(r);
  }
  return out;
}

/**
 * 欄 11 的語意**兩案不同**,要用算式交叉核對才知道收不收(N6:標籤不是證據)。
 *
 * 成功國小:欄 11 = 本日完成數量 × 單價(當天沒做就是 0)。
 * 林內國中:欄 11 = **累計**完成數量 × 單價(跨天不變,例如項次 2 連著三天都是
 *           25000 = 0.5 × 50000)。照「本日金額」收下去,SP3 的 B3 會拿逐日累加的
 *           金額去對「累計數量 × 單價」,每天都不符——實測 662 個硬錯。
 *
 * schema 的 dailyRows 沒有「累計完成金額」欄,所以判定為累計時一律 null:
 * 那是**來源沒有本日金額**,不是讀取器讀不到。
 *
 * @returns {'daily'|'cumulative'|null} 判不出來就 null(不猜)
 */
function detectAmountMode(days) {
  const near = (a, b) => a != null && b != null && Math.abs(a - b) < 0.51;
  let d = 0; let c = 0; let n = 0;
  for (const day of days) {
    for (const r of day.dailyRows) {
      if (r.契約單價 == null || r.本日完成金額 == null) continue;
      n++;
      if (near(r.本日完成金額, (r.本日完成數量 || 0) * r.契約單價)) d++;
      if (near(r.本日完成金額, (r.累計完成數量 || 0) * r.契約單價)) c++;
    }
  }
  if (n < 10) return null;
  if (d / n > 0.8 && d >= c) return 'daily';
  if (c / n > 0.8) return 'cumulative';
  return null;
}

/** 「還沒填的天」判定(沒天氣 **且** 整天沒有本日完成量;0 也算沒填)。 */
function isUnfilled(day) {
  if (day.header.天氣_上午 != null || day.header.天氣_下午 != null) return false;
  const blank = (v) => v == null || v === 0;
  return (day.dailyRows || []).every((r) => blank(r.本日完成數量) && blank(r.本日完成金額));
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.readWorkbook !== 'function') {
    throw new Error('缺少注入的 filetypes.readWorkbook');
  }
  const wb = ft.readWorkbook(filePath);
  const out = [];
  let anchors = 0;
  // 月份分頁**會互相重疊**:「12月 」分頁實測含 12/16~1/31,與「1月」分頁整整重複
  // 31 天。不去重的話那 31 天會被算兩遍(D1 硬錯 31 個,而且逐日累加的金額全部翻倍)。
  // 分頁順序是由新到舊(2月/1月/12月),故**保留第一次出現的**——專屬分頁排在前面,
  // 它才是廠商後來整理過的版本。
  const seenDates = new Set();
  for (const name of wb.sheetNames) {
    const grid = wb.sheets[name];
    if (!grid || !grid.length) continue;
    const starts = blockStarts(grid);
    anchors += starts.length;
    for (let i = 0; i < starts.length; i++) {
      const end = i + 1 < starts.length ? starts[i + 1] : grid.length;
      const day = parseBlock(grid, starts[i], end, ft.excelSerialToISO);
      if (isUnfilled(day)) continue;
      const key = day.header.填報日期;
      if (key != null) {
        if (seenDates.has(key)) continue;
        seenDates.add(key);
      }
      out.push(day);
    }
  }
  // 分頁順序是由新到舊,但輸出要照時序,否則 SP3 的「前一日累計」全部對不上。
  out.sort((a, b) => String(a.header.填報日期).localeCompare(String(b.header.填報日期)));
  // 欄 11 的語意逐案不同(見 detectAmountMode);不是「本日金額」就一律 null。
  if (detectAmountMode(out) !== 'daily') {
    for (const day of out) for (const r of day.dailyRows) r.本日完成金額 = null;
  }
  if (!anchors) {
    // 回空陣列會被上游當成「這份沒有資料」而靜靜略過。
    throw new Error('找不到「表報編號」天區塊(此檔非正郁格式,或是無文字層的掃描件)');
  }
  return out;
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/** selfTest 用**真實座標**造一個最小區塊(取自成功國小 2 月,只換工程名稱)。 */
function selfTest(ft) {
  const g = [];
  const set = (r, c, v) => { (g[r] = g[r] || [])[c] = v; };
  set(0, 0, '公共工程施工日誌');
  set(1, 0, ANCHOR); set(1, 1, 'GD-048');
  set(2, 0, '本日天氣：上午：晴天 下午：陰天'); set(2, 5, '填表日期：');
  set(2, 7, 45689); set(2, 9, '(星期六)');
  set(3, 0, '工程名稱'); set(3, 2, '測試工程'); set(3, 5, '承攬商名稱'); set(3, 7, META_VENDOR_KEY);
  set(6, 0, '開工日期'); set(6, 2, '113年12月16日');
  set(7, 0, '預定進度(%)'); set(7, 2, 0.85); set(7, 7, 0.8229);
  set(9, 0, '施工項目'); set(9, 3, '單位'); set(9, 4, '契約數量');
  set(9, 5, '本日完成數量'); set(9, 7, '累計完成數量');
  set(10, 0, '壹、直接工程費');                              // 大類:沒有分隔空白
  set(11, 0, '1 工程告示牌(租用)'); set(11, 3, '面'); set(11, 4, 1);
  set(11, 7, 1); set(11, 10, 800); set(11, 11, 0);
  set(12, 0, '11 屋頂樓板與女兒牆及柱子底部30cm，刷底漆'); set(12, 3, 'M2'); set(12, 4, 245);
  set(12, 5, 20); set(12, 7, 154); set(12, 10, 1500); set(12, 11, 30000);
  set(13, 0, '貳 職業安全衛生管理費（壹*1%）'); set(13, 3, '式'); set(13, 4, 1);
  set(13, 7, 0.5); set(13, 10, 13598); set(13, 11, 0);
  set(14, 0, END_MARK); set(14, 10, '本日完成合計:'); set(14, 11, 30000);
  set(16, 0, '工別'); set(16, 2, '本日人數'); set(16, 3, '累計人數');
  set(16, 4, '機具名稱'); set(16, 6, '本日使用數量');
  set(17, 0, '技術工'); set(17, 2, 3); set(17, 3, 30); set(17, 4, '吊車'); set(17, 6, 1);
  set(18, 0, '普通工'); set(18, 3, 12);                      // 只有累計 → 本日 null
  set(19, 0, '四、本日施工項目是否有須依');

  const serial = ft && typeof ft.excelSerialToISO === 'function' ? ft.excelSerialToISO : null;
  const d = parseBlock(g, 1, g.length, serial);
  if (d.header.工程名稱 !== '測試工程') return false;
  if (d.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (serial && d.header.填報日期 !== '2025-02-01') return false;
  if (d.header.星期 !== '星期六') return false;
  if (d.header.開工日期 !== '2024-12-16') return false;
  if (d.header.天氣_上午 !== '晴天' || d.header.天氣_下午 !== '陰天') return false;
  if (d.header.預定進度 !== 0.85 || d.header.實際進度 !== 0.8229) return false;
  if (d.dailyRows.length !== 4) return false;
  const [cat, r1, r2, r3] = d.dailyRows;
  // 大類列沒有分隔空白,整格都是名稱
  if (cat.項次 !== '壹' || cat.工程項目 !== '直接工程費' || cat.單位 !== null) return false;
  // 項次與名稱擠在同一格,切錯的話名稱會多一截編號、SP3 拿名稱對契約表就對不上
  if (r1.項次 !== '1' || r1.工程項目 !== '工程告示牌(租用)') return false;
  if (r1.單位 !== '面' || r1.契約單價 !== 800) return false;
  if (r2.項次 !== '11') return false;
  if (r2.工程項目 !== '屋頂樓板與女兒牆及柱子底部30cm，刷底漆') return false;
  if (r2.本日完成數量 !== 20 || r2.累計完成數量 !== 154 || r2.本日完成金額 !== 30000) return false;
  if (r3.項次 !== '貳' || r3.工程項目 !== '職業安全衛生管理費（壹*1%）') return false;
  if (d.header.出工總人數 !== 3) return false;                // 普通工只有累計欄,不計
  if (d.extras.出工明細.find((c) => c.工別 === '普通工').人數 !== null) return false;
  if (isUnfilled(d)) return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '星期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '出工總人數', '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約單價', '契約數量',
      '本日完成數量', '本日完成金額', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parseBlock, blockStarts, splitItemNo, weatherOf, weekdayOf, rocTextToISO },
};
