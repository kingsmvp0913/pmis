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
 * 明細列。名稱片段可能落在項次列的上一列或下一列,故先收集再收束:
 * 遇到下一個項次列(或表尾)時,才把累積的片段接成完整名稱。
 */
function collectRows(rows) {
  const out = [];
  let cur = null;
  let pending = [];   // 尚未歸屬的名稱片段

  const push = (extra) => {
    if (!cur) return;
    cur.工程項目 = [cur.工程項目, ...extra].filter(Boolean).join('') || null;
    out.push(cur);
    cur = null;
  };

  for (const row of rows) {
    const 項次 = text(between(row, 0, X.項次));
    if (項次 != null && ITEM_NO_RE.test(項次)) {
      const 本列名稱 = text(between(row, X.項次, X.名稱));
      // 片段歸屬看的是**這一列自己的名稱欄有沒有值**:空的代表名稱被擠到上一列
      // (項次 1 就是如此),此時 pending 屬於本列;有值則代表 pending 是上一個
      // 項次的續行。只往前接或只往後接都會拼出別人的名稱。
      if (本列名稱 == null) push([]);
      else push(pending);
      const 前段 = 本列名稱 == null ? pending : [];
      pending = [];
      cur = {
        項次,
        工程項目: [...前段, 本列名稱].filter(Boolean).join('') || null,
        單位: text(between(row, X.名稱, X.單位)),
        契約單價: null,        // 此格式不提供
        契約數量: first(between(row, X.單位, X.契約數量)),
        本日完成數量: first(between(row, X.契約數量, X.本日)),
        本日完成金額: null,    // 此格式不提供
        累計完成數量: first(between(row, X.本日, X.累計)),
      };
      continue;
    }
    const seg = text(between(row, X.項次, X.名稱));
    if (seg) pending.push(seg);
  }
  push(pending);
  return out;
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
  for (const p of pages) {
    const rows = groupRows(p.items);
    if (!isLogPage(rows)) continue;
    const header = parseHeader(rows);
    const key = header.填報日期 || `page-${p.page}`;
    if (!byDate.has(key)) {
      byDate.set(key, { header, dailyRows: [], extras: {} });
      order.push(key);
    }
    byDate.get(key).dailyRows.push(...collectRows(rows));
  }
  return order.map((k) => byDate.get(k));
}

async function parse(filePath, ctx) {
  const all = await parseAll(filePath, ctx);
  return all[0] || null;
}

function selfTest() {
  const mk = (y, arr) => ({ y, items: arr.map(([x, s]) => ({ x, y, s })) });
  const rows = [
    mk(300, [[56, '項次'], [140, '施工項目'], [239, '單位'], [272, '契約數量']]),
    mk(290, [[60, '壹'], [81, '直接工程費']]),
    mk(280, [[81, '乙種施工圍籬、警示帶、安全警示燈']]),
    mk(270, [[62, '1'], [243, '式'], [294, '1.00'], [369, '1.00'], [448, '1.00']]),
    mk(260, [[81, '安全措施(租用)']]),
    mk(250, [[62, '2'], [81, '工程告示牌'], [243, '式'], [294, '1.00']]),
  ];
  const out = collectRows(rows);
  const r1 = out.find((r) => r.項次 === '1');
  // 名稱片段在項次列的上一列與下一列都有,只往一邊接會得到殘缺名稱
  if (!r1 || r1.工程項目 !== '乙種施工圍籬、警示帶、安全警示燈安全措施(租用)') return false;
  if (r1.單位 !== '式' || r1.契約數量 !== 1 || r1.累計完成數量 !== 1) return false;
  if (r1.契約單價 !== null || r1.本日完成金額 !== null) return false; // 此格式不提供
  const 壹 = out.find((r) => r.項次 === '壹');
  if (!壹 || 壹.單位 !== null) return false;
  if (toISO('2026年4月23日') !== '2026-04-23' || toISO('2025/4/23') !== '2025-04-23') return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
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
