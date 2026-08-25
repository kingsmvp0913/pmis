/**
 * fusen.pmisparser.js — 富森土木包工業(四湖國小)施工日誌讀取器
 *
 * 來源:`富森四湖國小-6月施工日誌 2.pdf`,244 頁 = 前 6 頁基本資料/附表 + 238 個日誌頁。
 *
 * ── 版面事實(實測)──
 * 日誌頁頂端是「雲林縣四湖鄉四湖國民小學」,每頁一天。依 x 分欄:
 *   項次 <75 / 施工項目 75~235 / 單位 235~270 / 契約數量 270~320 /
 *   本日完成數量 320~395 / 累計完成數量 395~490 / 備註 490~
 *
 * **此格式的明細只有 6 欄**:沒有契約單價,也沒有本日完成金額。兩者一律 null
 * 不硬湊——SP3 會因此把 B3/B4/C2 列入 skipped 並在報告中說明,而不是靜默當作通過。
 *
 * ── 名稱跨行的方向不只一種 ──
 * 項目名稱過長時會拆列,而且**上一列與下一列都可能是它的片段**(實測項次 1:
 * 「乙種施工圍籬、警示帶、安全警示燈」在上、項次列本身的名稱欄是空的、
 * 「安全措施(租用)」在下)。只往前接或只往後接都會得到殘缺名稱,故採「遇到下一個
 * 項次列才收束」的作法。
 */

const META_VENDOR_KEY = '富森土木包工業';

const Y_TOL = 4;
const X = { 項次: 75, 名稱: 235, 單位: 270, 契約數量: 320, 本日: 395, 累計: 490 };
const ITEM_NO_RE = /^(\d+|[壹貳參参肆伍陸柒捌玖拾])$/;
const NUM_RE = /-?\d{1,3}(?:,\d{3})*(?:\.\d+)?/g;
const DASH_RE = /^[-－—–]+$/;

const text = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s === '' || DASH_RE.test(s) ? null : s;
};

function numOf(v) {
  const s = v == null ? '' : String(v).replace(/[,\s　%]/g, '');
  if (s === '' || DASH_RE.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function groupRows(items) {
  const buckets = [];
  for (const it of (items || []).filter((i) => String(i.s || '').trim())
    .slice().sort((a, b) => b.y - a.y)) {
    let b = buckets.find((k) => Math.abs(k.y - it.y) <= Y_TOL);
    if (!b) { b = { y: it.y, items: [] }; buckets.push(b); }
    b.items.push(it);
  }
  return buckets.map((b) => ({ y: b.y, items: b.items.sort((p, q) => p.x - q.x) }));
}

const between = (row, lo, hi) => row.items
  .filter((i) => i.x >= lo && i.x < hi)
  .map((i) => i.s)
  .join(' ')
  .trim();

const first = (s) => {
  const m = String(s || '').match(NUM_RE);
  return m ? numOf(m[0]) : null;
};

/**
 * 明細列。**名稱片段以項次列為中心、上下對稱分佈**(實測 fixture 的項次 4:
 * 前段在上一列、中段與項次列只差 1 個 y 而被 Y_TOL 併進項次列本身、後段在下一列)。
 *
 * 因此片段歸屬一律看「離哪個項次列最近」,不可用「本列名稱欄有沒有值」二選一——
 * 舊作法遇到「上面一段 + 併入一段 + 下面一段」時,會把前段送給上一個項次、
 * 後段送給下一個項次,**兩邊的名稱都是錯的**;而且名稱錯不會讓任何欄位變 null,
 * 完整性關卡完全看不到(見 scripts/check-parser.js 的名稱形狀健檢)。
 */
// 把名稱欄的 items 依原始 y 收成片段(同一個 y 的多個 item 併成一段)。
function nameSegments(items, x) {
  const byY = new Map();
  for (const i of items) {
    if (i.x < x.項次 || i.x >= x.名稱) continue;
    const s = text(i.s);
    if (!s) continue;
    byY.set(i.y, (byY.get(i.y) || '') + s);
  }
  return [...byY.entries()].map(([y, s]) => ({ y, s }));
}

function collectRows(rows) {
  const anchors = [];   // 項次列
  const frags = [];     // 待歸屬的名稱片段
  // 公誠國小版型的左半表格整體右移約 25pt；依表頭位置選欄界，避免影響既有四湖格式。
  const shifted = rows.some((r) => r.items.some((i) => (
    (String(i.s || '').trim() === '項次' && i.x >= 90)
    || (i.x >= 95 && i.x < 115 && ITEM_NO_RE.test(String(i.s || '').trim()))
  )));
  const x = shifted ? { 項次: 110, 名稱: 245, 單位: 270, 契約數量: 320, 本日: 395, 累計: 490 } : X;

  // 資料區從表頭列(項次/施工項目/單位…)之下開始。**頁首的校名、天氣、工程名稱、
  // 工期、進度等文字也落在名稱欄的 x 範圍內**,不設這條界線就會被當成名稱片段
  // 吸進第一個項次(實測:項次1 的名稱變成「雲林縣四湖鄉四湖國民小學9下午:上午:晴…」)。
  //
  // ⚠️ **一天佔兩頁,而續頁重印頁首卻沒有明細表頭**(實測頁 7:校名/天氣/工程名稱/
  // 核定工期/開工日期/預定進度全都重印一次,表頭列不見)。只認表頭列的話續頁的
  // 上界是 Infinity,整段頁首就被當成名稱片段黏到該頁的第一個項次上——
  // 實測 69 天裡 61 天的項次 31、8 天的項次「貳」名稱前面掛著
  // 「雲林縣四湖鄉四湖國民小學9下午:上午:晴…開工日期2025/4/231.35%」。
  // **這種名稱括號是平衡的、長度也夠,名稱形狀健檢完全看不到。**
  // 故上界改取「表頭列」與「頁首各標籤列」之中最低的那一條。
  // ⚠️ 標籤比對**只能看最上面那個項次列以上的列**:表尾註記寫著
  // 「…預定進度及實際進度應填變更設計後計算之進度。」也會命中,取全頁最低的一條
  // 會把上界壓到 y=161.9,整頁明細一列不剩(實測會掉掉每天的貳~陸)。
  const 是項次 = (i) => i.x < x.項次 && ITEM_NO_RE.test(String(i.s || '').trim());
  const 項次Ys = rows.filter((r) => r.items.some(是項次)).map((r) => r.y);
  const 最上項次 = 項次Ys.length ? Math.max(...項次Ys) : -Infinity;
  const 頁首標籤 = /表報編號|本日天氣|工程名稱|核定工期|開工日期|預定進度|承攬廠商名稱/;
  let 資料區上界 = Infinity;
  let 資料區下界 = -Infinity;
  for (const r of rows) {
    const t = r.items.map((i) => i.s).join('');
    if (/二、工地材料管理概況|材料名稱/.test(t)) 資料區下界 = Math.max(資料區下界, r.y);
    if (r.y <= 最上項次) continue;
    const 是表頭 = /項次/.test(t) && /施工項目/.test(t);
    if (是表頭 || 頁首標籤.test(t)) 資料區上界 = Math.min(資料區上界, r.y);
  }

  for (const row of rows) {
    if (row.y >= 資料區上界 || row.y <= 資料區下界) continue;
    const 項次item = row.items.find((i) => i.x < x.項次 && ITEM_NO_RE.test(String(i.s || '').trim()));
    const segs = nameSegments(row.items, x);
    if (!項次item) { frags.push(...segs); continue; }

    // 名稱 item 與項次 item 幾乎同高**不代表同一列**:這個版面把數值垂直置中於
    // 名稱區塊,所以多行名稱的中間那行必然與數值同高(項次4 的名稱三行是
    // 570/561/552,數值在 560.1)。曾試過用 y 差判「自足」,反而把常見情況判錯。
    // 一律當片段,由下方的「最近錨點」統一分配。
    frags.push(...segs);
    anchors.push({
      y: row.y,
      項次: String(項次item.s).trim(),
      單位: text(between(row, x.名稱, x.單位)),
      契約單價: null,        // 此格式不提供
      契約數量: first(between(row, x.單位, x.契約數量)),
      本日完成數量: first(between(row, x.契約數量, x.本日)),
      本日完成金額: null,    // 此格式不提供
      累計完成數量: first(between(row, x.本日, x.累計)),
      frags: [],
    });
  }
  if (!anchors.length) return [];

  // ⚠️ **「歸給 y 最近的項次列」不夠**——名稱塊會長過與鄰居的中點。
  // 實測項次 28「緊急求救按鈕…」跨四行(163.1 / 153.1 / 值 147.9 / 143.2 / 133.2),
  // 塊高 30pt 而列距只有 13~26:最外那行 163.1 離項次 27(174.0)只有 10.9、
  // 離自己 15.2,於是被 27 搶走,同理 133.2 被 29 搶走。
  // 結果**兩個項目的名稱黏在一起**(「給排水系統配管與安裝(連工帶料)緊急求救按鈕(含閃光…」)
  // ——名稱錯不會讓任何欄位變 null,完整性關卡看不到。
  //
  // 改用**對稱配對**:數值本來就印在名稱塊的垂直中央(這是此版面的既有事實,
  // 檔頭已經寫了),所以一個項次列每次只能「一上一下同時收一段」,
  // 而且兩段離它的距離要差不多。項次 27 的名稱在自己那列、上下沒有成對的片段,
  // 自然一段也收不到——這正是要的。
  const 已配 = new Set();
  const 中間有錨點 = (a, f) => anchors.some((x) => x !== a
    && (x.y - a.y) * (x.y - f.y) < 0);
  // 與項次列同高的片段是它自己的(多行名稱的中間那行必然與數值同高)
  for (const a of anchors) {
    for (const f of frags) {
      if (已配.has(f) || Math.abs(f.y - a.y) > Y_TOL) continue;
      已配.add(f); a.frags.push(f);
    }
  }
  // ⚠️ 收編的**順序**會決定結果:同一段可能同時是兩個項次列的合法候選,先跑的先拿。
  // 實測項次 29 在第一輪就把 133.2 拿走,害項次 28 第二輪湊不成對稱、
  // 163.1 與 133.2 雙雙落到 fallback,名稱又黏在一起。
  // 優先權給「自己那列**沒有**名稱」的項次——它的名稱一定在別的帶,非收不可;
  // 自己那列已經有名稱的(項次 27 那種完整單行)排後面,通常什麼也收不到,那正是對的。
  const 自己沒名稱 = (a) => a.frags.length === 0;
  const 依優先 = anchors.slice().sort((p, q) => (自己沒名稱(q) ? 1 : 0) - (自己沒名稱(p) ? 1 : 0));
  const SYM_TOL = 6;
  const 收完 = new Set();
  for (let k = 1; k <= 4; k++) {
    for (const a of 依優先) {
      if (收完.has(a)) continue;
      const free = frags.filter((f) => !已配.has(f) && !中間有錨點(a, f));
      const up = free.filter((f) => f.y > a.y).sort((p, q) => p.y - q.y)[0];
      const dn = free.filter((f) => f.y < a.y).sort((p, q) => q.y - p.y)[0];
      if (!up || !dn || Math.abs((up.y - a.y) - (a.y - dn.y)) > SYM_TOL) { 收完.add(a); continue; }
      已配.add(up); 已配.add(dn);
      a.frags.push(up, dn);
    }
  }
  // 對稱配不上的片段**不可以靜靜丟掉**(那會讓名稱少一段而沒有任何欄位變 null),
  // 退回「最近的錨點」。
  for (const f of frags) {
    if (已配.has(f)) continue;
    let best = anchors[0];
    for (const a of anchors) if (Math.abs(a.y - f.y) < Math.abs(best.y - f.y)) best = a;
    best.frags.push(f);
  }

  return anchors.map((a) => ({
    項次: a.項次,
    // 依版面由上而下(y 由大到小)接合,否則長名稱會前後顛倒
    工程項目: a.frags.slice().sort((p, q) => q.y - p.y).map((f) => f.s).join('') || null,
    單位: a.單位,
    契約單價: a.契約單價,
    契約數量: a.契約數量,
    本日完成數量: a.本日完成數量,
    本日完成金額: a.本日完成金額,
    累計完成數量: a.累計完成數量,
  }));
}

/** 西元「2026年4月23日」或「2025/4/23」→ ISO。此格式用西元,不需民國換算。 */
function toISO(s) {
  const t = String(s == null ? '' : s).replace(/[\s　]/g, '');
  let m = /(\d{4})年(\d{1,2})月(\d{1,2})/.exec(t);
  if (!m) m = /(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(t);
  if (!m) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${m[1]}-${p(Number(m[2]))}-${p(Number(m[3]))}`;
}

function parseHeader(rows) {
  const flat = rows.map((r) => r.items.map((i) => i.s).join(' '));
  const all = flat.join('\n');
  const 找 = (re) => { const m = re.exec(all); return m ? m[1] : null; };
  const 天氣列 = flat.find((l) => /本日天氣/.test(l)) || '';
  const wm = /上午[:：]?\s*(\S+)?.*?下午[:：]?\s*(\S+)?/.exec(天氣列.replace(/\s{2,}/g, ' ')) || [];

  return {
    工程名稱: 找(/工程名稱\s+(\S+)/),
    填報日期: toISO(找(/填報日期[:：]?\s*(\S+)/)),
    星期: 找(/(星期[一二三四五六日天])/),
    天氣_上午: text(wm[1]),
    天氣_下午: text(wm[2]),
    預定進度: numOf(找(/預定進度\(%\)\s+([\d.]+)%?/)),
    實際進度: numOf(找(/實際進度\(%\)\s+([\d.]+)%?/)),
    出工總人數: null,
    本日累計金額: null,
    承包廠商: 找(/承攬廠商名稱\s+(\S+)/),
    開工日期: toISO(找(/開工日期\s+(\S+)/)),
  };
}

// 日誌頁的判定:含「表報編號」與「填報日期」兩個標籤。前 6 頁的基本資料編與
// 附表沒有這兩者,靠它排除,不必寫死頁碼。
const isLogPage = (rows) => rows.some((r) => /表報編號/.test(r.items.map((i) => i.s).join('')))
  && rows.some((r) => /填報日期/.test(r.items.map((i) => i.s).join('')));

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft) throw new Error('缺少 ctx.filetypes(檔型工具需由 registry 注入)');
  const pages = await ft.extractItems(filePath);
  // 一天的明細放不下時會續到下一頁,兩頁的填報日期相同(實測 238 頁 = 119 天)。
  // 不合併的話每一天都會被當成兩天:D1「同一天出現兩次」119 次,而且每頁各自
  // 只有一半的項目,與契約表逐項比對時整份都判不一致。
  const byDate = new Map();
  const order = [];
  let currentKey = null;
  for (const p of pages) {
    const rows = groupRows(p.items);
    const dailyRows = collectRows(rows);
    if (isLogPage(rows)) {
      const header = parseHeader(rows);
      const key = header.填報日期 || `page-${p.page}`;
      if (!byDate.has(key)) {
        byDate.set(key, { header, dailyRows: [], extras: {} });
        order.push(key);
      }
      byDate.get(key).dailyRows.push(...dailyRows);
      currentKey = key;
    } else if (currentKey && dailyRows.length) {
      // 公誠國小的第二頁只續列工程費,沒有表報編號/填報日期；併到緊接的日誌頁。
      byDate.get(currentKey).dailyRows.push(...dailyRows);
    }
  }
  return order.map((k) => byDate.get(k));
}

async function parse(filePath, ctx) {
  const all = await parseAll(filePath, ctx);
  return all[0] || null;
}

function selfTest() {
  // 第三個元素可指定該 item 自己的 y(groupRows 合併鄰近列後,items 仍保有原始 y);
  // 省略則同該列的 y。項次 4 就靠這個表達「名稱 y=561、項次 y=560」的真實形狀。
  const mk = (y, arr) => ({ y, items: arr.map(([x, s, iy]) => ({ x, y: iy == null ? y : iy, s })) });
  // 座標**取自 fixture 實測**(2026-05 的日誌頁,項次 4/5),不是編的。
  // 自己編一組等距的會驗不到真實版面的兩個形狀:①名稱片段以項次列為中心上下分佈
  // ②其中一段的 y 與項次列只差 1,會先被 Y_TOL 併進項次列本身。
  const rows = [
    // 頁首:校名/天氣等也落在名稱欄的 x 範圍內,必須被表頭列擋在資料區外
    mk(700, [[220, '雲林縣四湖鄉四湖國民小學']]),
    mk(680, [[112, '上午:'], [145, '晴']]),
    mk(669, [[56, '項次'], [140, '施工項目'], [239, '單位'], [272, '契約數量']]),
    mk(600, [[60, '壹'], [81, '直接工程費']]),
    mk(570, [[81, '既有地坪、磁磚、衛生設備、給排水設施']]),
    mk(561, [[81, '、搗擺及天花板等拆除(含切割)及運棄(含'], [62, '4', 560],
      [243, '式', 560], [294, '1.00', 560], [369, '0.05', 560], [448, '0.40', 560]]),
    mk(552, [[81, '合法證明);環境保護與清潔']]),
    mk(534, [[81, '既有污水處理設施抽水肥(含清潔孔開']]),
    mk(529, [[62, '5'], [243, '式'], [294, '1.00'], [448, '0.00']]),
    mk(524, [[81, '挖與復原)']]),
  ];
  const out = collectRows(rows);
  const r4 = out.find((r) => r.項次 === '4');
  // 前段在上、中段被併進項次列、後段在下——三段都要接回同一個項次才是完整名稱
  if (!r4 || r4.工程項目 !== '既有地坪、磁磚、衛生設備、給排水設施、搗擺及天花板等拆除(含切割)及運棄(含合法證明);環境保護與清潔') return false;
  if (r4.單位 !== '式' || r4.契約數量 !== 1 || r4.本日完成數量 !== 0.05 || r4.累計完成數量 !== 0.4) return false;
  if (r4.契約單價 !== null || r4.本日完成金額 !== null) return false; // 此格式不提供
  const r5 = out.find((r) => r.項次 === '5');
  if (!r5 || r5.工程項目 !== '既有污水處理設施抽水肥(含清潔孔開挖與復原)') return false;
  const 壹 = out.find((r) => r.項次 === '壹');
  if (!壹 || 壹.單位 !== null || 壹.工程項目 !== '直接工程費') return false;
  if (toISO('2026年4月23日') !== '2026-04-23' || toISO('2025/4/23') !== '2025-04-23') return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.1.0',
    targetFields: [
      '工程名稱', '填報日期', '星期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約數量', '本日完成數量', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { groupRows, collectRows, parseHeader, toISO },
};
