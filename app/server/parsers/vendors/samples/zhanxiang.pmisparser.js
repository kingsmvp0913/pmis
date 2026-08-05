/**
 * zhanxiang.pmisparser.js — 展翔營造股份有限公司(仁德國小)施工日誌讀取器
 *
 * 來源:`展翔仁德國小施工日誌(115.06.26~115.06.30).pdf`,21 頁 = 5 天,
 * 每天 4 頁(封面/分隔 + 施工日誌 1 頁 + 第二聯 2 頁)。
 *
 * ── 只讀施工日誌頁,不讀第二聯 ──
 * 第二聯雖然有單價與金額,但**它沒有項目名稱**(只有數量/單價/金額三組數字),
 * 要對回項目只能靠列序,而各天的列數不一致——對錯一列,整份金額就掛到別的項目上,
 * 而且看起來完全正常。故契約單價與本日完成金額一律 null 不硬湊,
 * SP3 會據此把 B3/B4/C2 列入 skipped 並在報告中說明。
 *
 * ── 版面事實(實測第 2 頁)──
 * 明細表頭:施工項目 118 / 單位 222 / 契約數量 266 / 本日完成數量 337 /
 *           累計完成數量 421 / 備註 516。
 * **項次與名稱黏在同一格**(「1.乙種施工圍籬…」「伍、營造綜合保險費」),需拆。
 * 明細之後緊接「二、工地材料管理概況」的表格,欄位配置一模一樣——不在那裡停下來,
 * 材料會被當成施工項目收進去。
 */

const META_VENDOR_KEY = '展翔營造股份有限公司';

const Y_TOL = 4;
const X = { 名稱: 220, 單位: 262, 契約數量: 330, 本日: 415, 累計: 510 };
// 「1.乙種施工圍籬…」「伍、營造綜合保險費」——項次在前,以 . 或 、 分隔
const ITEM_HEAD_RE = /^(\d+|[壹貳參参肆伍陸柒捌玖拾])[.、．]\s*(.*)$/;
// 明細區的結束:接下來是材料管理、人員機具等段落,欄位配置與施工項目一樣
const SECTION_END_RE = /^[二三四五六七八九十]、/;
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

/**
 * 明細列。讀到「二、…」等下一個段落即停——材料管理表的欄位配置與施工項目
 * 一模一樣,不停下來就會把彈性防水材、水泥漆這些材料收成施工項目。
 */
function collectRows(rows) {
  const out = [];
  let started = false;
  for (const row of rows) {
    const head = between(row, 0, X.名稱);
    if (/施工項目/.test(head)) { started = true; continue; }   // 表頭
    if (!started) continue;
    if (SECTION_END_RE.test(head)) break;
    const m = ITEM_HEAD_RE.exec(head);
    if (!m) {
      // 名稱過長時原檔會拆列,而**單位與數字欄印在續行那一列**(實測項次 4:
      // 項次列只有名稱,M2/1.00 全在下一列)。不往下補的話,那些列會整排變 null,
      // 而名稱看起來完好——最難察覺的那種缺漏。
      const last = out[out.length - 1];
      if (last && head) {
        last.工程項目 = `${last.工程項目 || ''}${head}`;
        if (last.單位 == null) last.單位 = text(between(row, X.名稱, X.單位));
        if (last.契約數量 == null) last.契約數量 = numOf(between(row, X.單位, X.契約數量));
        if (last.本日完成數量 == null) last.本日完成數量 = numOf(between(row, X.契約數量, X.本日));
        if (last.累計完成數量 == null) last.累計完成數量 = numOf(between(row, X.本日, X.累計));
      }
      continue;
    }
    out.push({
      項次: m[1],
      工程項目: text(m[2]),
      單位: text(between(row, X.名稱, X.單位)),
      契約單價: null,        // 此格式的施工日誌頁不提供(見檔頭)
      契約數量: numOf(between(row, X.單位, X.契約數量)),
      本日完成數量: numOf(between(row, X.契約數量, X.本日)),
      本日完成金額: null,    // 同上
      累計完成數量: numOf(between(row, X.本日, X.累計)),
    });
  }
  return out;
}

/** 民國「115年6月26日」→ ISO。 */
function rocToISO(s) {
  const t = String(s == null ? '' : s).replace(/[\s　]/g, '');
  const m = /(\d{2,3})年(\d{1,2})月(\d{1,2})/.exec(t);
  if (!m) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${Number(m[1]) + 1911}-${p(Number(m[2]))}-${p(Number(m[3]))}`;
}

function parseHeader(rows) {
  const flat = rows.map((r) => r.items.map((i) => i.s).join(' '));
  const all = flat.join('\n');
  const 找 = (re) => { const m = re.exec(all); return m ? m[1] : null; };
  const 天氣列 = flat.find((l) => /本日天氣/.test(l)) || '';
  const wm = /上午\s*(\S+)?\s*下午\s*(\S+)?/.exec(天氣列.replace(/\s{2,}/g, ' ')) || [];

  return {
    工程名稱: 找(/工程名稱\s+(\S+)/),
    填報日期: rocToISO(找(/日期[:：]\s*(\S+)/)),
    星期: 找(/(星期[一二三四五六日天])/),
    天氣_上午: text(wm[1]),
    天氣_下午: text(wm[2]),
    預定進度: numOf(找(/預定進度\(%\)\s+([\d.]+)%?/)),
    實際進度: numOf(找(/實際進度\(%\)\s+([\d.]+)%?/)),
    出工總人數: null,
    本日累計金額: null,
    承包廠商: 找(/承攬廠商名稱\s+(\S+)/),
    開工日期: rocToISO(找(/開工日期\s+(\S+)/)),
  };
}

// 施工日誌頁的判定:有「表報編號」且**沒有**「第二聯」。第二聯的頁面也有明細
// 表格但沒有項目名稱,收進來只會產生一堆無名項目。
const isLogPage = (rows) => {
  const all = rows.map((r) => r.items.map((i) => i.s).join('')).join('');
  return /表報編號/.test(all) && !/第二聯/.test(all);
};

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft) throw new Error('缺少 ctx.filetypes(檔型工具需由 registry 注入)');
  const pages = await ft.extractItems(filePath);
  const out = [];
  for (const p of pages) {
    const rows = groupRows(p.items);
    if (!isLogPage(rows)) continue;
    out.push({ header: parseHeader(rows), dailyRows: collectRows(rows), extras: {} });
  }
  return out;
}

async function parse(filePath, ctx) {
  const all = await parseAll(filePath, ctx);
  return all[0] || null;
}

function selfTest() {
  const mk = (y, arr) => ({ y, items: arr.map(([x, s]) => ({ x, y, s })) });
  const rows = [
    mk(300, [[118, '施工項目'], [222, '單位'], [266, '契約數量']]),
    mk(290, [[52, '1.乙種施工圍籬、警示帶'], [227, '式'], [299, '1.00'], [384, '1.00'], [472, '1.00']]),
    mk(280, [[52, '伍、營造綜合保險費'], [227, '式'], [299, '1.00'], [384, '-'], [472, '1.00']]),
    mk(270, [[52, '二、工地材料管理概況']]),
    mk(260, [[52, '彈性防水材'], [226, 'M2'], [250, '199.00']]),
  ];
  const out = collectRows(rows);
  // 材料管理表的欄位與施工項目一樣,不在「二、」停下來就會把材料收成項目
  if (out.length !== 2) return false;
  if (out[0].項次 !== '1' || out[0].工程項目 !== '乙種施工圍籬、警示帶') return false;
  if (out[0].單位 !== '式' || out[0].契約數量 !== 1) return false;
  if (out[1].項次 !== '伍' || out[1].本日完成數量 !== null) return false;  // 「-」→ null
  if (out[0].契約單價 !== null || out[0].本日完成金額 !== null) return false;
  return rocToISO('115年6月26日') === '2026-06-26';
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
  _internal: { groupRows, collectRows, parseHeader, rocToISO },
};
