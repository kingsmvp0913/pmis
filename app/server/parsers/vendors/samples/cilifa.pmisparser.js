/**
 * cilifa.pmisparser.js — 賜利發土木包工業施工日誌讀取器(元長國小老舊廁所整修)
 *
 * vendorKey 取自**決標公告的得標廠商**(`模板\決標公告\元長廁所決標公告.pdf`,
 * 工程編號 A1150505);日誌的「承攬廠商名稱」欄也寫同一個名稱,兩邊一致。
 *
 * ── 兩聯分在兩個分頁,各有一半的欄位,必須合併 ──
 * 活頁簿有三個分頁:`進度`(非日誌)、`施工日誌第一聯`、`施工日誌(第二聯)-全`。
 *   **第一聯**有天氣、累計預定/實際進度、承攬廠商、開工日期,但明細
 *     「僅填報實際施作項目」——當天沒做的不列(第 1 天只有 2 列)。
 *   **第二聯**才是完整明細(29 項 + 費用項貳~陸),而且**只有它有單價與金額**。
 * 只讀一聯的話,不是少了天氣與進度,就是少了單價與八成的明細。
 * 兩聯各自以「填報日期」為鍵配對(兩邊的日期都是同一個 Excel 序號)。
 *
 * ── 版面事實(實測 2 份 xls / 21 天 / 693 明細列)──
 * 第二聯一天一個 46 列的區塊,錨點是欄 0 去空白後等於「公共工程施工日誌」。
 *   b+2  欄0=工程名稱：…  欄5=填報日期(Excel 序號)
 *   b+3  表頭:欄0=項次 欄1=工程項目 欄2=單位 欄3=契約數量 欄6=本日完成數量
 *        欄8=累計完成數量 欄10=備註
 *   b+4  次表頭:欄3=數量 **欄4=單價** 欄6=數量 欄7=金額 欄8=數量 欄9=金額
 *   b+5  大類「壹 直接工程費」(沒有單位)
 *   b+38 「發包工程費合計(壹~陸)」欄7=本日合計 欄9=**累計合計** 欄11=契約金額
 * 第一聯是「表報編號：」那族的標準表單,一天 47 列。
 *
 * ── 金額欄的語意(用算式核對過)──
 * 693 列裡 693 列同時滿足「欄7 = 欄6 × 單價」與「欄9 = 欄8 × 單價」,
 * 即欄 7 是**本日**金額、欄 9 是**累計**金額,兩欄各自對著自己那組數量。
 * header.本日累計金額 取合計列的欄 9(累計合計),不是欄 7。
 *
 * ── 進度取「累計」那一組 ──
 * 第一聯同時有「累計預定進度(%)」與「累計實際進度(%)」,存的是分數
 * (0.0083 = 0.83%),保留原值不換算。
 */

const META_VENDOR_KEY = '賜利發土木包工業';

const SHEET2 = /第二聯/;
const SHEET1 = /第一聯/;
const ANCHOR2 = '公共工程施工日誌';
const ANCHOR1 = '表報編號:';
// 單位一律白名單(禁樣式判定:名稱裡的 RC/PVC 會被當成單位)
const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'kg', '噸', 'T',
  '公尺', '公斤', '平方公尺', '立方公尺', '場', '座', '組', '支', '個', '只', '片',
  '面', '處', '間', '棵', '株', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '才', '天', '日', '人']);
// Excel 日期序號下限(30000 = 1982 年)。同一列還有表報編號、工期天數這些小數字。
const MIN_DATE_SERIAL = 30000;

const nfkc = (v) => String(v == null ? '' : v).normalize('NFKC');
const despace = (v) => nfkc(v).replace(/[\s　]/g, '');

function text(v) {
  const s = nfkc(v).replace(/[\r\n]+/g, '').trim();
  return s === '' || s === '-' || s === '－' ? null : s;
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

/** 民國年月日「115年7月11日」→ 西元 ISO。 */
function rocDate(v) {
  const m = despace(v).match(/^(\d{2,3})年(\d{1,2})月(\d{1,2})日$/);
  if (!m) return null;
  return `${Number(m[1]) + 1911}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
}

const at = (grid, r, c) => (grid && grid[r] ? grid[r][c] : undefined);

function colOf(row, label) {
  for (let c = 0; c < (row || []).length; c++) if (despace(row[c]) === label) return c;
  return -1;
}

/** 取 label 右邊第一個「與 label 不同」的值(標籤自己會因合併填充佔好幾欄)。 */
function valueAfter(row, label) {
  const c = colOf(row, label);
  if (c < 0) return null;
  const lab = despace(row[c]);
  for (let i = c + 1; i < (row || []).length; i++) {
    if (despace(row[i]) === lab) continue;
    if (row[i] == null || String(row[i]).trim() === '') continue;
    return row[i];
  }
  return null;
}

/** 該列第一個「大到不可能是編號」的數字 = Excel 日期序號(見 MIN_DATE_SERIAL)。 */
function dateSerial(row) {
  for (const v of row || []) {
    const n = num(v);
    if (n != null && n >= MIN_DATE_SERIAL) return n;
  }
  return null;
}

function blockStarts(grid, anchor) {
  const out = [];
  for (let r = 0; r < (grid || []).length; r++) if (despace(at(grid, r, 0)) === anchor) out.push(r);
  return out;
}

/** 第二聯的一天:完整明細 + 單價 + 兩組金額。 */
function parseSecond(grid, a, end, serialToISO) {
  const rowWith = (re) => {
    for (let r = a; r < end; r++) if (re.test(despace(at(grid, r, 0)))) return r;
    return -1;
  };
  const hr = rowWith(/^項次$/);
  if (hr < 0) throw new Error('第二聯找不到明細表頭(此檔非賜利發格式?)');
  const hdr = grid[hr];
  const sub = grid[hr + 1] || [];
  const c單位 = colOf(hdr, '單位');
  const c本日 = colOf(hdr, '本日完成數量');
  const c累計 = colOf(hdr, '累計完成數量');
  // 單價在**次表頭**那一列(欄3=數量 欄4=單價),不在主表頭
  const c單價 = colOf(sub, '單價');
  const c契約 = colOf(hdr, '契約數量');
  if ([c單位, c本日, c累計, c單價, c契約].some((c) => c < 0)) {
    throw new Error('第二聯的欄位找不到(此檔非賜利發格式?)');
  }

  let 日期 = null;
  for (let r = a; r < hr; r++) {
    const s = dateSerial(grid[r]);
    if (s != null) { 日期 = serialToISO ? serialToISO(s) : null; break; }
  }

  const dailyRows = [];
  let 本日累計金額 = null;
  for (let r = hr + 2; r < end; r++) {
    const name = text(at(grid, r, 1));
    if (name == null) continue;
    if (/^發包工程費合計/.test(despace(name))) {
      // 合計列:欄9 是累計合計(欄7 是本日合計,填錯這格 SP3 的 B4 天天不符)
      本日累計金額 = num(at(grid, r, c累計 + 1));
      continue;
    }
    // 單位為空的是大類(壹 直接工程費)與「小計(壹)」那類彙總列
    const 單位 = unitOf(at(grid, r, c單位));
    if (單位 == null) continue;
    dailyRows.push({
      項次: text(at(grid, r, 0)),
      工程項目: name,
      單位,
      契約單價: num(at(grid, r, c單價)),
      契約數量: num(at(grid, r, c契約)),
      本日完成數量: num(at(grid, r, c本日)),
      本日完成金額: num(at(grid, r, c本日 + 1)),
      累計完成數量: num(at(grid, r, c累計)),
    });
  }
  return { 日期, dailyRows, 本日累計金額 };
}

/** 第一聯的一天:天氣、進度、廠商、開工日期(明細不完整,不取)。 */
function parseFirst(grid, a, end, serialToISO) {
  const rowWith = (re) => {
    for (let r = a; r < end; r++) if (re.test(despace(at(grid, r, 0)))) return r;
    return -1;
  };
  const wr = rowWith(/^本日天氣/);
  const nr = rowWith(/^工程名稱$/);
  const sr = rowWith(/^開工日期$/);
  const pr = rowWith(/^累計預定進度/);
  const wt = wr < 0 ? '' : (grid[wr] || []).map((v) => nfkc(v)).join(' ');
  const am = wt.match(/上午[:：]\s*(\S+?)(?=\s|下午|$)/);
  const pm = wt.match(/下午[:：]\s*(\S+?)(?=\s|$)/);
  const s = wr < 0 ? null : dateSerial(grid[wr]);
  return {
    日期: s != null && serialToISO ? serialToISO(s) : null,
    工程名稱: nr < 0 ? null : text(valueAfter(grid[nr], '工程名稱')),
    承包廠商: nr < 0 ? null : text(valueAfter(grid[nr], '承攬廠商名稱')),
    開工日期: sr < 0 ? null : rocDate(valueAfter(grid[sr], '開工日期')),
    天氣_上午: am ? text(am[1]) : null,
    天氣_下午: pm ? text(pm[1]) : null,
    預定進度: pr < 0 ? null : num(valueAfter(grid[pr], '累計預定進度(%)')),
    實際進度: pr < 0 ? null : num(valueAfter(grid[pr], '累計實際進度(%)')),
  };
}

/**
 * 兩聯合併成逐日結構(純函式;selfTest 重用之)。
 * @param {Array<Array>} g2 第二聯分頁
 * @param {Array<Array>} g1 第一聯分頁(可為 null)
 */
function mergeSheets(g2, g1, serialToISO) {
  const seconds = [];
  const s2 = blockStarts(g2, ANCHOR2);
  for (let i = 0; i < s2.length; i++) {
    seconds.push(parseSecond(g2, s2[i], i + 1 < s2.length ? s2[i + 1] : g2.length, serialToISO));
  }
  const firsts = new Map();
  if (g1) {
    const s1 = blockStarts(g1, ANCHOR1);
    for (let i = 0; i < s1.length; i++) {
      const f = parseFirst(g1, s1[i], i + 1 < s1.length ? s1[i + 1] : g1.length, serialToISO);
      if (f.日期 && !firsts.has(f.日期)) firsts.set(f.日期, f);
    }
  }
  return seconds.map((d) => {
    const f = (d.日期 && firsts.get(d.日期)) || {};
    return {
      header: {
        工程名稱: f.工程名稱 || null,
        填報日期: d.日期,
        星期: null,                                     // 此格式不提供
        天氣_上午: f.天氣_上午 || null,
        天氣_下午: f.天氣_下午 || null,
        預定進度: f.預定進度 == null ? null : f.預定進度,
        實際進度: f.實際進度 == null ? null : f.實際進度,
        出工總人數: null,                                // 第一聯有出工表,但明細不完整,不取
        本日累計金額: d.本日累計金額,
        承包廠商: f.承包廠商 || null,
        開工日期: f.開工日期 || null,
      },
      dailyRows: d.dailyRows,
      extras: {},
    };
  });
}

/** 依填報日期去重(保留有本日完成量的列較多的那一份),並照時序輸出。 */
function dedupe(days) {
  const byDate = new Map();
  const noDate = [];
  const score = (x) => x.dailyRows.filter((r) => r.本日完成數量 != null).length;
  for (const d of days) {
    const k = d.header.填報日期;
    if (!k) { noDate.push(d); continue; }
    const prev = byDate.get(k);
    if (!prev || score(prev) < score(d)) byDate.set(k, d);
  }
  const out = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, d]) => d);
  return out.concat(noDate);
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.readWorkbook !== 'function') throw new Error('缺少注入的 filetypes.readWorkbook');
  const wb = ft.readWorkbook(filePath);
  const sheets = (wb && wb.sheets) || {};
  const n2 = Object.keys(sheets).find((n) => SHEET2.test(n));
  const n1 = Object.keys(sheets).find((n) => SHEET1.test(n));
  // 回空陣列會被上游當成「這份沒有資料」而靜靜略過
  if (!n2) throw new Error('找不到「第二聯」分頁(此檔非賜利發日誌,或是無文字層的掃描件)');
  const days = mergeSheets(sheets[n2], n1 ? sheets[n1] : null, ft.excelSerialToISO);
  if (!days.length) throw new Error('第二聯裡找不到「公共工程施工日誌」區塊');
  // 「還沒填的天」濾掉:沒有日期**且**沒有明細
  const filled = days.filter((d) => d.header.填報日期 != null || d.dailyRows.length > 0);
  if (!filled.some((d) => d.header.填報日期 != null)) {
    throw new Error('每一天都讀不到填報日期(此檔錨點雖然對上,版面不是賜利發的)');
  }
  return dedupe(filled);
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest 用**真實儲存格**造兩天(取自 `7月公共工程施工日誌-元長國小廁所(修.xls`,
 * 只換工程名稱)。斷言各對著一個坑:單價在次表頭不在主表頭、合計取累計那一欄、
 * 兩聯要靠日期配對(第一聯的順序不保證與第二聯相同)。
 */
function selfTest(ft) {
  const mk = () => [];
  const setter = (g) => (r, from, to, v) => { g[r] = g[r] || []; for (let c = from; c <= to; c++) g[r][c] = v; };

  const g2 = mk();
  const s2 = setter(g2);
  const block2 = (a, serial, items, 本日合計, 累計合計) => {
    s2(a, 0, 10, '公 共 工 程 施 工 日 誌');
    s2(a + 1, 0, 10, '第二聯');
    s2(a + 2, 0, 4, '工程名稱：測試工程'); s2(a + 2, 5, 6, serial);
    s2(a + 3, 0, 0, '項次'); s2(a + 3, 1, 1, '工程項目'); s2(a + 3, 2, 2, '單位');
    s2(a + 3, 3, 5, '契約數量'); s2(a + 3, 6, 7, '本日完成數量');
    s2(a + 3, 8, 9, '累計完成數量'); s2(a + 3, 10, 10, '備註');
    s2(a + 4, 3, 3, '數量'); s2(a + 4, 4, 4, '單價');
    s2(a + 4, 6, 6, '數量'); s2(a + 4, 7, 7, '金額');
    s2(a + 4, 8, 8, '數量'); s2(a + 4, 9, 9, '金額');
    s2(a + 5, 0, 0, '壹'); s2(a + 5, 1, 1, '直接工程費');   // 大類:沒有單位,不可變成明細
    items.forEach((it, i) => {
      const r = a + 6 + i;
      s2(r, 0, 0, it[0]); s2(r, 1, 1, it[1]); s2(r, 2, 2, it[2]); s2(r, 3, 3, it[3]);
      s2(r, 4, 4, it[4]);
      if (it[5] != null) s2(r, 6, 6, it[5]);
      if (it[6] != null) s2(r, 7, 7, it[6]);
      if (it[7] != null) s2(r, 8, 8, it[7]);
      if (it[8] != null) s2(r, 9, 9, it[8]);
    });
    s2(a + 36, 1, 1, '小計(壹)'); s2(a + 36, 7, 7, 本日合計); s2(a + 36, 9, 9, 累計合計);
    s2(a + 38, 1, 1, '發包工程費合計(壹~陸)');
    s2(a + 38, 7, 7, 本日合計); s2(a + 38, 9, 9, 累計合計); s2(a + 38, 11, 11, 1091313);
  };
  block2(0, 46214, [
    ['1', '乙種施工圍籬、警示帶、安全警示燈等安全措施(租用)', '式', 1, 8500, 1, 8500, 1, 8500],
    ['2', '工程告示牌與職安衛告示牌(租用)', '式', 1, 6000, 0, null, null, null],
    ['貳', '職業安全衛生管理費(壹*1%)', '式', 1, 9406, 0.008, 75, 0.008, 75],
  ], 9706, 9706);
  block2(46, 46215, [
    ['1', '乙種施工圍籬、警示帶、安全警示燈等安全措施(租用)', '式', 1, 8500, null, null, 1, 8500],
  ], 0, 9706);

  const g1 = mk();
  const s1 = setter(g1);
  // 第一聯刻意**倒序**排(先 7/12 再 7/11):兩聯只能靠日期配對,不能靠順序
  const block1 = (a, serial, 上午, 下午, 預定, 實際) => {
    s1(a, 0, 12, '公共工程施工日誌');
    s1(a + 1, 0, 0, '表報編號：'); s1(a + 1, 1, 1, 1);
    s1(a + 2, 0, 0, '本日天氣：'); s1(a + 2, 1, 1, '上午：'); s1(a + 2, 2, 2, 上午);
    s1(a + 2, 3, 4, `下午： ${下午}`); s1(a + 2, 5, 6, '填表日期：'); s1(a + 2, 7, 9, serial);
    s1(a + 3, 0, 2, '工程名稱'); s1(a + 3, 3, 6, '測試工程');
    s1(a + 3, 7, 9, '承攬廠商名稱'); s1(a + 3, 10, 12, META_VENDOR_KEY);
    s1(a + 5, 0, 2, '開工日期'); s1(a + 5, 3, 6, '115年7月11日');
    s1(a + 6, 0, 2, '累計預定進度(%)'); s1(a + 6, 3, 6, 預定);
    s1(a + 6, 7, 9, '累計實際進度(%)'); s1(a + 6, 10, 12, 實際);
  };
  block1(0, 46215, '陰', '雨', 0.0166, 0.0088938);
  block1(47, 46214, '晴', '晴', 0.0083, 0.008893873709925566);

  const days = dedupe(mergeSheets(g2, g1, ft && ft.excelSerialToISO));
  if (days.length !== 2) return false;
  const [d1, d2] = days;
  if (ft && ft.excelSerialToISO) {
    if (d1.header.填報日期 !== '2026-07-11' || d2.header.填報日期 !== '2026-07-12') return false;
    // 兩聯靠日期配對:第一聯是倒序的,靠順序配會把兩天的天氣對調
    if (d1.header.天氣_上午 !== '晴' || d1.header.天氣_下午 !== '晴') return false;
    if (d2.header.天氣_上午 !== '陰' || d2.header.天氣_下午 !== '雨') return false;
    if (d1.header.預定進度 !== 0.0083) return false;
    if (d1.header.開工日期 !== '2026-07-11') return false;
  }
  if (d1.header.工程名稱 !== '測試工程') return false;
  if (d1.header.承包廠商 !== META_VENDOR_KEY) return false;
  // 合計列取的是累計那一欄(欄9),不是本日(欄7):第 2 天本日合計是 0、累計仍是 9706
  if (d1.header.本日累計金額 !== 9706 || d2.header.本日累計金額 !== 9706) return false;
  // 大類「壹 直接工程費」與「小計(壹)」不可變成明細
  if (d1.dailyRows.length !== 3) return false;
  const [r1, r2, r3] = d1.dailyRows;
  // 單價在**次表頭**那一列(欄4),抓主表頭會拿到契約數量欄
  if (r1.契約單價 !== 8500 || r1.契約數量 !== 1 || r1.單位 !== '式') return false;
  if (r1.本日完成數量 !== 1 || r1.本日完成金額 !== 8500 || r1.累計完成數量 !== 1) return false;
  // 沒填的金額不可補 0
  if (r2.本日完成數量 !== 0 || r2.本日完成金額 !== null || r2.累計完成數量 !== null) return false;
  if (r3.項次 !== '貳' || r3.本日完成金額 !== 75) return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '本日累計金額', '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約單價', '契約數量',
      '本日完成數量', '本日完成金額', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { mergeSheets, parseSecond, parseFirst, blockStarts, dedupe },
};
