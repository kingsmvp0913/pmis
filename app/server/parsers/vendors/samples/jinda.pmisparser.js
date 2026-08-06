/**
 * jinda.pmisparser.js — 金大營造(竹崎高中)施工日誌 PDF 讀取器【原始碼範例】
 *
 * 這支是「範例讀取器」的原始碼,放 repo 供版控 / 測試 / 當日後 skill 產其他家
 * 讀取器的樣板。正式安裝的讀取器落在 data/vendor-parsers/,由 registry 動態載入;
 * 兩者不衝突(此檔不被 registry 掃到,靠其 targetFields/介面示範樣板)。
 *
 * 來源:金大竹崎「第二聯」估驗表 PDF,每頁 1 天(共 80 頁);純文字可抽。
 *
 * ── 介面(對齊 registry.js 檔頭定義)──
 *   meta       = { vendorKey:'金大營造有限公司', version, targetFields }
 *   parse(filePath, ctx)     -> Promise<單一天(第一頁)結構>
 *   parseAll(filePath, ctx)  -> Promise<[每天結構…]>
 *   selfTest()               -> boolean  (以內建小樣本頁文字驗證重組邏輯,不依賴檔案)
 *
 * ── 檔型工具「注入」──
 *   讀取器不自己 require 檔型檔或摸路徑;由 registry 於 parse/parseAll 時注入
 *   ctx.filetypes(= app/server/parsers/filetypes 的 exports),本檔以
 *   ctx.filetypes.extractItems(...) 取用(帶 x/y/w 座標的原始 item)。
 *
 * ── 逐列重組策略(PDF 換行錯位)──
 *   單一「項次」可能:
 *     - 名稱換行拆成多行(項次4/6/9/10/11)
 *     - 單位與數字欄落在後續行
 *   規則:以「行首 token 是否為項次 id」為列邊界。
 *     項次 id = 中文大寫(壹貳參肆伍陸柒捌玖拾) 或 純 1~2 位阿拉伯整數。
 *     續行(名稱/單位/數字/『-』)行首永不是裸整數,故不會誤判。
 *   一列收齊所有 token 後:找「單位 token」(面/式/M/M2/組/間/處…,走白名單);
 *   單位前(去掉 id)為工程項目名稱;單位後為數值欄。
 *   「-」「－」等無資料 token 一律解析為 null(語意:無資料,非 0)。
 *
 * ── 數值欄為什麼必須看座標而不是 token 順序 ──
 *   本日完成數量 / 本日完成金額 / 累計完成數量 三欄一律以 **x 座標**歸位。
 *   靠 token 順序在「廠商只填其中一欄、其餘欄連『-』都沒印」時會整排左移:
 *   2026-06-04 項次8 該列只印了一個 `62.0`,它是累計完成數量,舊版卻當成本日
 *   完成數量,再由 SP3 的 A8 生出「本日有施工但金額讀不到」這個假硬錯——看起來
 *   像廠商漏填,其實是讀取器猜錯欄。1280 列只中 1 列,但靠順序推欄是系統性風險。
 *   契約單價 / 契約數量 仍走順序(它們永遠成對出現在三欄區左側,且表頭
 *   「單位 契約單價 契約數量」是**單一 item**,取不到個別欄界)。
 *
 *   單一 item 常橫跨多欄(如 `"2250.00    1.0    "` 同時裝著金額與累計),
 *   故以 w/s.length 推每個字元的 x,再取 token 中心點判斷落在哪一欄。
 *   中心落在任何欄界之外(欄與欄之間的空隙)就**不指派**——寧可留 null 讓
 *   check-parser 的完整性關卡看得見,也不要猜一個看起來合理的欄位。
 *
 * 檔內漢字碼位:金大 PDF 的 CID 字型把部分漢字(如「年」)映到 CJK 相容區,
 * 已於 filetypes/pdf.js 統一做 NFKC 正規化,本檔拿到的都是標準漢字。
 */
// 中文大寫項次(類別/管理費列)。
const CJK_ITEM_IDS = ['壹', '貳', '參', '肆', '伍', '陸', '柒', '捌', '玖', '拾'];

// 已知單位字典(金大第二聯出現的);另補「以數字/大寫拉丁+可選數字」的樣式判定,
// 涵蓋 M / M2 / M3 等。
// 單位一律走白名單。**不可改回樣式判定**(曾用 /^[A-Z]+\d*$/ 涵蓋 M/M2/M3):
// `7 整地,新設 RC 基礎板 M 1,049 124.0` 這一列的 RC 會先命中,於是名稱被截成
// 「整地,新設」、單位變 RC、真正的 M 1,049 124.0 全部錯位成 null,而且沒有任何
// 錯誤訊息。項目名稱含 RC/PVC/PC/SUS 這類工程縮寫的列都會中。
// 要支援新單位就加進這份字典;沒列到的單位會讓該列缺欄位,由
// scripts/check-parser.js 的完整性關卡擋下——那比靜默錯位好得多。
const KNOWN_UNITS = new Set([
  '面', '式', '組', '間', '處', '座', '個', '支', '片', '公尺', '公斤', '噸',
  'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'T',
]);
function isUnitToken(tok) {
  return KNOWN_UNITS.has(tok);
}

// 無資料標記(『-』全形/半形、空白)→ null。
function isDash(tok) {
  return tok === '-' || tok === '–' || tok === '—' || tok === '－' || tok === '';
}

// 項次 id 判定(行首 token)。
function isItemId(tok) {
  return CJK_ITEM_IDS.includes(tok) || /^\d{1,2}$/.test(tok);
}

// 把 '2,250' / '1.00' / '-' → number 或 null。
function toNum(tok) {
  if (tok == null || isDash(tok)) return null;
  const cleaned = String(tok).replace(/,/g, '').trim();
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// 民國年 → 西元,回 'YYYY-MM-DD'。
function rocToISO(y, m, d) {
  const year = Number(y) + 1911;
  const mm = String(Number(m)).padStart(2, '0');
  const dd = String(Number(d)).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

// 三個數值欄的表頭字樣(由左至右)。表頭 item 的 [x, x+w] 就是欄界。
const VALUE_COLUMN_KEYS = ['本日完成數量', '本日完成金額', '累計完成數量'];

/**
 * 依 y 座標把 items 切成視覺行(y 一變就換行,與 filetypes 的 extractPages 同規則)。
 * 同一列的名稱/單位/數字 y 完全相同;名稱換行則落在另一個 y。
 */
function linesFromItems(items) {
  const lines = [];
  let lastY = null;
  for (const it of items) {
    if (lastY === null || it.y !== lastY) { lines.push({ y: it.y, items: [] }); lastY = it.y; }
    lines[lines.length - 1].items.push(it);
  }
  return lines;
}

/**
 * 找三個數值欄的欄界。表頭三個 item 的 y 有浮點差異(不在同一視覺行),
 * 故掃全部 items 而非只看某一行。抓不到就回 null,由呼叫端退回 token 順序。
 */
function detectValueColumns(items) {
  const heads = items.filter((it) => it.s.trim() === '完成數量' || it.s.trim() === '完成金額');
  if (heads.length !== 3) return null;
  const sorted = heads.slice().sort((a, b) => a.x - b.x);
  const shape = sorted.map((it) => it.s.trim()).join('|');
  if (shape !== '完成數量|完成金額|完成數量') return null;
  return sorted.map((it, i) => ({ key: VALUE_COLUMN_KEYS[i], x0: it.x, x1: it.x + it.w }));
}

/**
 * 把一個 item 拆成 token,並以 w/s.length 推出每個 token 的中心 x。
 * 表格區是等寬數字字型,實測誤差遠小於欄寬(54pt)。
 */
function tokensOfItem(it) {
  const s = it.s;
  const cw = s.length ? it.w / s.length : 0;
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const x = it.x + m.index * cw;
    out.push({ s: m[0], cx: x + (m[0].length * cw) / 2 });
  }
  return out;
}

function tokensOfLine(line) {
  return line.items.flatMap(tokensOfItem);
}

/**
 * 解析單頁(單一天)items → { header, dailyRows, extras }。
 * 純函式,不碰檔案;selfTest 亦重用之。
 */
function parsePage(items) {
  const cols = detectValueColumns(items);
  const visualLines = linesFromItems(items);
  const lines = visualLines.map((l) => l.items.map((i) => i.s).join(''));
  const text = lines.join('\n').normalize('NFKC');

  // ── header ──
  const nameMatch = text.match(/工程名稱[:：]\s*([^\t\n]+?)\s*(?:\t|日期[:：]|\n)/);
  const 工程名稱 = nameMatch ? nameMatch[1].trim() : null;

  const dateMatch = text.match(/日期[:：]\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日\s*(星期.)?/);
  const 填報日期 = dateMatch ? rocToISO(dateMatch[1], dateMatch[2], dateMatch[3]) : null;
  const 星期 = dateMatch && dateMatch[4] ? dateMatch[4] : null;

  // 當日累計(本日完成金額):頁尾 `累 計 (本日完成金額) ( 10400.248 )` 或 `本案累計金額 10400.248`
  let 本日累計金額 = null;
  const cumMatch = text.match(/本案累計金額\s*\t?\s*([\d,]+\.?\d*)/)
    || text.match(/累\s*計\s*\(本日完成金額\)[\s\S]*?\(\s*([\d,]+\.?\d*)\s*\)/);
  if (cumMatch) 本日累計金額 = toNum(cumMatch[1]);

  const header = {
    工程名稱,
    填報日期,
    星期,
    天氣_上午: null,   // 金大第二聯無天氣欄
    天氣_下午: null,
    預定進度: null,    // 第二聯無進度%
    實際進度: null,
    出工總人數: null,  // 第二聯無出工明細
    本日累計金額,
  };

  // ── dailyRows:以行首項次 id 為列邊界重組 ──
  // 先定位資料起點(表頭列後),終點(頁尾彙總前)。
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    // 表頭最後一行含「備註」;資料由其後第一個項次 id 行開始。
    if (/完成數量\s*備註|備\s*註/.test(lines[i])) { start = i + 1; break; }
  }

  const rows = [];
  let current = null; // { id, toks: [{s, cx}] }

  function flush() {
    if (current) {
      rows.push(buildRow(current.id, current.toks, cols));
      current = null;
    }
  }

  for (let i = start; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '') continue;

    // 頁尾彙總 → 結束
    if (/累\s*計\s*\(本日完成金額\)|本案累計金額|^備\s*註[:：]/.test(trimmed)) {
      flush();
      break;
    }

    const toks = tokensOfLine(visualLines[i]);
    if (!toks.length) continue;

    if (isItemId(toks[0].s)) {
      // 新項次列開始;該行第一 token 是 id,其餘 token 併入
      flush();
      current = { id: toks[0].s, toks: toks.slice(1) };
    } else if (current) {
      // 續行:全部 token 併入當前項次
      current.toks.push(...toks);
    }
  }
  flush();

  return { header, dailyRows: rows, extras: {} };
}

/**
 * 由「項次 id + 其後 token 序列」組出一列。
 * token 序列 = 名稱片段… + 單位 + 契約單價 + 契約數量 + 三個數值欄。
 * 單位為分界;單位前為名稱。單位後:三欄區左側依序為契約單價/契約數量,
 * 三欄區內依 token 中心 x 歸位(見檔頭「數值欄為什麼必須看座標」)。
 *
 * @param {Array<{s:string,cx:number}>} toks 單位/名稱/數值 token(cx = 中心 x)
 * @param {Array<{key:string,x0:number,x1:number}>|null} cols 三個數值欄的欄界;
 *        抓不到表頭時為 null,退回舊的 token 順序解析。
 */
function buildRow(id, toks, cols) {
  // 找第一個單位 token 位置。
  let unitIdx = -1;
  for (let i = 0; i < toks.length; i++) {
    if (isUnitToken(toks[i].s)) { unitIdx = i; break; }
  }

  let 工程項目 = null;
  let 單位 = null;
  let after = [];

  if (unitIdx === -1) {
    // 無單位(純類別列,如「壹 直接工程費」):全部 token 皆名稱。
    工程項目 = toks.map((t) => t.s).join('') || null;
  } else {
    工程項目 = toks.slice(0, unitIdx).map((t) => t.s).join('') || null;
    單位 = toks[unitIdx].s;
    after = toks.slice(unitIdx + 1);
  }

  // 名稱清掉殘留空白(pdf 換行不含空白,join('') 即原字)。
  if (工程項目 != null) 工程項目 = 工程項目.replace(/\s+/g, '');

  const values = { 本日完成數量: null, 本日完成金額: null, 累計完成數量: null };
  // 三欄區左側 = 契約單價、契約數量(這兩欄取不到欄界,見檔頭)。
  const left = cols ? after.filter((t) => t.cx < cols[0].x0) : after;
  if (cols) {
    for (const t of after) {
      // 中心落在欄與欄之間的空隙 → 不指派,留 null 讓完整性關卡看得見。
      const col = cols.find((c) => t.cx >= c.x0 && t.cx <= c.x1);
      if (col) values[col.key] = toNum(t.s);
    }
  } else {
    values.本日完成數量 = toNum(after[2] && after[2].s);
    values.本日完成金額 = toNum(after[3] && after[3].s);
    values.累計完成數量 = toNum(after[4] && after[4].s);
  }

  return {
    項次: id,
    工程項目,
    單位: 單位 || null,
    契約單價: toNum(left[0] && left[0].s),
    契約數量: toNum(left[1] && left[1].s),
    ...values,
  };
}

/**
 * parse(filePath, ctx) — 回該檔第一天(第一頁)結構。
 * @param {object} ctx registry 注入;ctx.filetypes.extractPages 抽 PDF 頁文字。
 * @returns {Promise<{header, dailyRows, extras}>}
 */
async function parse(filePath, ctx) {
  const pages = await ctx.filetypes.extractItems(filePath);
  if (!pages.length) return { header: {}, dailyRows: [], extras: {} };
  return parsePage(pages[0].items);
}

/**
 * parseAll(filePath, ctx) — 逐頁(逐日)解析,回每天結構陣列。
 * @returns {Promise<Array<{header, dailyRows, extras}>>}
 */
async function parseAll(filePath, ctx) {
  const pages = await ctx.filetypes.extractItems(filePath);
  return pages.map(p => parsePage(p.items));
}

// selfTest:以內建小樣本 items 驗證重組邏輯(不依賴檔案,安裝時可執行)。
// 座標取自 tests/fixtures/jinda.pdf 第 1 頁的真實 item(x/y/w 未經修改),
// 只換掉工程名稱。自己編一組好看的座標會讓 selfTest 驗不到真實版面的形狀——
// 例如「一個 item 同時裝著金額欄與累計欄」正是欄位歸位最容易錯的地方。
function selfTest() {
  const I = (x, y, w, s) => ({ x, y, w, s });
  const items = [
    I(42.5, 770, 200, '工程名稱:測試工程 '), I(250, 770, 150, '日期:115 年 04 月 08 日星期三 '),
    // 表頭:三個數值欄的 y 有浮點差異(真實如此),欄界偵測不能假設它們同一行
    I(43.2, 722, 30, '項次 '), I(102.5, 722, 72, '工 程 項 目 '),
    I(344.3, 714.1, 54, '完成數量 '),
    I(402.4, 714.2, 54, '完成金額 '),
    I(464.1, 714.3, 54, '完成數量 '),
    I(525, 722.1, 30, '備註 '),
    I(42.5, 700, 78, '壹   直接工程費 '),
    // 項次1:五欄俱全。末個 item 一個裝著金額(2250.00)與累計(1.0)
    I(42.5, 680, 130.1, '1    工程告示牌(租用) '), I(212.1, 680, 18, '面 '),
    I(256.7, 680, 73.1, '2,250   1.0 '), I(356.3, 680, 30, '1.00 '),
    I(414.4, 680, 111.4, '2250.00    1.0    '),
    // 項次3:本日/累計皆「-」(無資料,非 0)
    I(42.5, 643, 130.1, '3    三角錐連桿(租用) '), I(215.1, 643, 12, 'M '),
    I(268.7, 643, 64.1, '135   72.0 '), I(365.3, 643, 12, '- '),
    I(450.4, 643, 75.4, '-     -      '),
    // 項次4:名稱換行拆兩行,單位與數字落在續行
    I(42.5, 624, 12, '4 '), I(70.6, 624, 129.7, '施工動線開闢,整備與復'),
    I(70.6, 606, 42, '原工程 '), I(212.1, 606, 18, '式 '),
    I(250.7, 606, 80, '25,200   1.0 '), I(365.3, 606, 12, '- '),
    I(450.4, 606, 75.4, '-     -      '),
    // 項次8:廠商只填了累計欄,本日兩欄連「-」都沒印。座標取自 2026-06-04 該列:
    // 該 item 起點比正常列右移一個字元寬(少了開頭的「-」),但右端 525.8 與正常列一致
    I(42.5, 406, 160, '8    新建圍網 RC 矮牆基座 '), I(215.1, 406, 12, 'M '),
    I(256.7, 406, 79.1, '3,280  124.0 '), I(456.4, 406, 69.4, '   62.0    '),
    // 伍:中文大寫項次
    I(42.5, 300, 100, '伍   營造綜合保險費 '), I(212.1, 300, 18, '式 '),
    I(250.7, 300, 80, '5,000   1.0 '), I(356.3, 300, 30, '1.0 '),
    I(414.4, 300, 111.4, '5000.0     1.0    '),
    // 頁尾彙總:資料列在此結束
    I(42.5, 150, 166.7, '     累 計 (本日完成金額)   '), I(387.7, 150, 74.8, '(  10400.248 '),
    I(459.2, 150, 12, ') '),
  ];

  try {
    const out = parsePage(items);
    if (out.header.填報日期 !== '2026-04-08') return false;
    if (out.header.星期 !== '星期三') return false;
    if (out.header.本日累計金額 !== 10400.248) return false;

    const r1 = out.dailyRows.find(r => r.項次 === '1');
    if (!r1 || r1.單位 !== '面' || r1.契約單價 !== 2250 || r1.本日完成金額 !== 2250) return false;

    const r3 = out.dailyRows.find(r => r.項次 === '3');
    if (!r3 || r3.本日完成數量 !== null || r3.本日完成金額 !== null) return false;

    const r4 = out.dailyRows.find(r => r.項次 === '4');
    if (!r4 || r4.單位 !== '式' || r4.契約單價 !== 25200) return false;
    if (!/施工動線開闢/.test(r4.工程項目) || !/原工程/.test(r4.工程項目)) return false;

    const rWu = out.dailyRows.find(r => r.項次 === '伍');
    if (!rWu || rWu.本日完成金額 !== 5000) return false;

    // 只填累計欄的列:靠 token 順序會把 62.0 讀成本日完成數量(2026-06-04 項次8 實況)。
    // 這條在,任何把數值欄改回順序推導的改動都會在安裝時被 selfTest 擋下。
    const r8 = out.dailyRows.find(r => r.項次 === '8');
    if (!r8 || r8.累計完成數量 !== 62 || r8.本日完成數量 !== null || r8.本日完成金額 !== null) return false;

    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  meta: {
    vendorKey: '金大營造有限公司',
    version: '1.1.0',   // 1.1.0:數值三欄改依 x 座標歸位(原本靠 token 順序,見檔頭)
    targetFields: [
      '工程名稱', '填報日期', '星期', '本日累計金額',
      '項次', '工程項目', '單位', '契約單價', '契約數量',
      '本日完成數量', '本日完成金額', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  parsePage,   // 匯出純函式供測試/自檢
  selfTest,
};
