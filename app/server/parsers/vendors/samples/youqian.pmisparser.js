/**
 * youqian.pmisparser.js — 有謙營造有限公司施工日誌讀取器(元長國小校園鋪面改善)
 *
 * vendorKey 取自**決標公告的得標廠商**(`模板\決標公告\元長鋪面決標公告.pdf`,
 * 工程編號 A1150522);日誌每一天的「承攬廠商名稱」欄也寫同一個名稱,兩邊一致。
 *
 * ── 版面事實(實測 1 份 xlsx / 30 天 / 780 明細列)──
 * 工程會標準表單的單聯版,單一分頁 `施工日誌1`,一天一個 61 列的區塊往下堆,
 * 錨點是欄 0 去空白後等於「表報編號：」。欄位落點一律**由表頭標籤定位**,不寫死。
 *   a+1  欄1=上午: 欄2=值 欄3=下午: 欄4=值   欄7=填報日期: 欄9=值(Excel 序號)
 *   a+2  欄0=工程名稱 欄1=值               欄7=承攬廠商名稱 欄10=值
 *   a+4  欄0=開工日期 欄3=值(Excel 序號)
 *   a+5  欄0=預定進度(%) 欄3=值            欄7=實際進度(%) 欄10=值(**分數**)
 *   a+8  明細表頭   a+9 起是明細,到「二、工地材料管理概況」為止
 *
 * ── 這一家與同族(利成/德信/沅隆…)的差別:多了三欄 ──
 * 標準表單只到「備註」,這家在右邊自己加了 **單價 / 複價 / 實做金額**。
 * 沅隆的讀取器讀得動這份檔的其他欄位,唯獨這三欄它沒有 → 契約單價整份 null。
 * 這是要另寫一支的原因,不是版面不同。
 *
 * ── 「實做金額」是**累計**金額,不是本日金額(用算式在整份檔核對過)──
 * 780 列裡 **780 列**符合「實做金額 = 累計完成數量 × 單價」,只有 594 列同時也符合
 * 「= 本日完成數量 × 單價」——那 594 列是本日與累計恰好相等(或都是 0)的巧合。
 * 標籤寫「實做金額」看起來像本日,照標籤收會讓每一天的本日金額都變成累計值。
 * 故 **本日完成金額一律 null**(此格式沒有本日金額,不回推);
 * 該日合計列的實做金額 = 當日累計金額 → 收進 header.本日累計金額。
 *
 * ── 合計列的判定不能只看「欄 17 有數字」──
 * 明細區結尾有兩列都是「欄 0 空、欄 17 有數字」:
 *   a+35  欄16=4416270(契約總價) 欄17=19316(當日累計金額)   ← 這才是合計
 *   a+36  欄17=0.004373…(實際進度又印一次)                  ← 不是金額
 * 只看欄 17 會把累計金額覆蓋成 0.0043。故要求**複價與實做金額同時是數字**,
 * 並取第一個符合的列。
 *
 * ── 項次用出現序 ──
 * 此格式沒有項次欄,但**每天都印完整的 26 項清單**(780 ÷ 30 = 26),
 * 與發包後經費總表逐項同序,故用「出現序」當項次(skill 的判準:每天都印完整清單
 * 才可以用出現序;逐日只列當天施作的那種一定要用名稱)。
 *
 * ── 此格式沒有的東西 ──
 * 沒有星期、沒有本日完成金額。「二、工地材料管理概況」那張表實測 30 天全空
 * (程式照收,有才填)。
 */

const META_VENDOR_KEY = '有謙營造有限公司';

// despace 會做 NFKC,全形冒號會折成半形——字面量要寫半形,否則永遠對不上
const ANCHOR = '表報編號:';
// 單位一律白名單(禁樣式判定:名稱裡的 RC/PVC 會被當成單位)
const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'kg', '噸', 'T',
  '公尺', '公斤', '平方公尺', '立方公尺', '場', '座', '組', '支', '個', '只', '片',
  '面', '處', '間', '棵', '株', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '才', '天', '日', '人']);
const SECTION = /^[一二三四五六七八九十]+、/;

const nfkc = (v) => String(v == null ? '' : v).normalize('NFKC');
const despace = (v) => nfkc(v).replace(/[\s　]/g, '');

/**
 * 文字欄。無資料標記統一 null。
 *
 * **`0` 也是無資料標記**:這家從第 3 天起把「工程名稱」那格存成數值 0(30 天裡
 * 28 天都是,只有前兩天填了名稱)。收成字串 "0" 的話,每一天都會拿 "0" 去跟主檔的
 * 工程名稱比,SP3 噴 28 個 G1 軟警告,而畫面上顯示的工程名稱是「0」。
 * 這不是「把來源的錯改好」——那一格在文件上就是空的,0 是 Excel 對空公式的顯示值。
 */
function text(v) {
  const s = nfkc(v).replace(/[\r\n]+/g, '').trim();
  return s === '' || s === '-' || s === '－' || s === '0' ? null : s;
}

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = nfkc(v).replace(/[,\s　%]/g, '');
  if (s === '' || s === '-' || s === '－') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const unitOf = (v) => {
  const s = despace(v);
  return s && KNOWN_UNITS.has(s) ? s : null;
};

/**
 * 進度欄存的是分數(0.0471 = 4.71%),表頭寫的是(％)。**保留原值不換算**:
 * 這是 Excel 系讀取器的既有慣例,SP3 的 H1 正是照「整份最大值 <= 1 就當分數」在判。
 */
const pct = (v) => num(v);

const at = (grid, r, c) => (grid && grid[r] ? grid[r][c] : undefined);

/** 在某列找第一個去空白後等於 label 的欄(合併填充後同值連續,取最左)。 */
function colOf(row, label) {
  for (let c = 0; c < (row || []).length; c++) if (despace(row[c]) === label) return c;
  return -1;
}

/**
 * 取 label 右邊第一個「與 label 不同」的值(標籤自己會因合併填充佔好幾欄)。
 *
 * **值本身含冒號一律視為沒填**:同一列右邊還有別的標籤,廠商把「下午：」留白時
 * 往右撈會撈到「填報日期：」當成天氣(義鼎那家實際發生過)。
 */
function valueAfter(row, label) {
  const c = colOf(row, label);
  if (c < 0) return null;
  const lab = despace(row[c]);
  for (let i = c + 1; i < (row || []).length; i++) {
    if (despace(row[i]) === lab) continue;
    if (row[i] == null || String(row[i]).trim() === '') continue;
    if (typeof row[i] === 'string' && /:/.test(nfkc(row[i]))) return null;
    return row[i];
  }
  return null;
}

/**
 * 解析一天(純函式;selfTest 重用之)。
 * @param {Array<Array>} grid 分頁
 * @param {number} a 錨點列(欄 0 = 表報編號：)
 * @param {number} end 下一個錨點列(或分頁末)
 * @param {(serial:number)=>string|null} [serialToISO]
 */
function parseDay(grid, a, end, serialToISO) {
  const rowWith = (re) => {
    for (let r = a; r < end; r++) if (re.test(despace(at(grid, r, 0)))) return r;
    return -1;
  };
  const iso = (v) => {
    const n = num(v);
    return n != null && serialToISO ? serialToISO(n) : null;
  };

  const wr = rowWith(/^本日天氣/);
  const nr = rowWith(/^工程名稱$/);
  const sr = rowWith(/^開工日期$/);
  const pr = rowWith(/^預定進度/);

  const dailyRows = [];
  let 本日累計金額 = null;
  const hr = rowWith(/^施工項目$/);
  if (hr >= 0) {
    const hdr = grid[hr];
    const c單位 = colOf(hdr, '單位');
    const c契約 = colOf(hdr, '契約數量');
    const c本日 = colOf(hdr, '本日完成數量');
    const c累計 = colOf(hdr, '累計完成數量');
    const c單價 = colOf(hdr, '單價');
    const c複價 = colOf(hdr, '複價');
    const c實做 = colOf(hdr, '實做金額');
    if ([c單位, c契約, c本日, c累計, c單價].some((c) => c < 0)) {
      throw new Error('明細表頭欄位找不到(非有謙格式?)');
    }
    for (let r = hr + 1; r < end; r++) {
      const name = text(at(grid, r, 0));
      if (name != null && SECTION.test(name)) break;
      if (name == null) {
        // 合計列:複價(契約總價)與實做金額同時是數字才算(見檔頭)
        if (本日累計金額 == null && c複價 >= 0 && c實做 >= 0
          && num(at(grid, r, c複價)) != null && num(at(grid, r, c實做)) != null) {
          本日累計金額 = num(at(grid, r, c實做));
        }
        continue;
      }
      const 單位 = unitOf(at(grid, r, c單位));
      if (單位 == null) continue;                      // 標籤列/說明列沒有單位
      dailyRows.push({
        項次: String(dailyRows.length + 1),            // 此格式無項次欄,見檔頭
        工程項目: name,
        單位,
        契約單價: num(at(grid, r, c單價)),
        契約數量: num(at(grid, r, c契約)),
        本日完成數量: num(at(grid, r, c本日)),
        本日完成金額: null,                             // 實做金額是累計金額,見檔頭
        累計完成數量: num(at(grid, r, c累計)),
      });
    }
  }

  const extras = {};
  let 出工總人數 = null;
  const cr = rowWith(/^工別$/);
  if (cr >= 0) {
    const hdr = grid[cr];
    const c人數 = colOf(hdr, '本日人數');
    const c機具 = colOf(hdr, '機具名稱');
    const c機數 = colOf(hdr, '本日使用數量');
    const 出工明細 = [];
    const 主要機具 = [];
    for (let r = cr + 1; r < end; r++) {
      const w = text(at(grid, r, 0));
      if (w != null && SECTION.test(w)) break;
      const n = num(at(grid, r, c人數));
      if (w != null && n != null && n > 0) 出工明細.push({ 工別: w, 人數: n });
      if (n != null) 出工總人數 = (出工總人數 || 0) + n;
      const gname = text(at(grid, r, c機具));
      const gn = num(at(grid, r, c機數));
      if (gname != null && gn != null && gn > 0) 主要機具.push({ 名稱: gname, 數量: gn });
    }
    if (出工明細.length) extras.出工明細 = 出工明細;
    if (主要機具.length) extras.主要機具 = 主要機具;
  }
  const mr = rowWith(/^材料名稱$/);
  if (mr >= 0) {
    const hdr = grid[mr];
    const c單位 = colOf(hdr, '單位');
    const c本日 = colOf(hdr, '本日使用數量');
    const 主要材料 = [];
    for (let r = mr + 1; r < end; r++) {
      const n = text(at(grid, r, 0));
      if (n != null && SECTION.test(n)) break;
      if (n == null) continue;
      主要材料.push({ 名稱: n, 單位: unitOf(at(grid, r, c單位)), 數量: num(at(grid, r, c本日)) });
    }
    if (主要材料.length) extras.主要材料 = 主要材料;
  }

  return {
    header: {
      工程名稱: nr < 0 ? null : text(valueAfter(grid[nr], '工程名稱')),
      填報日期: wr < 0 ? null : iso(valueAfter(grid[wr], '填報日期:')),
      星期: null,                                      // 此格式不提供
      天氣_上午: wr < 0 ? null : text(valueAfter(grid[wr], '上午:')),
      天氣_下午: wr < 0 ? null : text(valueAfter(grid[wr], '下午:')),
      預定進度: pr < 0 ? null : pct(valueAfter(grid[pr], '預定進度(%)')),
      實際進度: pr < 0 ? null : pct(valueAfter(grid[pr], '實際進度(%)')),
      出工總人數,
      本日累計金額,
      承包廠商: nr < 0 ? null : text(valueAfter(grid[nr], '承攬廠商名稱')),
      開工日期: sr < 0 ? null : iso(valueAfter(grid[sr], '開工日期')),
    },
    dailyRows,
    extras,
  };
}

function blockStarts(grid) {
  const out = [];
  for (let r = 0; r < (grid || []).length; r++) if (despace(at(grid, r, 0)) === ANCHOR) out.push(r);
  return out;
}

/** 依填報日期去重(保留明細多的那一份),並照時序輸出。 */
function dedupe(days) {
  const byDate = new Map();
  const noDate = [];
  for (const d of days) {
    const k = d.header.填報日期;
    if (!k) { noDate.push(d); continue; }
    const prev = byDate.get(k);
    if (!prev || prev.dailyRows.length < d.dailyRows.length) byDate.set(k, d);
  }
  const out = [...byDate.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([, d]) => d);
  return out.concat(noDate);
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.readWorkbook !== 'function') throw new Error('缺少注入的 filetypes.readWorkbook');
  const wb = ft.readWorkbook(filePath);
  const days = [];
  for (const name of Object.keys((wb && wb.sheets) || {})) {
    const grid = wb.sheets[name];
    const starts = blockStarts(grid);
    for (let i = 0; i < starts.length; i++) {
      days.push(parseDay(grid, starts[i], i + 1 < starts.length ? starts[i + 1] : grid.length,
        ft.excelSerialToISO));
    }
  }
  // 回空陣列會被上游當成「這份沒有資料」而靜靜略過
  if (!days.length) throw new Error('找不到「表報編號」區塊(此檔非有謙日誌,或是無文字層的掃描件)');
  // 「還沒填的天」濾掉:沒有日期**且**沒有明細(只用前者會讓真的漏填的日子靜默消失)
  const filled = days.filter((d) => d.header.填報日期 != null || d.dailyRows.length > 0);
  // 「表報編號：」是至少 8 家共用的錨點,光靠它會假陽性:讀得出一堆天、卻一欄都沒值。
  if (!filled.some((d) => d.header.填報日期 != null)) {
    throw new Error('每一天都讀不到填報日期(此檔錨點雖然對上,版面不是有謙的)');
  }
  return dedupe(filled);
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest 用**真實儲存格**造兩天(取自 `施工日誌-雲林縣元長國小舖面.xlsx` 的
 * 第 1、2 天,只換工程名稱)。斷言各對著一個坑:實做金額不可當成本日金額、
 * 合計列不可取到下面那列的進度值、「下午：」留白時不可撈到隔壁標籤。
 */
function selfTest(ft) {
  const g = [];
  const set = (r, from, to, v) => { g[r] = g[r] || []; for (let c = from; c <= to; c++) g[r][c] = v; };
  const block = (a, serial, 下午, items, 合計, 工程名稱) => {
    set(a, 0, 0, '表報編號：'); set(a, 1, 17, 1);
    set(a + 1, 0, 0, '本日天氣：'); set(a + 1, 1, 1, '上午：'); set(a + 1, 2, 2, '晴');
    set(a + 1, 3, 3, '下午：'); if (下午) set(a + 1, 4, 4, 下午);
    set(a + 1, 7, 8, '填報日期：'); set(a + 1, 9, 13, serial);
    set(a + 2, 0, 0, '工程名稱'); set(a + 2, 1, 6, 工程名稱);
    set(a + 2, 7, 9, '承攬廠商名稱'); set(a + 2, 10, 17, META_VENDOR_KEY);
    set(a + 3, 0, 0, '核定工期'); set(a + 3, 1, 1, 60); set(a + 3, 2, 2, '日曆天');
    set(a + 4, 0, 2, '開工日期'); set(a + 4, 3, 6, 46212);
    set(a + 4, 7, 9, '完工日期'); set(a + 4, 10, 13, 46271);
    set(a + 5, 0, 2, '預定進度（％）'); set(a + 5, 3, 6, 0.0002);
    set(a + 5, 7, 9, '實際進度（％）'); set(a + 5, 10, 13, 0.0471701232035179);
    set(a + 7, 0, 17, '一、依施工計畫書執行按圖施工概況（含約定之重要施工項目及完成數量等）：');
    set(a + 8, 0, 4, '施　工　項　目'); set(a + 8, 5, 5, '單位'); set(a + 8, 6, 7, '契約數量');
    set(a + 8, 8, 10, '本日完成數量'); set(a + 8, 11, 12, '累計完成數量'); set(a + 8, 13, 14, '備註');
    set(a + 8, 15, 15, '單價'); set(a + 8, 16, 16, '複價'); set(a + 8, 17, 17, '實做金額');
    items.forEach((it, i) => {
      const r = a + 9 + i;
      set(r, 0, 4, it[0]); set(r, 5, 5, it[1]); set(r, 6, 7, it[2]);
      if (it[3] != null) set(r, 8, 10, it[3]);
      if (it[4] != null) set(r, 11, 12, it[4]);
      set(r, 15, 15, it[5]); set(r, 16, 16, it[6]); if (it[7] != null) set(r, 17, 17, it[7]);
    });
    // 合計列,以及它下面那列「又印一次實際進度」——後者不可被當成金額
    set(a + 35, 16, 16, 4416270); set(a + 35, 17, 17, 合計);
    set(a + 36, 17, 17, 0.0471701232035179);
    set(a + 45, 0, 17, '二、工地材料管理概況（含約定之重要材料使用狀況及數量等）：');
    set(a + 46, 0, 4, '材料名稱'); set(a + 46, 5, 5, '單位'); set(a + 46, 6, 7, '契約數量');
    set(a + 46, 8, 10, '本日使用數量'); set(a + 46, 11, 12, '累計使用數量');
    set(a + 48, 0, 17, '三、工地人員及機具管理（含約定之出工人數及機具使用情形及數量）：');
    set(a + 49, 0, 1, '工別'); set(a + 49, 2, 3, '本日人數'); set(a + 49, 4, 5, '累計人數');
    set(a + 49, 6, 8, '機具名稱'); set(a + 49, 9, 11, '本日使用數量'); set(a + 49, 12, 14, '累計使用數量');
    set(a + 50, 0, 1, '大工'); set(a + 50, 2, 3, 4); set(a + 50, 4, 5, 5);
    set(a + 50, 6, 8, '挖土機'); set(a + 50, 9, 11, 1);
    set(a + 51, 0, 1, '小工'); set(a + 51, 4, 5, 4);       // 本日人數留白,只有累計
    set(a + 53, 0, 17, '四、本日施工項目是否有須依「營造業專業工程特定施工項目應置之技術士…');
  };

  // 第 1 天:本日=累計(實做金額同時符合兩種算式,單獨看這天分不出語意)
  block(1, 46212, '晴', [
    ['工程告示牌與職安告示牌(租用)', '式', 1, 1, 1, 6000, 6000, 6000],
    ['移除清運大王椰子樹(含挖樹頭，混凝土打底)', '棵', 9, null, 0, 21000, 189000, 0],
  ], 19316, '測試工程');
  // 第 2 天:本日留白、累計 1 而實做金額仍是 6000 —— 只有累計解釋得通。
  // 「下午：」留白,右邊還有「填報日期：」,不可被撈成天氣。
  // 工程名稱那格是數值 0(這家第 3 天起都這樣),不可讀成字串 "0"。
  block(70, 46213, null, [
    ['工程告示牌與職安告示牌(租用)', '式', 1, null, 1, 6000, 6000, 6000],
    ['移除清運大王椰子樹(含挖樹頭，混凝土打底)', '棵', 9, null, null, 21000, 189000, null],
  ], 208316, 0);

  const starts = blockStarts(g);
  if (starts.length !== 2) return false;
  const out = dedupe(starts.map((s, i) => parseDay(g, s,
    i + 1 < starts.length ? starts[i + 1] : g.length, ft && ft.excelSerialToISO)));
  if (out.length !== 2) return false;
  const [d1, d2] = out;
  if (d1.header.工程名稱 !== '測試工程') return false;
  if (d2.header.工程名稱 !== null) return false;             // 數值 0 = 沒填,不是名稱「0」
  if (d1.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (ft && ft.excelSerialToISO) {
    if (d1.header.填報日期 !== '2026-07-09' || d2.header.填報日期 !== '2026-07-10') return false;
    if (d1.header.開工日期 !== '2026-07-09') return false;
  }
  if (d1.header.天氣_上午 !== '晴' || d1.header.天氣_下午 !== '晴') return false;
  // 「下午：」留白 → null,不可撈到右邊的「填報日期：」
  if (d2.header.天氣_下午 !== null) return false;
  if (d1.header.預定進度 !== 0.0002) return false;
  if (d1.header.實際進度 !== 0.0471701232035179) return false;
  if (d1.header.出工總人數 !== 4) return false;              // 累計 5 與只有累計的那列不可混進來
  if (d1.extras.出工明細.length !== 1 || d1.extras.主要機具.length !== 1) return false;
  if (d1.extras.主要材料) return false;                       // 材料表全空
  // 合計列取的是實做金額,不是它下面那列的進度值
  if (d1.header.本日累計金額 !== 19316 || d2.header.本日累計金額 !== 208316) return false;
  if (d1.dailyRows.length !== 2 || d2.dailyRows.length !== 2) return false;
  const r1 = d1.dailyRows[0];
  if (r1.項次 !== '1' || r1.單位 !== '式' || r1.契約數量 !== 1) return false;
  if (r1.契約單價 !== 6000 || r1.本日完成數量 !== 1 || r1.累計完成數量 !== 1) return false;
  // 實做金額是累計金額,本日金額此格式沒有 —— 收成本日會讓每天的本日金額都變成累計
  if (r1.本日完成金額 !== null) return false;
  const r2 = d2.dailyRows[0];
  if (r2.本日完成數量 !== null || r2.累計完成數量 !== 1 || r2.本日完成金額 !== null) return false;
  // 第二列第 2 天整列留白:數量欄不可補 0
  if (d2.dailyRows[1].累計完成數量 !== null) return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '出工總人數', '本日累計金額', '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約單價', '契約數量', '本日完成數量', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parseDay, blockStarts, dedupe },
};
