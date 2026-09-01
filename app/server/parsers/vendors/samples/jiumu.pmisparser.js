/**
 * jiumu.pmisparser.js — 久木營造施工日誌讀取器(林內國中 PU 跑道整修)
 *
 * vendorKey 取自**決標公告的得標廠商**(林內案:久木營造有限公司);
 * 日誌 r4 欄16 的承攬廠商名稱與之一字不差,可互為佐證。
 *
 * ── 版面事實(實測 6 份 .xls / 551 個分頁)──
 * 工程會版表單,**一天一個分頁**,分頁名 `月(日)`(如 `6(30)`、`10(1)`),
 * 且在檔案裡是**倒序**排列(6(30) 在最前),故輸出前依填報日期重排。
 * 每個分頁上下兩聯,座標一致(A1:Z88):
 *   第一聯「公共工程施工日誌」r1–r48 — header、材料、出工/機具
 *   第二聯「施工日報統計表」  r49–r86 — 逐項明細(八欄俱全)
 *
 * ── 四個非照著標籤讀就會錯的地方 ──
 * ① **第二聯的「本日完成金額」(欄17)與「累計完成金額」(欄18)在資料列是同一個合併格**。
 *    表頭是兩格,資料列只有一個值——照表頭去讀欄18 會拿到本日金額的複本。
 *    那個值到底是哪一種,用算式在整份 10 月檔(4104 列)上統計過:
 *    符合「本日數量 × 單價」2996 列、符合「累計數量 × 單價」0 列、兩者皆符 1013 列。
 *    **是本日金額**,故累計完成金額一律不收(schema 也無此欄)。
 * ② **r82 標「累計(本日完成金額合計)」的其實是當天的本日金額合計**
 *    (6/1 實測 89+0.89+1.424+6.23+0.267+4.8906 = 102.70,與該格一致)。
 *    收進 header.本日累計金額 會讓 SP3 的 B4(對各項**累計**金額總和)每天硬錯 → null。
 *    同理 r83 標著「累計完成進度」的值是「本日金額 ÷ 契約金額」,也不是累計進度;
 *    累計進度在第一聯 r7(累積預定/實際進度)。
 * ③ **第一聯 r10–r15 只列「當天有施作」的項目**(最多 6 列),是摘要不是資料來源;
 *    逐項明細要取第二聯,否則每天只讀得到 0–3 列。
 * ④ **出工/機具三個區塊的表頭全寫「工別 / 本日人數 / 累計人數」**,但實測 551 個分頁裡
 *    第一區塊只出現組工/技術工(人),第二區塊只出現挖土機/鏟土機(機具),
 *    第三區塊只有一格「其他」而且從來沒有數值。故**依區塊位置**分人/機具,
 *    不照標籤;第三區塊不收。
 *
 * ── 找不到就 null,不編造 ──
 *   星期:版面無此欄 → null。
 *   本日累計金額:見②。
 *   契約總價(欄12)、累計完成金額(欄18):schema 無對應欄位,不收。
 *
 * ── 座標全部以錨點動態定位 ──
 * 列號雖然 551 個分頁一致,仍以「本日天氣」「工程名稱」「第二聯」「項次」「工別」
 * 「材料名稱」等標籤定位,欄索引由**表頭列實測**取得(skill 的 Excel 坑③)。
 */

const META_VENDOR_KEY = '久木營造有限公司';

// 單位白名單。樣式判定(如 /^[A-Z]+\d*$/)會把 RC/PVC 這類工程縮寫當成單位,
// 導致名稱被截斷而且不會有任何欄位變 null(skill 的金大教訓)。
const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'm', 'm2', 'm3', 'CM', 'MM', 'KG', 'kg',
  '噸', 'T', '面', '座', '組', '場', '棵', '株', '處', '個', '支', '片', '只', '間',
  '天', '日', '趟', '才', '公尺', '公斤', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '張', '盞', '針', '本', '式/月', '月', '頂', '雙']);

const text = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s === '' || s === '-' || s === '－' ? null : s;
};

/** 去掉所有空白後的字串(表頭「工 程 項 目」逐字散開,比對前要壓掉)。 */
const squash = (v) => (v == null ? '' : String(v).replace(/[\s　]/g, ''));

/** 數值。無資料標記(`-`/`－`/空白)一律 null——語意是「無資料」而非 0。 */
function numOf(v) {
  const s = v == null ? '' : String(v).replace(/[,\s　]/g, '');
  if (s === '' || s === '-' || s === '－') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function unitOf(v) {
  const s = text(v);
  if (s == null) return null;
  const n = String(s).normalize('NFKC').trim();
  return KNOWN_UNITS.has(n) ? n : null;
}

const at = (grid, r, c) => {
  const row = grid[r];
  if (!row) return null;
  const v = row[c];
  return v === undefined ? null : v;
};

/** 開工/完工日期是「114 年 05 月 14日」這種夾雜空白的民國字串。 */
function rocTextToISO(v) {
  const s = squash(v);
  const m = /(\d{2,4})年(\d{1,2})月(\d{1,2})日/.exec(s);
  if (!m) return null;
  let y = Number(m[1]);
  if (y < 1911) y += 1911;
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(Number(m[2]))}-${p(Number(m[3]))}`;
}

/** 找出第一個「壓掉空白後含 keyword」的列(限第 0 欄)。找不到回 -1。 */
function rowOf(grid, keyword, from = 0) {
  for (let r = from; r < grid.length; r++) {
    if (squash(at(grid, r, 0)).includes(keyword)) return r;
  }
  return -1;
}

/** 同一列上,標籤 keyword 所在欄之後的第一個非空值(跳過同值的合併區)。 */
function valueAfterLabel(grid, r, keyword, stopKeyword) {
  const row = grid[r] || [];
  let start = -1;
  for (let c = 0; c < row.length; c++) {
    if (squash(row[c]).includes(keyword)) { start = c; break; }
  }
  if (start < 0) return null;
  const label = squash(row[start]);
  for (let c = start + 1; c < row.length; c++) {
    const s = squash(row[c]);
    if (s === '' || s === label) continue;            // 合併區內的同值複本
    if (stopKeyword && s.includes(stopKeyword)) return null;  // 已跨到下一個欄位
    return row[c];
  }
  return null;
}

// ── 第二聯明細 ───────────────────────────────────────────
// 表頭標籤 → 內部欄名。欄索引由表頭列實測,不寫死。
const ITEM_HEADERS = [
  ['項次', '項次'], ['工程項目', '工程項目'], ['單位', '單位'],
  ['契約數量', '契約數量'], ['契約單價', '契約單價'],
  ['本日完成數量', '本日完成數量'], ['累計完成數量', '累計完成數量'],
  ['本日完成金額', '本日完成金額'],
];

/**
 * 從第二聯表頭列取各欄索引。
 * 用**完全相等**比對:「本日完成金額」與「累計完成金額」互為子字串,
 * 用 includes 會把兩者對到同一欄。
 */
function itemColumns(grid, headerRow) {
  const row = grid[headerRow] || [];
  const cols = {};
  for (let c = 0; c < row.length; c++) {
    const s = squash(row[c]);
    for (const [label, key] of ITEM_HEADERS) {
      if (s === label && cols[key] === undefined) cols[key] = c;
    }
  }
  return cols;
}

/** 第二聯逐項明細。止於合計列(欄1「累計(本日完成金額合計)」)或項次與名稱皆空。 */
function parseItemRows(grid, headerRow, cols) {
  const out = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    const rawId = at(grid, r, cols.項次);
    const name = text(at(grid, r, cols.工程項目));
    const id = text(rawId);
    if (name && squash(name).startsWith('累計(')) break;    // 合計列
    if (!id && !name) break;
    out.push({
      項次: id,
      工程項目: name,
      單位: unitOf(at(grid, r, cols.單位)),
      契約單價: numOf(at(grid, r, cols.契約單價)),
      契約數量: numOf(at(grid, r, cols.契約數量)),
      本日完成數量: numOf(at(grid, r, cols.本日完成數量)),
      // 欄17/18 在資料列是同一個合併格,值經整份統計確認是**本日**金額(見檔頭①)
      本日完成金額: numOf(at(grid, r, cols.本日完成金額)),
      累計完成數量: numOf(at(grid, r, cols.累計完成數量)),
    });
  }
  return out;
}

// ── 第一聯的出工/機具/材料 ────────────────────────────────
/**
 * 表頭列壓成分段:連續同值(合併儲存格被填滿後的複本)只留最左那一欄。
 * 不壓的話「材料名稱」合併 6 欄就會被當成 6 個獨立區塊,同一筆材料收 6 次。
 * @returns {Array<{label:string, col:number}>}
 */
function headerSegments(row) {
  const segs = [];
  let prev = null;
  for (let c = 0; c < (row || []).length; c++) {
    const s = squash(row[c]);
    if (s !== '' && s !== prev) segs.push({ label: s, col: c });
    prev = s;
  }
  return segs;
}

/** 段落標題(「三、工地人員…」)——第一聯各區塊的邊界。 */
const isSectionTitle = (v) => /^[一二三四五六七八九十]、/.test(squash(v));

/**
 * 以表頭分段切出「一個名稱欄 + 其右側到下一個同名區塊為止的數值欄」。
 * @param {Array} row 表頭列
 * @param {string} nameLabel 區塊起點標籤(「工別」/「材料名稱」)
 * @param {Object<string,string>} want 內部欄名 → 表頭標籤
 */
function labelledBlocks(row, nameLabel, want) {
  const segs = headerSegments(row);
  const blocks = [];
  segs.forEach((seg, i) => {
    if (seg.label !== nameLabel) return;
    const block = { 名稱: seg.col };
    for (let k = i + 1; k < segs.length; k++) {
      if (segs[k].label === nameLabel) break;          // 已進入下一個區塊
      for (const [key, label] of Object.entries(want)) {
        if (segs[k].label === label && block[key] === undefined) block[key] = segs[k].col;
      }
    }
    blocks.push(block);
  });
  return blocks;
}

function parseCrew(grid, headerRow) {
  const blocks = labelledBlocks(grid[headerRow] || [], '工別', { 本日: '本日人數' });
  const 出工明細 = []; const 主要機具 = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    if (isSectionTitle(at(grid, r, 0))) break;         // 出工區止於「四、…」
    blocks.forEach((b, i) => {
      const name = text(at(grid, r, b.名稱));
      if (!name || b.本日 === undefined) return;
      const n = numOf(at(grid, r, b.本日));
      // 依區塊位置分人/機具(表頭三組都寫「工別」,但實測 551 個分頁裡第二組只出現
      // 機具、第三組只有一格「其他」且從無數值)——見檔頭④
      if (i === 0) 出工明細.push({ 工別: name, 人數: n });
      else if (i === 1) 主要機具.push({ 名稱: name, 數量: n });
    });
  }
  return { 出工明細, 主要機具 };
}

function parseMaterials(grid, headerRow) {
  const blocks = labelledBlocks(grid[headerRow] || [], '材料名稱',
    { 單位: '單位', 本日: '本日使用數量' });
  const out = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    // 材料區止於下一個段落標題(「三、工地人員…」)。合併填充會讓每一列的第 0 欄
    // 都有值,靠「整列皆空」當結束條件會一路吃掉整個第一聯的敘述文字。
    if (isSectionTitle(at(grid, r, 0))) break;
    for (const b of blocks) {
      const 名稱 = text(at(grid, r, b.名稱));
      if (!名稱) continue;
      out.push({
        名稱,
        單位: b.單位 === undefined ? null : unitOf(at(grid, r, b.單位)),
        數量: b.本日 === undefined ? null : numOf(at(grid, r, b.本日)),
      });
    }
  }
  return out;
}

/**
 * 解析單一天的分頁 grid → { header, dailyRows, extras }。純函式,selfTest 重用。
 * @param {Array<Array<any>>} grid  ft.gridFromWorksheet 的產出(合併已填滿)
 * @param {(serial:number)=>string|null} serialToISO 由 ctx.filetypes 注入
 */
function parseSheet(grid, serialToISO) {
  const 天氣列 = rowOf(grid, '本日天氣');
  const 名稱列 = rowOf(grid, '工程名稱');
  const 開工列 = rowOf(grid, '開工日期');
  const 進度列 = rowOf(grid, '累積預定進度');
  const 第二聯列 = rowOf(grid, '第二聯');
  if (天氣列 < 0 || 第二聯列 < 0) {
    // 回空會被上游當成「這份沒有資料」靜靜略過,故 throw。
    throw new Error('分頁缺少「本日天氣/第二聯」錨點');
  }
  const 表頭列 = rowOf(grid, '項次', 第二聯列);
  if (表頭列 < 0) throw new Error('第二聯找不到「項次」表頭列');
  const cols = itemColumns(grid, 表頭列);
  for (const key of ['項次', '工程項目', '單位', '契約數量', '契約單價']) {
    if (cols[key] === undefined) throw new Error(`第二聯表頭缺少「${key}」欄`);
  }

  const 日期值 = valueAfterLabel(grid, 天氣列, '填報日期');
  const 序號 = numOf(日期值);
  const 填報日期 = 序號 != null && serialToISO ? serialToISO(序號)
    : rocTextToISO(日期值);

  // 天氣同一列:「本日天氣：上午：」在欄0(標籤與值分離),下午標籤在中段
  const row天氣 = grid[天氣列] || [];
  let 下午c = -1; let 日期c = -1;
  for (let c = 0; c < row天氣.length; c++) {
    const s = squash(row天氣[c]);
    if (下午c < 0 && s.includes('下午')) 下午c = c;
    if (日期c < 0 && s.includes('填報日期')) 日期c = c;
  }
  const 值介於 = (from, to) => {
    for (let c = from + 1; c < (to < 0 ? row天氣.length : to); c++) {
      const v = text(row天氣[c]);
      if (v != null && !squash(v).includes('：') && !squash(v).includes(':')) return v;
    }
    return null;
  };
  const 天氣_上午 = 值介於(0, 下午c);
  const 天氣_下午 = 下午c < 0 ? null : 值介於(下午c, 日期c);

  const 出工 = (() => {
    const 工別列 = rowOf(grid, '工別');
    return 工別列 < 0 ? { 出工明細: [], 主要機具: [] } : parseCrew(grid, 工別列);
  })();
  const 材料 = (() => {
    const 材料列 = rowOf(grid, '材料名稱');
    return 材料列 < 0 ? [] : parseMaterials(grid, 材料列);
  })();

  let 出工總人數 = null;
  const 有人數 = 出工.出工明細.filter((x) => x.人數 != null);
  if (有人數.length) 出工總人數 = 有人數.reduce((s, x) => s + x.人數, 0);

  const extras = {};
  if (出工.出工明細.length) extras.出工明細 = 出工.出工明細;
  if (出工.主要機具.length) extras.主要機具 = 出工.主要機具;
  if (材料.length) extras.主要材料 = 材料;

  return {
    header: {
      工程名稱: 名稱列 < 0 ? null : text(valueAfterLabel(grid, 名稱列, '工程名稱', '承攬廠商')),
      填報日期,
      星期: null,                       // 此版面無星期欄
      天氣_上午,
      天氣_下午,
      // 累計進度取第一聯 r7;第二聯 r83 標著「累計完成進度」的其實是本日金額佔比(檔頭②)
      預定進度: 進度列 < 0 ? null : numOf(valueAfterLabel(grid, 進度列, '累積預定進度', '累積實際進度')),
      實際進度: 進度列 < 0 ? null : numOf(valueAfterLabel(grid, 進度列, '累積實際進度')),
      出工總人數,
      本日累計金額: null,               // r82 是本日金額合計,不是累計(檔頭②)
      承包廠商: 名稱列 < 0 ? null : text(valueAfterLabel(grid, 名稱列, '承攬廠商名稱')),
      開工日期: 開工列 < 0 ? null : rocTextToISO(valueAfterLabel(grid, 開工列, '開工日期', '完工日期')),
    },
    dailyRows: parseItemRows(grid, 表頭列, cols),
    extras,
  };
}

/** 日分頁 = 有「本日天氣」與「第二聯」兩個錨的分頁(封面/範本分頁自動排除)。 */
function daySheetNames(wb) {
  return wb.sheetNames.filter((n) => {
    const g = wb.sheets[n];
    return Array.isArray(g) && rowOf(g, '本日天氣') >= 0 && rowOf(g, '第二聯') >= 0;
  });
}

const PDF_ITEM_NO_RE = /^(\d+|[一二三四五六七八九十壹貳參参肆伍陸柒捌玖拾])$/;
const PDF_Y_TOL = 4;

function pdfGroupRows(items) {
  const buckets = [];
  for (const it of (items || []).filter((i) => String(i.s || '').trim())
    .slice().sort((a, b) => b.y - a.y)) {
    let bucket = buckets.find((b) => Math.abs(b.y - it.y) <= PDF_Y_TOL);
    if (!bucket) { bucket = { y: it.y, items: [] }; buckets.push(bucket); }
    bucket.items.push(it);
  }
  return buckets.map((b) => ({ y: b.y, items: b.items.sort((p, q) => p.x - q.x) }));
}

const pdfLine = (row) => row.items.map((i) => i.s).join(' ');
const pdfBetween = (row, from, to) => row.items
  .filter((i) => i.x >= from && i.x < to).map((i) => i.s).join(' ').trim();
const pdfUnit = (row) => {
  for (const item of row.items.filter((i) => i.x >= 230 && i.x < 256)) {
    const unit = unitOf(item.s);
    if (unit) return unit;
  }
  return null;
};
const pdfFirstNum = (v) => {
  const m = String(v || '').match(/-?\d{1,3}(?:,\d{3})*(?:\.\d+)?/);
  return m ? numOf(m[0]) : null;
};

function westernTextToISO(v) {
  const m = /(\d{4})[年\/]\s*(\d{1,2})[月\/]\s*(\d{1,2})/.exec(squash(v));
  if (!m) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${m[1]}-${p(Number(m[2]))}-${p(Number(m[3]))}`;
}

function parsePdfHeader(rows) {
  const lines = rows.map(pdfLine);
  const all = lines.join('\n');
  const find = (re) => { const m = re.exec(all); return m ? m[1] : null; };
  const noSpaces = (v) => (v == null ? null : squash(v));
  const weather = lines.find((line) => /本日天氣/.test(line)) || '';
  const wm = /上午[:：]?\s*(\S+).*?下午[:：]?\s*(\S+?)(?:\s+填報日期|$)/.exec(weather) || [];
  return {
    工程名稱: noSpaces(find(/工程名稱\s+(.+?)\s+承攬廠商名稱/)),
    填報日期: westernTextToISO(find(/填報日期[:：]?\s*([^\n]+)/)),
    星期: find(/(星期[一二三四五六日天])/),
    天氣_上午: text(wm[1]),
    天氣_下午: text(wm[2]),
    預定進度: pdfFirstNum(find(/累積預定進度\(%\)\s+([\d.]+)%?/)),
    實際進度: pdfFirstNum(find(/累積實際進度\(%\)\s+([\d.]+)%?/)),
    出工總人數: null,
    本日累計金額: null,
    承包廠商: noSpaces(find(/承攬廠商名稱\s+([^\n]+)/)),
    開工日期: rocTextToISO(find(/開工日期\s+(.+?)\s+完工日期/)),
  };
}

function parsePdfItemRows(rows) {
  const header = rows.find((row) => {
    const s = squash(pdfLine(row));
    return s.includes('項次') && s.includes('工程項目') && s.includes('單位');
  });
  if (!header) return [];
  const unitHeader = header.items.find((item) => squash(item.s) === '單位');
  const dx = unitHeader ? unitHeader.x - 231.6 : 0;
  const nameFrom = 65 + dx;
  const nameTo = 231 + dx;
  const unitFrom = 230 + dx;
  const footer = rows.find((row) => squash(pdfLine(row)).includes('累計(本日完成金額合計)'));
  const lower = footer ? footer.y : -Infinity;
  const anchors = [];
  const fragments = [];
  for (const row of rows) {
    if (row.y >= header.y || row.y <= lower) continue;
    const item = row.items.find((i) => i.x < 78 && PDF_ITEM_NO_RE.test(String(i.s || '').trim()));
    for (const i of row.items) {
      if (i.x >= nameFrom && i.x < nameTo) {
        const value = text(i.s);
        if (value) fragments.push({ y: i.y, value });
      }
    }
    if (!item) continue;
    anchors.push({
      y: row.y,
      項次: String(item.s).trim(),
      fragments: [],
      valueItems: [],
    });
  }
  if (!anchors.length) return [];
  for (const row of rows) {
    if (row.y >= header.y || row.y <= lower || !row.items.some((item) => item.x >= unitFrom)) continue;
    let nearest = anchors[0];
    for (const anchor of anchors) {
      if (Math.abs(anchor.y - row.y) < Math.abs(nearest.y - row.y)) nearest = anchor;
    }
    nearest.valueItems.push(...row.items);
  }
  const assigned = new Set();
  const hasAnchorBetween = (anchor, fragment) => anchors.some((other) => other !== anchor
    && (other.y - anchor.y) * (other.y - fragment.y) < 0);
  for (const anchor of anchors) {
    for (const fragment of fragments) {
      if (assigned.has(fragment) || Math.abs(fragment.y - anchor.y) > PDF_Y_TOL) continue;
      assigned.add(fragment);
      anchor.fragments.push(fragment);
    }
  }
  const priority = anchors.slice().sort((a, b) => Number(b.fragments.length === 0) - Number(a.fragments.length === 0));
  const finished = new Set();
  for (let pair = 1; pair <= 4; pair++) {
    for (const anchor of priority) {
      if (finished.has(anchor)) continue;
      const free = fragments.filter((fragment) => !assigned.has(fragment) && !hasAnchorBetween(anchor, fragment));
      const above = free.filter((fragment) => fragment.y > anchor.y).sort((a, b) => a.y - b.y)[0];
      const below = free.filter((fragment) => fragment.y < anchor.y).sort((a, b) => b.y - a.y)[0];
      if (!above || !below || Math.abs((above.y - anchor.y) - (anchor.y - below.y)) > 6) {
        finished.add(anchor);
        continue;
      }
      assigned.add(above); assigned.add(below);
      anchor.fragments.push(above, below);
    }
  }
  for (const fragment of fragments) {
    if (assigned.has(fragment)) continue;
    let nearest = anchors[0];
    for (const anchor of anchors) {
      if (Math.abs(anchor.y - fragment.y) < Math.abs(nearest.y - fragment.y)) nearest = anchor;
    }
    nearest.fragments.push(fragment);
  }
  return anchors.map((anchor) => {
    const valueRow = { items: anchor.valueItems };
    return {
      項次: anchor.項次,
      工程項目: anchor.fragments.sort((a, b) => b.y - a.y).map((f) => f.value).join('') || null,
      單位: pdfUnit({ items: anchor.valueItems.map((item) => ({ ...item, x: item.x - dx })) }),
      契約單價: pdfFirstNum(pdfBetween(valueRow, 290 + dx, 333 + dx)),
      契約數量: pdfFirstNum(pdfBetween(valueRow, 250 + dx, 290 + dx)),
      本日完成數量: pdfFirstNum(pdfBetween(valueRow, 367 + dx, 406 + dx)),
      本日完成金額: pdfFirstNum(pdfBetween(valueRow, 434 + dx, 472 + dx)),
      累計完成數量: pdfFirstNum(pdfBetween(valueRow, 406 + dx, 434 + dx)),
    };
  });
}

async function parsePdfAll(filePath, ft) {
  if (typeof ft.extractItems !== 'function') throw new Error('缺少注入的 filetypes.extractItems');
  const pages = await ft.extractItems(filePath);
  const days = [];
  let current = null;
  const finishCurrent = () => {
    if (!current) return;
    const count = current._detailPages.length;
    const combined = current._detailPages.flatMap((pageRows, index) => {
      const offset = (count - index - 1) * 1000;
      return pageRows.map((row) => ({
        y: row.y + offset,
        items: row.items.map((item) => ({ ...item, y: item.y + offset })),
      }));
    });
    current.dailyRows = parsePdfItemRows(combined);
    delete current._detailPages;
  };
  for (const page of pages) {
    const rows = pdfGroupRows(page.items);
    const all = rows.map(pdfLine).join('\n');
    if (/本日天氣/.test(all) && /填報日期/.test(all) && /工程名稱/.test(all)) {
      finishCurrent();
      current = { header: parsePdfHeader(rows), dailyRows: [], extras: {}, _detailPages: [] };
      days.push(current);
    }
    const hasDetailHeader = rows.some((row) => {
      const s = squash(pdfLine(row));
      return s.includes('項次') && s.includes('工程項目') && s.includes('單位');
    });
    if (current && (hasDetailHeader || (current._detailPages.length && !/本日天氣/.test(all)))) {
      current._detailPages.push(rows);
    }
  }
  finishCurrent();
  if (!days.length) throw new Error('找不到任何 PDF 日誌頁');
  days.sort((a, b) => String(a.header.填報日期 || '').localeCompare(String(b.header.填報日期 || '')));
  return days;
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft) throw new Error('缺少注入的 filetypes');
  if (/\.pdf$/i.test(filePath)) return parsePdfAll(filePath, ft);
  if (typeof ft.readWorkbook !== 'function') throw new Error('缺少注入的 filetypes.readWorkbook');
  const wb = ft.readWorkbook(filePath);
  const names = daySheetNames(wb);
  if (!names.length) {
    throw new Error('找不到任何日分頁(此檔非久木格式,或是無文字層的掃描件)');
  }
  const days = names.map((n) => parseSheet(wb.sheets[n], ft.excelSerialToISO));
  // 分頁在檔案裡是倒序(6(30) 在最前),依填報日期重排成時序
  days.sort((a, b) => String(a.header.填報日期 || '').localeCompare(String(b.header.填報日期 || '')));
  return days;
}

async function parse(filePath, ctx) {
  const all = await parseAll(filePath, ctx);
  return all[0] || null;
}

// selfTest:內建 grid 小樣本,不需 ft、不 require 任何 node_modules
// (讀取器安裝在 data/vendor-parsers/,那裡沒有 node_modules)。
// 每條斷言都對著一個「錯了不會有欄位變 null」的坑。
function selfTest() {
  const g = [];
  const set = (r, c, v) => { (g[r] = g[r] || [])[c] = v; };
  const span = (r, from, to, v) => { for (let c = from; c <= to; c++) set(r, c, v); };

  span(1, 0, 20, '公共工程施工日誌');
  set(2, 0, '表報編號：'); set(2, 1, 33);
  set(3, 0, '本日天氣：上午：'); set(3, 6, '晴'); set(3, 7, '下午：'); set(3, 9, '陰');
  set(3, 13, '填報日期：'); span(3, 16, 17, 45823);
  span(4, 0, 1, '工程名稱'); span(4, 2, 12, '測試工程');
  span(4, 13, 15, '承攬廠商名稱'); span(4, 16, 20, '久木營造有限公司');
  span(6, 0, 7, '開工日期'); span(6, 8, 11, '114 年 05 月 14日');
  span(6, 12, 16, '完工日期'); span(6, 17, 20, '114年 10 月 10 日');
  span(7, 0, 7, '累積預定進度(%)'); span(7, 8, 11, 0.10221);
  span(7, 12, 16, '累積實際進度(%)'); span(7, 17, 20, 0.14858);
  set(7, 21, 0.09921);                       // 右外側殘留公式區,不可被當成進度
  // 第一聯 r9–r10 的「當天有施作」摘要:只有 2 欄數字,不是明細來源(檔頭③)
  span(9, 0, 8, '施工項目'); span(9, 9, 10, '單位'); span(9, 11, 12, '契約數量');
  span(10, 0, 8, '工程告示牌'); span(10, 9, 10, '式'); span(10, 11, 12, 1);
  // 材料
  set(17, 0, '材料名稱'); set(17, 6, '單位'); span(17, 7, 8, '本日使用數量'); span(17, 9, 10, '累計數量');
  set(17, 11, '材料名稱'); span(17, 13, 15, '單位'); span(17, 16, 17, '本日使用數量');
  span(18, 0, 5, '鋪設新品密級配AC'); set(18, 6, 'm2'); span(18, 9, 10, 0);
  // 段落標題是材料區的下界。合併填充後每一列的第 0 欄都有值,靠「整列皆空」
  // 當結束條件會把整個第一聯的敘述文字都收成材料。
  span(20, 0, 20, '三、工地人員及機具管理（含約定之出工人數及機具使用情形及數量）：');
  // 出工/機具:三組表頭都寫「工別」,第二組其實是機具(檔頭④)
  span(21, 0, 1, '工別'); set(21, 2, '本日人數'); span(21, 3, 7, '累計人數');
  span(21, 8, 9, '工別'); set(21, 10, '本日人數'); set(21, 11, '累計人數');
  span(21, 12, 13, '工別'); span(21, 14, 15, '本日人數'); span(21, 16, 17, '累計人數');
  span(22, 0, 1, '組工'); set(22, 2, 1); span(22, 3, 7, 45);
  span(22, 8, 9, '挖土機'); set(22, 10, 1); set(22, 11, 7);
  span(23, 0, 1, '技術工'); set(23, 2, 2); span(23, 3, 7, 24);
  span(23, 8, 9, '鏟土機'); set(23, 11, 1);           // 本日欄空 → null,不可當 0
  span(28, 12, 13, '其他');                            // 第三區塊只有名稱、從無數值
  span(29, 0, 20, '四、本日施工項目是否有須依');
  // 第二聯
  span(49, 0, 20, '久木營造有限公司');
  span(51, 0, 11, '第二聯');
  set(53, 0, '項次'); span(53, 1, 8, '工  程  項  目'); set(53, 9, '單位');
  set(53, 10, '契約數量'); set(53, 11, '契約單價'); set(53, 12, '契約總價');
  span(53, 13, 14, '本日完成數量'); span(53, 15, 16, '累計完成數量');
  set(53, 17, '本日完成金額'); set(53, 18, '累計完成金額'); span(53, 19, 20, '備註');
  set(54, 0, '壹'); span(54, 1, 8, '直接工程'); span(54, 15, 18, 0);   // 大類:無單位/單價
  set(55, 0, 1); span(55, 1, 8, '工程告示牌、職安衛告示牌與交通管制措施(租用)');
  set(55, 9, '式'); set(55, 10, 1); span(55, 11, 12, 14799);
  span(55, 13, 14, 0.006); span(55, 15, 16, 0.18); span(55, 17, 18, 89);
  set(56, 0, 6); span(56, 1, 8, '新設涵管銜接陰井'); set(56, 9, 'M');
  set(56, 10, 30); set(56, 11, 3800); set(56, 12, 114000);
  span(56, 13, 14, 2); span(56, 15, 16, 11); span(56, 17, 18, 7600);
  set(57, 0, 8); span(57, 1, 8, '新設RC水溝面(含排水孔)'); set(57, 9, 'M');
  set(57, 10, 199); set(57, 11, 1500); set(57, 12, 298500); span(57, 15, 18, 0);
  span(58, 1, 8, '累計(本日完成金額合計)'); set(58, 12, 8337398); span(58, 17, 18, 7689);
  span(59, 0, 11, '本日完成進度=(本日累計完成金額÷契約金額)%=');

  const day = parseSheet(g, (n) => (n === 45823 ? '2025-06-15' : null));
  const h = day.header;
  if (h.工程名稱 !== '測試工程') return false;
  if (h.承包廠商 !== META_VENDOR_KEY) return false;
  if (h.填報日期 !== '2025-06-15') return false;
  if (h.天氣_上午 !== '晴' || h.天氣_下午 !== '陰') return false;
  // 標籤與值分離、右外側還有殘留公式欄——抓錯欄不會變 null,只會變成別的數字
  if (h.預定進度 !== 0.10221 || h.實際進度 !== 0.14858) return false;
  if (h.開工日期 !== '2025-05-14') return false;      // 「114 年 05 月 14日」夾空白
  if (h.星期 !== null) return false;
  if (h.本日累計金額 !== null) return false;          // r82 是本日合計不是累計(檔頭②)
  if (h.出工總人數 !== 3) return false;               // 只算第一區塊(人),不含機具

  const rows = day.dailyRows;
  if (rows.length !== 4) return false;                // 合計列必須被切掉
  const [大類, r1, r6, r8] = rows;
  if (大類.項次 !== '壹' || 大類.單位 !== null || 大類.契約單價 !== null) return false;
  if (r1.項次 !== '1' || r1.單位 !== '式' || r1.契約單價 !== 14799) return false;
  // 欄17/18 是同一個合併格,收下來的必須是**本日**金額:0.006 × 14799 ≈ 89(檔頭①)
  if (r1.本日完成數量 !== 0.006 || r1.本日完成金額 !== 89) return false;
  if (r1.累計完成數量 !== 0.18) return false;
  if (r6.本日完成金額 !== 7600 || r6.本日完成金額 !== r6.本日完成數量 * r6.契約單價) return false;
  // 沒填本日量的列:本日數量 null(無資料)而非 0
  if (r8.本日完成數量 !== null || r8.本日完成金額 !== 0) return false;
  if (r8.工程項目 !== '新設RC水溝面(含排水孔)') return false;   // RC 不可被當成單位
  if (rows.some((x) => String(x.工程項目 || '').startsWith('累計('))) return false;

  const 機具 = day.extras.主要機具 || [];
  if (機具.length !== 2 || 機具[0].名稱 !== '挖土機' || 機具[0].數量 !== 1) return false;
  if (機具[1].數量 !== null) return false;            // 本日欄空 → null
  if ((day.extras.出工明細 || []).length !== 2) return false;   // 機具不可混進出工
  if (day.extras.出工明細[0].工別 !== '組工') return false;
  const 材料 = day.extras.主要材料 || [];
  if (材料.length !== 1 || 材料[0].單位 !== 'm2') return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.1.0',
    targetFields: [
      '工程名稱', '填報日期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '出工總人數', '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約單價', '契約數量',
      '本日完成數量', '本日完成金額', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: {
    parseSheet, parseItemRows, itemColumns, rocTextToISO, numOf, unitOf,
    pdfGroupRows, parsePdfHeader, parsePdfItemRows,
  },
};
