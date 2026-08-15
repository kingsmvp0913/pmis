/**
 * changze.pmisparser.js — 長澤營造施工日誌讀取器(光復國小 PU / 中和國小鋪面)
 *
 * vendorKey 取自**決標公告的得標廠商**(11325光復國小PU操場、11407中和鋪面兩案皆為
 * 長澤營造有限公司),日誌本身「承攬廠商名稱」欄也載明同一個名稱,兩邊一致。
 *
 * ── 一家兩種檔型(不是兩種版面)──
 * 兩案交的都是**工程會標準「公共工程施工日誌」表單**,差別只在輸出成 PDF 還是 Excel:
 *   - 光復:16 份全 PDF(122 頁 = 122 天)
 *   - 中和:xls 3 份 + PDF 3 份;PDF 與光復逐 item 同版面,xls 是同一份表單的試算表原稿
 * xls 多了 PDF 上沒有的**契約單價與本日完成金額**(PDF 版面根本沒印那兩欄),
 * 故同一天兩種檔都有時**以 xls 為準**。副檔名決定走哪條解析路徑。
 *
 * ── PDF 版面事實(實測,座標版)──
 * 一頁一天。名稱在 x≈39,數值在 x≥399,兩者 y 差 0.3~0.4pt(**不是同一個 y**,
 * 用「y 一變就換行」會把名稱與數值拆成兩行),故以 1.5pt 容差分視覺行。
 *
 * 數值欄的表頭是**單一 item**「單位 契約數量 本日完成  累計完成 備註」(x399.7 w153.4),
 * 取不到各欄獨立的 [x, x+w]。但可由 w/s.length 推每個字元的 x,算出五個標籤的中心,
 * 再取相鄰中心的中點當欄界——這比退回 token 順序可靠:廠商當天沒填的欄**連「-」都不印**
 * (第 2 天第 1 列只印了「式 1.00」+「1.00」,中間的本日完成整個消失),
 * 靠順序會把累計值當成本日完成。
 *
 * ── xls 版面事實(實測,中和)──
 * 5 分頁 `基本 | 封面 | 施工 | 監造 | 工作表1`。逐日明細在 `施工`(一天一區塊,
 * 以欄 0 的「表報編號」為起點)。`基本` 只是逐日彙總 + 並排的契約項目清單,沒有逐日逐項數量。
 *
 * ── 項次:來源不印,以「排除大類後的出現序」補 ──
 * 兩案的日誌都**沒有項次欄**。但中和 `基本` 分頁右側的契約項目清單有編號,
 * 實測 1=工程告示牌、2=施工管制措施、3=施工動線…**與明細列排除大類後的出現序一字不差**;
 * 光復對照人工監造報表的契約詳細價目表(壹.1…壹.26 + 貳~陸 共 31 項)也與 31 列逐列對齊。
 * 故項次填出現序。**這是位置事實不是推導數值**;它與契約表的「壹.1」格式對不上,
 * E 類驗證因此會走名稱後備對應(A4「項次未填」則不會每天誤報 31 次)。
 */

const META_VENDOR_KEY = '長澤營造有限公司';

// ── 共用小工具 ────────────────────────────────────────────
const text = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s === '' || s === '-' || s === '－' ? null : s;
};

/** 數值。無資料標記(`-`/`－`/空白)一律 null——語意是「無資料」不是 0。 */
function numOf(v) {
  const s = v == null ? '' : String(v).replace(/[,\s　]/g, '');
  if (s === '' || s === '-' || s === '－') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const despace = (s) => String(s == null ? '' : s).replace(/[\s　]/g, '');

/** 民國/西元 `113年11月27日` → 'YYYY-MM-DD';不符格式回 null。 */
function rocToISO(y, m, d) {
  let year = Number(y);
  if (!Number.isFinite(year)) return null;
  if (year < 1911) year += 1911;
  const p = (n) => String(Number(n)).padStart(2, '0');
  return `${year}-${p(m)}-${p(d)}`;
}

// ══════════════════════════════════════════════════════════
//  PDF 路徑(工程會標準表單,座標版)
// ══════════════════════════════════════════════════════════

// 名稱與其數值的 y 差實測 0.3~0.4pt,相鄰列間距 ~10pt。1.5 兩邊都安全。
const Y_TOLERANCE = 1.5;

// 數值欄表頭的四個標籤(由左至右)。
// **不把「備註」納入**:累計完成的值是右對齊的,以「累計完成|備註」的中點當右界時
// 實測只剩 0.3pt 餘裕(某些檔的表頭字距不同就會擠過界),而備註欄實測整份皆空,
// 就算真的填了文字也只會被 numOf 擋成 null。讓累計完成吃到最右反而安全。
const VALUE_HEAD_LABELS = ['單位', '契約數量', '本日完成', '累計完成'];
const VALUE_HEAD_KEYS = ['單位', '契約數量', '本日完成數量', '累計完成數量'];

/** 依 y 容差把 items 分成視覺行(由上而下)。 */
function linesFromItems(items) {
  const buckets = [];
  const ordered = (items || []).filter((it) => String(it.s || '').trim())
    .slice().sort((a, b) => b.y - a.y);
  for (const it of ordered) {
    let b = buckets.find((k) => Math.abs(k.y - it.y) <= Y_TOLERANCE);
    if (!b) { b = { y: it.y, items: [] }; buckets.push(b); }
    b.items.push(it);
  }
  buckets.sort((a, b) => b.y - a.y);
  for (const b of buckets) b.items.sort((p, q) => p.x - q.x);
  return buckets;
}

/** 一行的純文字(依 x 排序後接起來)。 */
const lineText = (line) => line.items.map((i) => i.s).join('');

/**
 * 單位白名單。**一律白名單,禁用樣式判定**——名稱裡的 RC/PVC/AC/PU 這類工程縮寫
 * 會被任何「大寫拉丁字母」規則誤判成單位(金大踩過,整列錯位且沒有錯誤訊息)。
 * 由長到短排序,供 STICKY_RE 交替比對時 M2 先於 M。
 */
const KNOWN_UNITS = ['M2', 'M3', 'CM', 'MM', 'KG', 'kg', '公尺', '公斤',
  '式', '座', '組', '場', '棵', '株', '面', '處', '個', '支', '片', '只',
  '間', '天', '日', '趟', '工', '噸', 'M', 'T'];

const NUMERIC_RE = /^[\d,]+(?:\.\d+)?$/;

/** 單位一律走白名單;不在字典裡就是 null,讓完整性關卡看得見,不逐字收下。 */
function unitOf(v) {
  const s = text(v);
  return s != null && KNOWN_UNITS.includes(s) ? s : null;
}

/**
 * 把「單位緊接數字、中間沒有空白」的黏連 token 拆開,如 "式1.00" → ['式','1.00']。
 * 回 null 表示不是黏連(交由座標歸位)。
 *
 * **必須取最長單位後就停,不能用正則交替讓它回溯**:`^(M2|…|M)([\d,]+…)$` 對 "M2"
 * 會先試 M2、剩空字串失敗,再回溯成 M + "2" —— 單位變 M、契約數量變 2,
 * 於是「刨除清運既有中央草皮」的 2171 M2 被讀成 2 M,C1 噴 457 個假硬錯。
 */
function splitSticky(tok) {
  for (const u of KNOWN_UNITS) {           // 由長到短,取最長匹配後即停
    if (!tok.startsWith(u)) continue;
    const rest = tok.slice(u.length);
    if (rest === '') return null;          // 整個 token 就是單位,不是黏連
    if (NUMERIC_RE.test(rest)) return [u, rest];
    // 以單位開頭但形狀不明(例如三個數字也黏成一串):只收單位,其餘留 null
    // 讓完整性關卡看得見,不猜一個看起來合理的值。
    if (/\d/.test(rest)) return [u, null];
    return null;
  }
  return null;
}

/**
 * 把一個 item 拆成 token,並以 w/s.length 推出每個 token 的中心 x。
 * 單一 item 常同時裝著好幾欄的值(「式   1.00    0.10    0.30」一個 item 裝了四欄),
 * 只有 x(左端)無法判斷欄位落點。
 *
 * ⚠️ **w 會包含被省略的空白,均分因此對「黏連 item」失效。**
 * 費用項那幾列的 item 是 `x403.0 w67.9 "式1.00"`——pdfjs 把單位與數字之間的空白
 * 吃掉了(字串只剩 5 個字),w 卻仍是含空白的 67.9,推出來的字元寬 13.6 是真實值的
 * 2.7 倍,整個 token 的中心落到契約數量欄,於是**單位與契約數量雙雙變 null**。
 * 光復實測 4 列/天中招,而列還在、名稱也對,完整性關卡只看得到「缺欄位」、
 * 看不到後果:這幾列因此被 isCategoryRow 誤判成大類,不佔項次,**其後所有項次整批位移**
 * (保險費在多數天變成項次 27,而它其實是 30)。
 *
 * 對策:只在「整個 token = 已知單位 + 一個數字」這個明確形狀下,把它拆成
 * 單位 + 契約數量兩個 token(單位/契約數量在此表單是固定相鄰的前兩欄)。
 * **這是唯一退回欄序推定的地方**;形狀稍有出入(例如三個數字也黏在一起)就寧可
 * 只收單位、數字留 null,讓完整性關卡看得見,不猜一個看起來合理的值。
 */
function tokensOfItem(it, { sticky = false } = {}) {
  const s = String(it.s == null ? '' : it.s);
  const cw = s.length ? it.w / s.length : 0;
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const cx = it.x + (m.index + m[0].length / 2) * cw;
    const split = sticky ? splitSticky(m[0]) : null;
    if (split) {
      out.push({ s: split[0], forced: '單位' });
      if (split[1] != null) out.push({ s: split[1], forced: '契約數量' });
      continue;
    }
    out.push({ s: m[0], cx });
  }
  return out;
}

/** 一整行的「字元 → 中心 x」映射(跨 item 串接);標籤被切在不同 item 時也定位得到。 */
function charMapOfLine(line) {
  const out = [];
  for (const it of line.items) {
    const s = String(it.s == null ? '' : it.s);
    const cw = s.length ? it.w / s.length : 0;
    for (let i = 0; i < s.length; i++) out.push({ ch: s[i], cx: it.x + (i + 0.5) * cw });
  }
  return out;
}

/**
 * 由表頭行推四個數值欄的欄界:標籤所佔字元的平均 x = 標籤中心,欄界取相鄰中心的中點。
 *
 * **必須以「行」而非「單一 item」為單位。** 同一份表單在不同檔案裡切分方式不同:
 * 多數檔的表頭是一個 item「單位 契約數量 本日完成  累計完成 備註」,但
 * `11月日報表(修)1203.pdf` 把它切成「單」「位」「契約數量本日完成 累計完成 備註」三個。
 * 只認單一 item 的話那份就抓不到欄界——讀取器會誠實地回 0 列(不亂猜),
 * 但那 4 天的明細也就整批讀不到。
 *
 * 找不到表頭回 null,由呼叫端整份放棄而非退回 token 順序:猜錯欄位不會讓任何值變 null,
 * 完整性關卡看不見。
 */
function detectValueColumns(lines) {
  for (const line of lines) {
    const map = charMapOfLine(line);
    const str = map.map((c) => c.ch).join('');
    if (!str.includes('單位') || !str.includes('累計完成')) continue;
    const centers = [];
    for (const label of VALUE_HEAD_LABELS) {
      const i = str.indexOf(label);
      if (i < 0) return null;                          // 少一個標籤就不猜
      const seg = map.slice(i, i + label.length);
      centers.push(seg.reduce((s, c) => s + c.cx, 0) / seg.length);
    }
    const cols = [];
    for (let i = 0; i < centers.length; i++) {
      cols.push({
        key: VALUE_HEAD_KEYS[i],
        lo: i === 0 ? -Infinity : (centers[i - 1] + centers[i]) / 2,
        hi: i === centers.length - 1 ? Infinity : (centers[i] + centers[i + 1]) / 2,
      });
    }
    // 名稱欄與數值欄的分界:由「單位」往左推一個欄距。寫死 x 會在不同檔的
    // 表格左右邊界不同時(光復 x399.7 / 修訂版 x437.5)整片錯位。
    cols.valueZoneX = centers[0] - (centers[1] - centers[0]);
    return cols;
  }
  return null;
}

/** token 中心落在哪一欄;落在欄與欄之間(或備註欄)回 null,不硬指派。 */
function columnOf(cols, cx) {
  const hit = cols.find((c) => cx >= c.lo && cx < c.hi);
  return hit ? hit.key : null;
}

/** 在一行裡找某標籤的中心 x(標籤可能只是某個 item 的一部分)。 */
function labelCenterX(line, label) {
  for (const it of line.items) {
    const s = String(it.s || '');
    const i = s.indexOf(label);
    if (i < 0) continue;
    const cw = s.length ? it.w / s.length : 0;
    return it.x + (i + label.length / 2) * cw;
  }
  return null;
}

/**
 * 出工人員與機具(PDF)。表頭行形如
 *   「工」「別  本日人數」「累計人數」「機」「具」「名」「稱  本日使用」「累計使用」
 * 之後 4 行是 機械工/板模工/技術工/普通工 與 挖掘機/破碎機/大卡車/小卡車。
 * **本日人數與累計人數一定要用 x 分辨**:當天沒出工時廠商只印累計那一欄,
 * 靠 token 順序會把累計人數當成本日人數。
 */
function parseCrew(lines, startIdx) {
  const head = lines[startIdx];
  const 累計人數X = labelCenterX(head, '累計人數');
  const 機具區X = labelCenterX(head, '機');
  const 累計使用X = labelCenterX(head, '累計使用');
  const 出工明細 = [];
  const 主要機具 = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const t = lineText(lines[i]);
    if (/^四、|^五、/.test(t.trim())) break;
    const 工別 = [];
    const 機具 = [];
    for (const it of lines[i].items) {
      for (const tk of tokensOfItem(it)) {
        (機具區X != null && tk.cx >= 機具區X ? 機具 : 工別).push(tk);
      }
    }
    const take = (toks, 分界X) => {
      const 名 = toks.filter((k) => !/^[\d,.]+$/.test(k.s)).map((k) => k.s).join('');
      const 數 = toks.filter((k) => /^[\d,.]+$/.test(k.s));
      const 本日 = 分界X == null ? null : 數.find((k) => k.cx < 分界X);
      return { 名, 本日: 本日 ? numOf(本日.s) : null };
    };
    const a = take(工別, 累計人數X);
    if (a.名) 出工明細.push({ 工別: a.名, 人數: a.本日 });
    const b = take(機具, 累計使用X);
    if (b.名) 主要機具.push({ 名稱: b.名, 數量: b.本日 });
    if (出工明細.length >= 8) break;   // 版面固定 4 列;留餘裕但不無限吃下去
  }
  return { 出工明細, 主要機具 };
}

/**
 * 解析單頁(單一天)的 items。純函式,不碰檔案系統;selfTest 重用之。
 * @param {Array<{x:number,y:number,w:number,s:string}>} items
 */
function parsePage(items) {
  const lines = linesFromItems(items);
  const cols = detectValueColumns(lines);

  // ── header ──
  let 工程名稱 = null; let 填報日期 = null; let 星期 = null;
  let 天氣_上午 = null; let 天氣_下午 = null;
  let 預定進度 = null; let 實際進度 = null; let 承包廠商 = null; let 開工日期 = null;
  let 明細起 = -1; let 明細迄 = -1; let 出工起 = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lineText(lines[i]);
    const t = despace(raw);
    if (工程名稱 == null && /^工程名稱/.test(t)) {
      工程名稱 = text(t.replace(/^工程名稱/, ''));
    }
    if (填報日期 == null && /填報日期/.test(t)) {
      const m = /填報日期[:：]?(\d{2,4})年(\d{1,2})月(\d{1,2})日(星期.)?/.exec(t);
      if (m) { 填報日期 = rocToISO(m[1], m[2], m[3]); 星期 = m[4] || null; }
    }
    if (天氣_上午 == null && /本日天氣/.test(t)) {
      // 天氣列與填報日期列的 y 只差 0.4pt,分視覺行時會被併成同一行,
      // 下午天氣後面直接接著「填報日期114年…」。`(\S+)` 會把整串日期一起吃掉,
      // 而吃進去的仍是合法字串——完整性關卡看不見。故限定長度並要求右界。
      const m = /上午[:：]?(.{1,3}?)下午[:：]?(.{1,3}?)(?:填報日期|表報編號|$)/
        .exec(t.replace(/本日天氣[:：]?/, ''));
      if (m) { 天氣_上午 = text(m[1]); 天氣_下午 = text(m[2]); }
    }
    // 標籤有兩種寫法:多數是「承攬廠商名稱」,光復的修訂版是「承攬廠商名」。
    if (承包廠商 == null && /承攬廠商名/.test(t)) {
      承包廠商 = text(t.replace(/^.*承攬廠商名稱?/, ''));
    }
    if (開工日期 == null && /開工日期/.test(t)) {
      const m = /開工日期(\d{2,4})年(\d{1,2})月(\d{1,2})日/.exec(t);
      if (m) 開工日期 = rocToISO(m[1], m[2], m[3]);
    }
    if (預定進度 == null) {
      const m = /預定進度\(%\)([\d.]+)/.exec(t);
      if (m) 預定進度 = numOf(m[1]);
    }
    if (實際進度 == null) {
      const m = /實際進度\(%\)([\d.]+)/.exec(t);
      if (m) 實際進度 = numOf(m[1]);
    }
    // 明細區:表頭行(含「累計完成」)的下一行起,到「(營造業專業工程特定施工項目)」為止
    if (明細起 < 0 && /單位.*累計完成/.test(raw)) 明細起 = i + 1;
    if (明細起 >= 0 && 明細迄 < 0 && /營造業專業工程特定施工項目|^二、/.test(t)) 明細迄 = i;
    if (出工起 < 0 && /本日人數/.test(t) && /累計人數/.test(t)) 出工起 = i;
  }

  // ── dailyRows ──
  const dailyRows = [];
  if (cols && 明細起 >= 0) {
    const end = 明細迄 >= 0 ? 明細迄 : lines.length;
    let seq = 0;
    const zoneX = cols.valueZoneX;
    for (let i = 明細起; i < end; i++) {
      const line = lines[i];
      const nameItems = line.items.filter((it) => it.x < zoneX);
      const 工程項目 = text(nameItems.map((it) => it.s).join('').replace(/\s+/g, ''));
      if (工程項目 == null) continue;
      const got = {};
      for (const it of line.items) {
        if (it.x < zoneX) continue;
        for (const tk of tokensOfItem(it, { sticky: true })) {
          const key = tk.forced || columnOf(cols, tk.cx);
          if (key && got[key] === undefined) got[key] = tk.s;
        }
      }
      const 單位 = unitOf(got.單位);
      const 契約數量 = numOf(got.契約數量);
      // 大類列(「一直接工程費」/「直接工程」)不佔項次——它與費用項的差別就是三欄皆空。
      const isCategory = 單位 == null && 契約數量 == null;
      if (!isCategory) seq++;
      dailyRows.push({
        項次: isCategory ? null : String(seq),
        工程項目,
        單位,
        契約單價: null,      // PDF 版面沒有這兩欄(xls 原稿才有);絕不由金額回推
        契約數量,
        本日完成數量: numOf(got.本日完成數量),
        本日完成金額: null,
        累計完成數量: numOf(got.累計完成數量),
      });
    }
  }

  // ── extras ──
  const extras = {};
  let 出工總人數 = null;
  if (出工起 >= 0) {
    const { 出工明細, 主要機具 } = parseCrew(lines, 出工起);
    if (出工明細.length) {
      extras.出工明細 = 出工明細;
      const n = 出工明細.filter((c) => c.人數 != null);
      if (n.length) 出工總人數 = n.reduce((s, c) => s + c.人數, 0);
    }
    if (主要機具.length) extras.主要機具 = 主要機具;
  }

  return {
    header: {
      工程名稱,
      填報日期,
      星期,
      天氣_上午,
      天氣_下午,
      預定進度,
      實際進度,
      出工總人數,
      本日累計金額: null,   // PDF 版面無任何金額欄
      承包廠商,
      開工日期,
    },
    dailyRows,
    extras,
  };
}

// ══════════════════════════════════════════════════════════
//  Excel 路徑(中和 `施工` 分頁)
// ══════════════════════════════════════════════════════════

const XLS_SHEET = '施工';
// 錨點的字面在同一份檔案裡就有兩種寫法(第一天是「表報編號」,其後都是「表報編號：」),
// 逐字相等只會找到 1 個區塊、其餘 122 天靜靜消失。
const XLS_ANCHOR_RE = /^表\s*報\s*編\s*號[:：]?$/;

// 相對錨點列的位移(實測)
const X_OFF = { 名稱: 1, 工期: 3, 進度: 4, 表頭: 6 };
// 明細欄索引。欄 15/16 是 PDF 沒有的單價與本日金額;
// 實測 3128=3128×1、8800=44000×0.2、5000=5000×1 —— 欄 16 確實是「單價×本日完成數量」,
// 不是標籤寫什麼就收什麼(祥賀的「累計」標籤配當日值踩過)。
const XCOL = {
  工程項目: 0, 單位: 9, 契約數量: 10, 本日完成數量: 11, 累計完成數量: 12,
  契約單價: 15, 本日完成金額: 16,
};

const gcell = (grid, r, c) => {
  const row = grid[r];
  return row ? row[c] : undefined;
};

/**
 * 解析 `施工` 分頁的一天區塊(純函式;selfTest 重用之)。
 * @param {Array<Array>} grid
 * @param {number} a 錨點列(欄 0 === '表報編號')
 * @param {(serial:number)=>string|null} serialToISO
 */
function parseXlsBlock(grid, a, serialToISO) {
  const iso = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return serialToISO ? serialToISO(v) : null;
    const m = /(\d{2,4})[年/-](\d{1,2})[月/-](\d{1,2})/.exec(String(v));
    return m ? rocToISO(m[1], m[2], m[3]) : null;
  };

  const dailyRows = [];
  let seq = 0;
  for (let r = a + X_OFF.表頭 + 1; r < grid.length; r++) {
    const 工程項目 = text(gcell(grid, r, XCOL.工程項目));
    if (工程項目 == null) break;                                   // 明細結束
    if (/營造業專業工程特定施工項目/.test(工程項目)) break;
    // 單位走白名單。大類列(「直接工程」)在來源是一個橫跨欄 0~13 的合併儲存格,
    // gridFromWorksheet 會把起點值填滿整個合併區,於是單位欄也讀到「直接工程」——
    // 逐字收下的話它就不是大類了,會佔掉項次 1 並讓其後每一項都位移。
    const 單位 = unitOf(gcell(grid, r, XCOL.單位));
    const 契約數量 = numOf(gcell(grid, r, XCOL.契約數量));
    const 契約單價 = numOf(gcell(grid, r, XCOL.契約單價));
    const isCategory = 單位 == null && 契約數量 == null && 契約單價 == null;
    if (!isCategory) seq++;
    dailyRows.push({
      項次: isCategory ? null : String(seq),
      工程項目,
      單位,
      契約單價,
      契約數量,
      本日完成數量: numOf(gcell(grid, r, XCOL.本日完成數量)),
      本日完成金額: numOf(gcell(grid, r, XCOL.本日完成金額)),
      累計完成數量: numOf(gcell(grid, r, XCOL.累計完成數量)),
    });
  }

  // 出工/機具:找「工別」列(欄 0),其後每列 欄0=工別 欄2=本日人數 欄4=累計人數、
  // 欄7=機具名稱 欄9=本日使用。
  const extras = {};
  let 出工總人數 = null;
  for (let r = a + X_OFF.表頭; r < Math.min(grid.length, a + 80); r++) {
    if (text(gcell(grid, r, 0)) !== '工別') continue;
    const 出工明細 = [];
    const 主要機具 = [];
    for (let k = r + 1; k < Math.min(grid.length, r + 9); k++) {
      const 工別 = text(gcell(grid, k, 0));
      if (工別 == null || /^[一二三四五六七八]、/.test(工別)) break;
      出工明細.push({ 工別, 人數: numOf(gcell(grid, k, 2)) });
      const 機具 = text(gcell(grid, k, 7));
      if (機具) 主要機具.push({ 名稱: 機具, 數量: numOf(gcell(grid, k, 9)) });
    }
    if (出工明細.length) {
      extras.出工明細 = 出工明細;
      const n = 出工明細.filter((c) => c.人數 != null);
      if (n.length) 出工總人數 = n.reduce((s, c) => s + c.人數, 0);
    }
    if (主要機具.length) extras.主要機具 = 主要機具;
    break;
  }

  return {
    header: {
      工程名稱: text(gcell(grid, a + X_OFF.名稱, 1)),
      填報日期: iso(gcell(grid, a, 11)),
      星期: null,                                    // 此格式不提供
      天氣_上午: text(gcell(grid, a, 5)),
      天氣_下午: text(gcell(grid, a, 7)),
      預定進度: numOf(gcell(grid, a + X_OFF.進度, 2)),
      實際進度: numOf(gcell(grid, a + X_OFF.進度, 7)),
      出工總人數,
      // 區塊尾欄 19 的「合計」是**本日各項金額合計**,不是累計金額;
      // schema 這欄要的是當日累計,來源沒有就 null(不自行累加,那是推導不是來源值)。
      本日累計金額: null,
      承包廠商: text(gcell(grid, a + X_OFF.名稱, 11)),
      開工日期: iso(gcell(grid, a + X_OFF.工期, 12)),
    },
    dailyRows,
    extras,
  };
}

function xlsBlockStarts(grid) {
  const out = [];
  for (let r = 0; r < grid.length; r++) {
    const v = text(gcell(grid, r, 0));
    if (v != null && XLS_ANCHOR_RE.test(v)) out.push(r);
  }
  return out;
}

// ══════════════════════════════════════════════════════════
//  對外介面
// ══════════════════════════════════════════════════════════

/**
 * 「還沒填的預備區塊」判定。
 *
 * 廠商把整個工期的表格**一次建好**再逐日填寫,所以檔案尾端會有一批空區塊:
 * 填報日期欄空白、天氣空白、實際進度是壞掉的公式值(中和實測 3097%),
 * 明細的「累計完成」卻有值(公式從前一天帶下來的)。它們不是「一天」,
 * 收下來 SP3 會噴 A1(日期未填)22 個、C4(進度不在 0~100)、D1(同一天兩次)。
 *
 * **只以「沒有日期」為由丟掉是危險的**——真的有日期卻讀不到時就會靜默消失一天。
 * 故要求「沒有日期」**且**「整天沒有任何本日完成量」;只要有人填過東西就保留,
 * 讓 A1 把它報出來(Fail Loud)。
 *
 * 「沒填」在 xls 是**空白或 0**(金額欄是公式,沒填時算出 0 而不是空白),
 * 只認 null 會漏掉整批;而 0 單獨出現是合法的「當天沒做」,故必須與「沒有日期」並用。
 *
 * ── 第二條路:沒有日期**且**沒有預定進度 ──
 * 上面那條漏掉中和尾端的 11 個區塊:它們的「本日完成」被公式帶進殘值(項次4 = 0.5、
 * 項次20 = 195),於是 `every(blank)` 不成立而被當成 11 個「日期讀不到的天」收下來。
 *
 * 那 11 個區塊的預定進度在來源是 `=+#REF!`(廠商把上游的參照列刪掉了),
 * `gridFromWorksheet` 把 error cell 轉 null,所以這裡看到的是 null。
 * 實測整份**有日期的 101 天預定進度全部有值、無日期的 11 天全部是 null**,
 * 兩者零重疊——「連預定進度都沒有」與「沒有日期」是兩個獨立訊號,同時成立才丟,
 * 仍然不是單憑沒日期就丟。
 */
function isUnfilledBlock(day) {
  if (day.header.填報日期 != null) return false;
  if (day.header.預定進度 == null) return true;
  const blank = (v) => v == null || v === 0;
  return (day.dailyRows || []).every((r) => blank(r.本日完成數量) && blank(r.本日完成金額));
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft) throw new Error('缺少 ctx.filetypes(檔型工具需由 registry 注入)');
  const isPdf = /\.pdf$/i.test(String(filePath));

  if (isPdf) {
    if (typeof ft.extractItems !== 'function') throw new Error('缺少注入的 filetypes.extractItems');
    const pages = await ft.extractItems(filePath);
    const out = [];
    for (const p of pages) {
      const day = parsePage(p.items || p);
      if (!day.dailyRows.length && day.header.填報日期 == null) continue;   // 附表/非日誌頁
      if (isUnfilledBlock(day)) continue;
      out.push(day);
    }
    return out;
  }

  if (typeof ft.readWorkbook !== 'function') throw new Error('缺少注入的 filetypes.readWorkbook');
  const wb = ft.readWorkbook(filePath);
  const grid = wb.sheets[XLS_SHEET];
  if (!grid) throw new Error(`找不到「${XLS_SHEET}」分頁`);
  const out = [];
  for (const a of xlsBlockStarts(grid)) {
    const day = parseXlsBlock(grid, a, ft.excelSerialToISO);
    if (!day.dailyRows.length && day.header.填報日期 == null) continue;     // 空白範本區塊
    if (isUnfilledBlock(day)) continue;
    out.push(day);
  }
  return out;
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest。PDF 樣本用**真實座標**(取自光復 fixture 第 2 頁,只換工程名稱)——
 * 自己編一組整齊的座標驗不到真實版面的形狀,而這裡最容易寫錯的正是
 * 「一個 item 橫跨四欄」與「當天沒填的欄連『-』都不印」這兩件事。
 * Excel 樣本則需 ft 建 grid 之外的 excelSerialToISO,由 registry 於驗證時傳入。
 */
function selfTest(ft) {
  const it = (x, y, w, s) => ({ x, y, w, s });
  const items = [
    it(238.6, 798.6, 118.1, '公共工程施工日誌'),
    it(39.4, 786.2, 57.5, '表報編號:'),
    it(144.6, 786.7, 31.2, '本日天氣:'),
    it(183.2, 786.2, 108.4, '上午:   晴  下午:  陰'),
    it(399.7, 786.6, 51.1, '填報日期:'),
    it(469.0, 786.6, 68.3, '113年11月28日星期四'),
    it(399.7, 776.6, 49.1, '承攬廠商名稱'),
    it(473.9, 776.6, 58.6, '長澤營造有限公司'),
    it(39.4, 771.7, 61.3, '工程名稱'),
    it(95.0, 771.7, 151.0, '測試工程'),
    it(416.4, 756.7, 131.2, '開  工  日  期 113年11月27日'),
    it(39.4, 746.7, 232.8, '預定進度(%)  0.40  實際進度(%)'),
    it(326.2, 746.7, 17.7, '1.53'),
    it(203.9, 726.8, 29.3, '施工項目'),
    it(399.7, 726.4, 153.4, '單位 契約數量 本日完成  累計完成 備註'),
    it(39.4, 716.8, 43.9, '一直接工程費'),
    // 第 1 列:本日完成整欄沒印(廠商當天沒填,連「-」都沒有)——靠 token 順序會把
    // 累計的 1.00 當成本日完成。
    it(39.4, 706.6, 184.6, '工程告示牌'),
    it(403.0, 706.3, 44.8, '式   1.00'),
    it(519.5, 706.3, 13.4, '1.00'),
    // 第 2 列:四欄擠在同一個 item 裡。
    it(39.4, 686.7, 135.6, '施工動線開闢及損壞復原(含雜項工程)'),
    it(403.0, 686.4, 130.0, '式   1.00    0.10    0.30'),
    // 第 3 列:pdfjs 把單位與數字之間的空白吃掉了,w 卻仍含空白寬度(67.9 對 5 個字)。
    // 均分推出來的中心會落到契約數量欄,單位與契約數量雙雙變 null,該列被誤判成大類,
    // 其後的項次整批位移——真實座標,取自光復第 4 頁的「職業安全衛生管理費」。
    it(39.4, 447.7, 112.0, '職業安全衛生管理費(壹*1%)'),
    it(403.0, 447.3, 67.9, '式1.00'),
    it(476.9, 447.3, 13.4, '0.02'),
    it(519.5, 447.3, 13.4, '0.03'),
    it(39.4, 399.0, 99.7, '(營造業專業工程特定施工項目)'),
    it(39.4, 329.6, 49.0, '別  本日人數'),
    it(196.6, 329.6, 29.3, '累計人數'),
    it(268.9, 329.6, 7.3, '機'),
    it(390.0, 329.6, 48.7, '稱  本日使用'),
    it(477.4, 329.6, 29.3, '累計使用'),
    // 機械工當天沒出工:只印了累計那一欄(x229.4),本日人數必須是 null 不是 0.00。
    it(39.4, 319.6, 116.9, '機械工'),
    it(229.4, 319.6, 12.1, '0.00'),
    it(268.9, 319.6, 181.7, '挖掘機'),
    it(518.9, 319.6, 12.1, '0.00'),
    it(39.4, 289.8, 116.9, '普通工'),
    it(161.5, 289.8, 12.1, '2.00'),
    it(229.4, 289.8, 12.1, '6.00'),
    it(39.4, 279.6, 450.3, '四、本日施工項目是否有須依「營造業專業工程特定施工項目'),
  ];
  const day = parsePage(items);
  if (day.header.填報日期 !== '2024-11-28') return false;
  if (day.header.星期 !== '星期四') return false;
  if (day.header.工程名稱 !== '測試工程') return false;
  if (day.header.天氣_上午 !== '晴' || day.header.天氣_下午 !== '陰') return false;
  if (day.header.預定進度 !== 0.4 || day.header.實際進度 !== 1.53) return false;
  if (day.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (day.header.開工日期 !== '2024-11-27') return false;
  if (day.dailyRows.length !== 4) return false;
  const [cat, r1, r2, r3] = day.dailyRows;
  if (cat.項次 !== null || cat.單位 !== null) return false;          // 大類列不佔項次
  if (r1.項次 !== '1' || r1.單位 !== '式' || r1.契約數量 !== 1) return false;
  if (r1.本日完成數量 !== null) return false;                        // 沒印就是 null,不是 0
  if (r1.累計完成數量 !== 1) return false;                           // 靠順序會錯放到本日
  if (r2.項次 !== '2' || r2.本日完成數量 !== 0.1 || r2.累計完成數量 !== 0.3) return false;
  if (r2.契約單價 !== null || r2.本日完成金額 !== null) return false; // PDF 版面沒有金額
  // 黏連列:單位與契約數量都要拆出來,否則它會被當成大類而讓後面的項次整批位移。
  if (r3.項次 !== '3' || r3.單位 !== '式' || r3.契約數量 !== 1) return false;
  if (r3.本日完成數量 !== 0.02 || r3.累計完成數量 !== 0.03) return false;
  if (day.header.出工總人數 !== 2) return false;                     // 只算本日人數欄
  const 機械工 = (day.extras.出工明細 || []).find((c) => c.工別 === '機械工');
  if (!機械工 || 機械工.人數 !== null) return false;                 // 累計欄不可當本日

  // 表頭被切成三個 item 的變體(光復「11月日報表(修)1203.pdf」),真實座標。
  // 只認單一 item 的話這份會抓不到欄界,4 天的明細整批讀不到。
  const split = [
    it(215.5, 739.9, 32.6, '施工項目'),
    it(437.5, 739.5, 8.2, '單'),
    it(445.7, 739.5, 8.2, '位'),
    it(454.7, 739.5, 130.8, '契約數量本日完成 累計完成 備註'),
    it(27.4, 728.2, 49.0, '一直接工程費'),
    it(27.4, 716.6, 184.6, '工程告示牌'),
    it(441.6, 716.2, 122.9, '式   1.00   1.00    1.00'),
    it(27.4, 705.0, 54.0, '施工圍籬(租用)'),
    it(442.3, 704.6, 122.2, 'M  158.00  158.00   158.00'),
  ];
  const d2 = parsePage(split);
  if (d2.dailyRows.length !== 3) return false;
  const [, s1, s2] = d2.dailyRows;
  if (s1.單位 !== '式' || s1.契約數量 !== 1 || s1.本日完成數量 !== 1 || s1.累計完成數量 !== 1) return false;
  if (s2.單位 !== 'M' || s2.契約數量 !== 158 || s2.本日完成數量 !== 158 || s2.累計完成數量 !== 158) return false;

  // ── Excel 路徑 ──
  const grid = [];
  const set = (r, c, v) => { (grid[r] = grid[r] || [])[c] = v; };
  set(0, 0, '表報編號：'); set(0, 5, '晴'); set(0, 7, '陰'); set(0, 11, 45944);
  set(1, 1, '測試工程'); set(1, 11, META_VENDOR_KEY);
  set(4, 12, 45944);
  set(5, 2, 0.5); set(5, 7, 0.6027034782912103);
  // 大類列在來源是橫跨欄 0~13 的合併儲存格,合併填充後單位欄也是「直接工程」。
  for (let c = 0; c <= 13; c++) set(7, c, '直接工程');
  set(8, 0, '工程告示牌與職安告示牌(租用)'); set(8, 9, '式');
  set(8, 10, 1); set(8, 11, 1); set(8, 12, 1); set(8, 15, 3128); set(8, 16, 3128);
  set(9, 0, '施工管制措施(租用)'); set(9, 9, '式');
  set(9, 10, 1); set(9, 11, 0.2); set(9, 12, 0.2); set(9, 15, 44000); set(9, 16, 8800);
  set(11, 0, '工別'); set(11, 7, '機具名稱');
  set(12, 0, '機械工'); set(12, 4, 0); set(12, 7, '挖掘機'); set(12, 9, 0);
  set(13, 0, '普通工'); set(13, 2, 4); set(13, 4, 4); set(13, 7, '破碎機'); set(13, 9, 0);
  const serial = ft && typeof ft.excelSerialToISO === 'function' ? ft.excelSerialToISO : null;
  const x = parseXlsBlock(grid, 0, serial);
  if (x.header.工程名稱 !== '測試工程') return false;
  if (x.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (serial && x.header.填報日期 !== '2025-10-14') return false;
  if (xlsBlockStarts(grid).join(',') !== '0') return false;          // 「表報編號：」也要認得
  if (x.dailyRows.length !== 3) return false;
  if (x.dailyRows[0].項次 !== null) return false;                    // 「直接工程」是大類
  if (x.dailyRows[0].單位 !== null) return false;                    // 合併填充的「直接工程」不是單位
  if (x.dailyRows[1].項次 !== '1' || x.dailyRows[1].契約單價 !== 3128) return false;
  if (x.dailyRows[2].本日完成金額 !== 8800) return false;            // 44000×0.2,交叉核對過
  if (x.header.出工總人數 !== 4) return false;                       // 機械工本日欄空 → 不計
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
  // 供測試直接驗純函式
  _internal: { parsePage, parseXlsBlock, detectValueColumns, linesFromItems, numOf, rocToISO },
};
