/**
 * shenglong.pmisparser.js — 聖隆營造施工日誌讀取器(成功國小 PU / 後埔國小環境工程)
 *
 * vendorKey 取自**決標公告的得標廠商**(兩案皆為聖隆營造有限公司),`基本資料` 分頁
 * r2 欄 7 的「承攬廠商」也載明同一個名稱,兩邊一致。
 *
 * ── 版面事實(兩案實測一致)──
 * 這不是「一天一張表」而是**資料庫式活頁簿**:逐日資料橫躺在幾張矩陣分頁上,
 * 一天一列,以日期序號(欄 0)互相對應。一天的內容要從四張分頁拼起來:
 *
 *   `基本資料`  r1 欄0=開工日期  r0 欄7=工程名稱  r2 欄7=承攬廠商
 *   `記事`      r3 起逐日:欄0=日期 欄1/2=上午/下午天氣 欄8=累計預定進度
 *                                  欄17=累計實際進度(日誌)
 *   `工料`      r4 起逐日:欄0=日期;r1=群組(出工情形/機具使用量/材料項目)、
 *                          r2=名稱、r3=本日/累計 → 依表頭定位,不寫死欄號
 *   `No1`(、`No2`、`No3`…) r7 起逐日:欄0=日期 欄1=該表當日金額小計
 *
 * ── No* 分頁的「兩個平行區塊」(最容易寫錯的地方)──
 * 每張 No 表的欄位分成**兩段一模一樣的項次序列**,中間夾一欄標著「累計」:
 *   欄 2..sep-1  = 當日完成數量        欄 sep+1..  = 累計完成數量
 * 兩段的項次/名稱/單價/設計數量完全相同(r0/r1/r2/r3),光看表頭分不出來——
 * 晉林踩過同一個坑。sep 由 r1 上值為「累計」的欄動態偵測,兩段長度不等就 throw。
 *
 * 表頭列(每張 No 表都一樣):
 *   r0=項次  r1=工程項目  r2=單價  r3=設計數量  r4=累計完成數量(總計,不是逐日)
 *   r5 欄0=該表的大類(「壹.直接工程」/「二.排水溝整建工程」…)  r6=單位  r7 起=逐日
 *
 * ── 項次要加大類前綴才唯一 ──
 * 後埔案把項目拆成 No1/No2/No3 三張表,**各自從 1 編號**,直接用會撞號
 * (No1 的「3」與 No2 的「3」是不同項目)。故數字項次一律前綴所屬大類:
 * 一.1 / 二.3 / 三.5;費用項(貳~陸)本身就是頂層編號,不加前綴。
 * 大類的判定是**單位欄為空**(後埔 No1 欄 2 的「一 假設工程」單價 0、單位空),
 * 不能用「項次非數字」——費用項的項次也是中文數字,但它們有單位有單價,是真項目。
 *
 * ── 沒有的欄位就留 null ──
 * 逐項的**本日完成金額**在此格式不存在(No 表只有欄 1 的當日全表小計),
 * 用「單價 × 本日數量」回推是推導不是來源值,一律 null(護欄:金額找不到就留 null)。
 * 同理沒有逐日的累計金額。
 */

const META_VENDOR_KEY = '聖隆營造有限公司';

const SHEET = { 基本: '基本資料', 記事: '記事', 工料: '工料' };
const NO_SHEET_RE = /^No\d+$/;

// No 表的表頭列
const NO_ROW = { 項次: 0, 名稱: 1, 單價: 2, 設計數量: 3, 大類: 5, 單位: 6, 首日: 7 };
const NO_FIRST_COL = 2;          // 欄 0=日期、欄 1=當日金額小計

// 記事分頁
const JI_FIRST = 3;
const JI = { 日期: 0, 天氣上午: 1, 天氣下午: 2, 累計預定進度: 8, 累計實際進度: 17 };

// 工料分頁:群組列 / 名稱列 / 本日-累計列,首個資料列
const GL = { 群組: 1, 名稱: 2, 本日累計: 3, 首列: 4 };

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

/**
 * 一張 No 表的欄位定義。回 { items: [{項次,名稱,單價,數量,單位,c1,c2}] }。
 * c1 = 當日完成數量欄、c2 = 對應的累計完成數量欄。
 */
function noSheetSpec(grid) {
  const head = grid[NO_ROW.名稱] || [];
  let sep = -1;
  for (let c = NO_FIRST_COL; c < head.length; c++) {
    if (text(head[c]) === '累計') { sep = c; break; }
  }
  if (sep < 0) throw new Error('No 表找不到分隔「累計」欄,無法區分當日與累計兩個區塊');

  const width = grid.reduce((m, r) => Math.max(m, r ? r.length : 0), 0);
  const cols = (from, to) => {
    const o = [];
    for (let c = from; c < to; c++) if (text(at(grid, NO_ROW.項次, c)) != null) o.push(c);
    return o;
  };
  const b1 = cols(NO_FIRST_COL, sep);
  const b2 = cols(sep + 1, width);
  // 兩段必須等長且項次逐一對齊,否則當日與累計會錯位到別的項目上——
  // 那不會讓任何欄位變 null,完整性關卡看不見。
  if (b1.length !== b2.length || !b1.length) {
    throw new Error(`No 表的當日/累計兩區塊欄數不符(${b1.length} vs ${b2.length})`);
  }
  for (let i = 0; i < b1.length; i++) {
    if (String(at(grid, NO_ROW.項次, b1[i])) !== String(at(grid, NO_ROW.項次, b2[i]))) {
      throw new Error('No 表的當日/累計兩區塊項次序列不一致');
    }
  }

  // 大類前綴:表頭 r5 欄 0 形如「壹.直接工程」/「二.排水溝整建工程」,取編號部分。
  let prefix = (text(at(grid, NO_ROW.大類, 0)) || '').split('.')[0] || null;
  const items = [];
  for (let i = 0; i < b1.length; i++) {
    const c1 = b1[i];
    const no = String(at(grid, NO_ROW.項次, c1)).trim();
    const 單位 = text(at(grid, NO_ROW.單位, c1));
    if (單位 == null) {                        // 大類/群組列:單位、單價都空著
      prefix = no;
      items.push({
        項次: no, 名稱: text(at(grid, NO_ROW.名稱, c1)),
        單價: null, 數量: null, 單位: null, c1, c2: b2[i], 大類: true,
      });
      continue;
    }
    items.push({
      項次: /^\d+$/.test(no) && prefix ? `${prefix}.${no}` : no,
      名稱: text(at(grid, NO_ROW.名稱, c1)),
      單價: numOf(at(grid, NO_ROW.單價, c1)),
      數量: numOf(at(grid, NO_ROW.設計數量, c1)),
      單位: String(單位).normalize('NFKC'),
      c1, c2: b2[i], 大類: false,
    });
  }
  return { items };
}

/** 工料分頁的出工/機具欄位定義(依表頭定位,不寫死欄號)。 */
function crewSpec(grid) {
  const g1 = grid[GL.群組] || [];
  const g2 = grid[GL.名稱] || [];
  const g3 = grid[GL.本日累計] || [];
  const crew = [];
  const tools = [];
  for (let c = 1; c < g3.length; c++) {
    if (text(g3[c]) !== '本日') continue;      // 只取「本日」那一欄,累計欄不算出工
    const group = text(g1[c]);
    const name = text(g2[c]);
    if (!name) continue;
    if (group === '出工情形') crew.push({ c, name });
    else if (group === '機具使用量') tools.push({ c, name });
  }
  return { crew, tools };
}

/** 以日期序號建索引:序號 → 該分頁的列。 */
function indexByDate(grid, firstRow) {
  const m = new Map();
  for (let r = firstRow; r < grid.length; r++) {
    const v = at(grid, r, 0);
    if (typeof v === 'number' && Number.isFinite(v)) m.set(v, r);
  }
  return m;
}

/**
 * 組一天(純函式;selfTest 重用之)。
 * @param {object} src { 記事, 工料, noSheets:[{grid,spec}], 基本 }
 * @param {number} serial 日期序號
 */
function buildDay(src, serial, serialToISO) {
  const { 記事, 工料, noSheets, base, glSpec, jiIdx, glIdx } = src;
  const jr = jiIdx.get(serial);
  const gr = glIdx.get(serial);

  const dailyRows = [];
  for (const { grid, spec, idx } of noSheets) {
    const dr = idx.get(serial);
    if (dr == null) continue;
    for (const it of spec.items) {
      dailyRows.push({
        項次: it.項次,
        工程項目: it.名稱,
        單位: it.單位,
        契約單價: it.單價,
        契約數量: it.數量,
        本日完成數量: numOf(at(grid, dr, it.c1)),
        // 逐項的本日金額此格式不存在(只有欄 1 的當日全表小計);
        // 用單價×數量回推是推導不是來源值。
        本日完成金額: null,
        累計完成數量: numOf(at(grid, dr, it.c2)),
      });
    }
  }

  const extras = {};
  let 出工總人數 = null;
  if (gr != null) {
    const 出工明細 = glSpec.crew
      .map((x) => ({ 工別: x.name, 人數: numOf(at(工料, gr, x.c)) }));
    const 主要機具 = glSpec.tools
      .map((x) => ({ 名稱: x.name, 數量: numOf(at(工料, gr, x.c)) }));
    if (出工明細.length) {
      extras.出工明細 = 出工明細;
      const n = 出工明細.filter((c) => c.人數 != null);
      if (n.length) 出工總人數 = n.reduce((s, c) => s + c.人數, 0);
    }
    if (主要機具.length) extras.主要機具 = 主要機具;
  }

  return {
    header: {
      工程名稱: text(at(base, 0, 7)),
      填報日期: serialToISO ? serialToISO(serial) : null,
      星期: null,                                   // 此格式不提供
      天氣_上午: jr == null ? null : text(at(記事, jr, JI.天氣上午)),
      天氣_下午: jr == null ? null : text(at(記事, jr, JI.天氣下午)),
      // 記事同時有本日(欄7)與累計(欄8)進度;SP3 的 F3/C4 驗的是累計語意。
      預定進度: jr == null ? null : numOf(at(記事, jr, JI.累計預定進度)),
      實際進度: jr == null ? null : numOf(at(記事, jr, JI.累計實際進度)),
      出工總人數,
      本日累計金額: null,                            // 來源只有當日小計,不自行累加
      承包廠商: text(at(base, 2, 7)),
      開工日期: serialToISO ? serialToISO(numOf(at(base, 1, 0))) : null,
    },
    dailyRows,
    extras,
  };
}

/**
 * 「還沒填的天」判定。整個工期的列是一次建好的,交檔當下工期還沒結束,
 * 尾端因此有一批只有日期、其餘全空的列。
 * **只憑「沒天氣」丟掉是危險的**(真的漏填天氣卻有施工的日子會消失),
 * 故要求整天也沒有任何本日完成量。
 */
function isUnfilled(day) {
  if (day.header.天氣_上午 != null || day.header.天氣_下午 != null) return false;
  const blank = (v) => v == null || v === 0;
  return (day.dailyRows || []).every((r) => blank(r.本日完成數量));
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.readWorkbook !== 'function') {
    throw new Error('缺少注入的 filetypes.readWorkbook');
  }
  const wb = ft.readWorkbook(filePath);
  const base = wb.sheets[SHEET.基本];
  const 記事 = wb.sheets[SHEET.記事];
  const 工料 = wb.sheets[SHEET.工料];
  const noNames = wb.sheetNames.filter((n) => NO_SHEET_RE.test(n));
  if (!base || !記事 || !工料 || !noNames.length) {
    // 回空陣列會被上游當成「這份沒有資料」而靜靜略過——此案的 PDF 是 15~35MB 的
    // 掃描件,SheetJS 對它會回一份空活頁簿,一定要明講。
    throw new Error('缺少「基本資料/記事/工料/NoN」分頁(此檔非聖隆格式,或是無文字層的掃描件)');
  }

  const noSheets = noNames.map((n) => {
    const grid = wb.sheets[n];
    return { grid, spec: noSheetSpec(grid), idx: indexByDate(grid, NO_ROW.首日) };
  });
  const src = {
    記事, 工料, base, noSheets,
    glSpec: crewSpec(工料),
    jiIdx: indexByDate(記事, JI_FIRST),
    glIdx: indexByDate(工料, GL.首列),
  };

  const out = [];
  for (const serial of src.jiIdx.keys()) {
    const day = buildDay(src, serial, ft.excelSerialToISO);
    if (isUnfilled(day)) continue;
    out.push(day);
  }
  return out;
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest 用**真實座標**造一份最小活頁簿(取自後埔 No1/No2 與成功案的形狀)。
 * 要驗的是三件最容易寫錯的事:兩個平行區塊不可錯位、大類以單位欄為空判定
 * (費用項的項次也是中文數字但它們是真項目)、項次要加大類前綴才唯一。
 */
function selfTest(ft) {
  const mk = () => [];
  const set = (g, r, c, v) => { (g[r] = g[r] || [])[c] = v; };

  const base = mk();
  set(base, 0, 7, '測試工程'); set(base, 1, 0, 45803); set(base, 2, 7, META_VENDOR_KEY);

  const ji = mk();
  set(ji, 2, 0, '日期'); set(ji, 2, 1, '天氣');
  set(ji, 3, 0, 45803); set(ji, 3, 1, '晴'); set(ji, 3, 2, '陰');
  set(ji, 3, 8, 0.00096); set(ji, 3, 17, 0.0138);
  set(ji, 4, 0, 45804);                                  // 沒天氣、沒施工 → 不算一天

  const gl = mk();
  set(gl, 1, 1, '出工情形'); set(gl, 1, 2, '出工情形'); set(gl, 1, 3, '出工情形');
  set(gl, 1, 4, '出工情形'); set(gl, 1, 5, '機具使用量'); set(gl, 1, 6, '機具使用量');
  set(gl, 2, 1, '現場工程師'); set(gl, 2, 2, '現場工程師');
  set(gl, 2, 3, '技工'); set(gl, 2, 4, '技工');
  set(gl, 2, 5, '挖土機'); set(gl, 2, 6, '挖土機');
  set(gl, 3, 0, '日期'); set(gl, 3, 1, '本日'); set(gl, 3, 2, '累計');
  set(gl, 3, 3, '本日'); set(gl, 3, 4, '累計'); set(gl, 3, 5, '本日'); set(gl, 3, 6, '累計');
  set(gl, 4, 0, 45803); set(gl, 4, 1, 1); set(gl, 4, 2, 1); set(gl, 4, 4, 3); set(gl, 4, 6, 0);

  // No1:欄 2 是大類「一 假設工程」(單位空、單價 0),欄 3~4 是項次 1、2。
  // sep 在欄 5;兩區塊 = 欄2~4 與 欄6~8。
  const no1 = mk();
  set(no1, 0, 1, '項次'); set(no1, 0, 2, '一'); set(no1, 0, 3, 1); set(no1, 0, 4, 2);
  set(no1, 0, 6, '一'); set(no1, 0, 7, 1); set(no1, 0, 8, 2);
  set(no1, 1, 1, '工程項目'); set(no1, 1, 2, '假設工程');
  set(no1, 1, 3, '乙種安全圍籬'); set(no1, 1, 4, '工程告示牌');
  set(no1, 1, 5, '累計'); set(no1, 1, 6, '假設工程');
  set(no1, 1, 7, '乙種安全圍籬'); set(no1, 1, 8, '工程告示牌');
  set(no1, 2, 1, '單 價'); set(no1, 2, 2, 0); set(no1, 2, 3, 60000); set(no1, 2, 4, 2500);
  set(no1, 3, 1, '設計數量'); set(no1, 3, 2, 1); set(no1, 3, 3, 1); set(no1, 3, 4, 1);
  set(no1, 5, 0, '壹.直接工程');
  set(no1, 6, 0, '日期'); set(no1, 6, 3, '式'); set(no1, 6, 4, '式');
  set(no1, 6, 7, '式'); set(no1, 6, 8, '式');
  // 當日只做了項次 1(0.3),累計則是 1 —— 兩區塊若錯位,0.3 會跑到別的項目上
  set(no1, 7, 0, 45803); set(no1, 7, 1, 62500);
  set(no1, 7, 3, 0.3); set(no1, 7, 7, 1); set(no1, 7, 8, 1);
  set(no1, 8, 0, 45804);

  // No2:沒有大類列,前綴取自 r5 的「二」;末尾的「貳」是費用項(有單位)不是大類。
  const no2 = mk();
  set(no2, 0, 1, '項次'); set(no2, 0, 2, 1); set(no2, 0, 3, '貳');
  set(no2, 0, 5, 1); set(no2, 0, 6, '貳');
  set(no2, 1, 1, '工程項目'); set(no2, 1, 2, '西側排水溝打除'); set(no2, 1, 3, '職業安全衛生管理費');
  set(no2, 1, 4, '累計'); set(no2, 1, 5, '西側排水溝打除'); set(no2, 1, 6, '職業安全衛生管理費');
  set(no2, 2, 1, '單 價'); set(no2, 2, 2, 114000); set(no2, 2, 3, 45112);
  set(no2, 3, 1, '設計數量'); set(no2, 3, 2, 1); set(no2, 3, 3, 1);
  set(no2, 5, 0, '二.排水溝整建工程');
  set(no2, 6, 0, '日期'); set(no2, 6, 2, '式'); set(no2, 6, 3, '式');
  set(no2, 6, 5, '式'); set(no2, 6, 6, '式');
  set(no2, 7, 0, 45803); set(no2, 7, 1, 0); set(no2, 7, 5, 0); set(no2, 7, 6, 0);

  const src = {
    記事: ji, 工料: gl, base,
    noSheets: [
      { grid: no1, spec: noSheetSpec(no1), idx: indexByDate(no1, NO_ROW.首日) },
      { grid: no2, spec: noSheetSpec(no2), idx: indexByDate(no2, NO_ROW.首日) },
    ],
    glSpec: crewSpec(gl),
    jiIdx: indexByDate(ji, JI_FIRST),
    glIdx: indexByDate(gl, GL.首列),
  };
  const serialToISO = ft && typeof ft.excelSerialToISO === 'function' ? ft.excelSerialToISO : null;
  const d = buildDay(src, 45803, serialToISO);

  if (d.header.工程名稱 !== '測試工程') return false;
  if (d.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (serialToISO && d.header.填報日期 !== '2025-05-26') return false;
  if (serialToISO && d.header.開工日期 !== '2025-05-26') return false;
  if (d.header.天氣_上午 !== '晴' || d.header.天氣_下午 !== '陰') return false;
  if (d.header.預定進度 !== 0.00096 || d.header.實際進度 !== 0.0138) return false;
  if (d.header.出工總人數 !== 1) return false;         // 技工只有累計欄(3),不計
  if (d.dailyRows.length !== 5) return false;          // No1 三列(含大類) + No2 兩列
  const [cat, a1, a2, b1, b2] = d.dailyRows;
  if (cat.項次 !== '一' || cat.單位 !== null) return false;        // 大類以單位空判定
  if (a1.項次 !== '一.1' || a1.單位 !== '式') return false;        // 數字項次加大類前綴
  if (a1.本日完成數量 !== 0.3 || a1.累計完成數量 !== 1) return false; // 兩區塊不可錯位
  if (a2.項次 !== '一.2' || a2.本日完成數量 !== null) return false;
  if (a2.累計完成數量 !== 1) return false;
  if (b1.項次 !== '二.1') return false;                            // 前綴取自 r5
  if (b2.項次 !== '貳' || b2.單位 !== '式') return false;          // 費用項不加前綴、不是大類
  if (a1.本日完成金額 !== null) return false;                      // 逐項金額此格式不存在
  if (isUnfilled(d)) return false;
  const d2 = buildDay(src, 45804, serialToISO);
  if (!isUnfilled(d2)) return false;                               // 沒天氣沒施工 → 不算一天
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '出工總人數', '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約單價', '契約數量',
      '本日完成數量', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { noSheetSpec, crewSpec, buildDay, indexByDate, isUnfilled },
};
