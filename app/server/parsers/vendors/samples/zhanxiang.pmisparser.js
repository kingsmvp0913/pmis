/**
 * zhanxiang.pmisparser.js — 展翔營造股份有限公司(仁德國小)施工日誌讀取器
 *
 * 來源:`展翔仁德國小施工日誌(115.06.26~115.06.30).pdf`,21 頁 = 5 天,
 * 每天 4 頁(封面/分隔 + 第一聯 1 頁 + **第二聯 2 頁**)。
 *
 * ── ⛔ v1.0.0 的重大錯誤:整個第二聯都沒讀 ──
 * 舊檔頭寫著「第二聯沒有項目名稱,只有數量/單價/金額三組數字」——**那是錯的**,
 * 名稱就印在 x=52。真正的分工是:
 *   第一聯 = 天氣/進度/工期 + **只列當天施作的項目**
 *   第二聯 = **完整清單**(項次 1~31 + 費用項),含契約數量、契約單價、
 *            本日完成數量與金額、累計完成數量與金額
 *
 * 只讀第一聯的後果(實測仁德 7 月檔 31 天):「整月只出現 2 個項目、每天 0.6 列、
 * 此格式不提供契約單價」。承辦人打開檔案一看就說「每天都是完整明細」。
 * 改讀第二聯之後:每天 37 列、缺欄位 0、單價與金額齊全。
 * **這種漏讀不會讓任何欄位變 null,也不會有任何錯誤訊息**——少的是整批列,
 * 而留下來的那幾列自己都對得起來,SP3 一條都不會叫。
 *
 * ── 版面事實 ──
 * 第二聯明細表頭:施工項目 x52 / 單位 x222 / 六個數值子欄由子表頭決定
 *   (契約數量 數量·單價 | 本日完成數量 數量·金額 | 累計完成數量 數量·金額)。
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

// 第一聯(有「表報編號」且沒有「第二聯」):天氣、進度、工期都在這裡。
const isLogPage = (rows) => {
  const all = rows.map((r) => r.items.map((i) => i.s).join('')).join('');
  return /表報編號/.test(all) && !/第二聯/.test(all);
};
const isSecondPage = (rows) => rows.some((r) => r.items.some((i) => /第二聯/.test(i.s)));

/* ═══════════════════════════════════════════════════════════════════
 *  第二聯
 *
 * ⛔ 舊版的檔頭寫著「第二聯沒有項目名稱,只有數量/單價/金額三組數字」,
 *    據此**整個第二聯都不讀**。那個判斷是錯的:名稱就印在 x=52,
 *    而且第二聯才是**完整清單**——第一聯逐日只列當天施作的項目。
 *
 * 實測仁德 7 月檔(31 天):只讀第一聯得到「整月只有 2 個項目、每天 0.6 列、
 * 沒有契約單價」;承辦人打開檔案一看就說「每天都是完整明細」。
 * 讀第二聯之後每天 20 項、單價與金額齊全。
 *
 * **這種漏讀不會讓任何欄位變 null,也不會有任何錯誤訊息**——少的是整批列,
 * 而剩下的那幾列自己都對得起來,SP3 一條都不會叫。
 *
 * ── 版面(實測 7/1 第二聯第 1 頁)──
 *   施工項目 x52 / 單位 x226 / 六個數值子欄由子表頭決定:
 *   契約數量 數量·單價 | 本日完成數量 數量·金額 | 累計完成數量 數量·金額
 * 一個 item 可能同時裝著兩個數字(「1.00    253,106.00」),要用 w/s.length
 * 推每個字元的 x 再取 token 中心歸欄——照 item 的起點歸欄會把單價當成數量。
 * ═══════════════════════════════════════════════════════════════════ */

const SUB_COLS = ['契約數量', '契約單價', '本日完成數量', '本日完成金額', '累計完成數量', '累計完成金額'];
const NUM_TOKEN_RE = /-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|[-－—–]/g;
const centerOf = (it) => it.x + (it.w || 0) / 2;

/** 把一個 item 裡的數字/破折號切成帶 x 中心的 token(見上方註解)。 */
function numTokens(it) {
  const s = String(it.s == null ? '' : it.s);
  const per = s.length ? (it.w || 0) / s.length : 0;
  const out = [];
  NUM_TOKEN_RE.lastIndex = 0;
  let m = NUM_TOKEN_RE.exec(s);
  while (m) {
    out.push({ t: m[0], cx: it.x + per * (m.index + m[0].length / 2) });
    m = NUM_TOKEN_RE.exec(s);
  }
  return out;
}

/** 子表頭那一列(數量 單價 數量 金額 數量 金額)→ 六個欄位中心。 */
function subColumns(rows) {
  for (const r of rows) {
    const labs = r.items.filter((i) => /^(數量|單價|金額)$/.test(String(i.s).trim()));
    if (labs.length >= 5) return labs.sort((a, b) => a.x - b.x).map(centerOf);
  }
  return null;
}

function parseSecondPage(rows) {
  const cols = subColumns(rows);
  if (!cols) return [];
  const 名稱右界 = 200;
  // ⚠️ **單位欄與第一個數值欄的界線要從表頭取,不可以用固定偏移。**
  // 單位是「M2」「M3」時裡面有數字:界劃得太左,那個 2 會被當成契約數量
  // (實測項次 7「砌1/2B磚牆」契約 28 被讀成 **2**,而 28.00 因為「先到先得」被丟掉);
  // 界劃得太右,單位「M」整格落進數值區、被當成沒有數字的 token 丟掉,
  // 單位變 null(實測項次 15)。兩種都不會有錯誤訊息。
  // 取「單位表頭中心」與「第一個數值欄中心」的中點。
  const 單位表頭 = rows.map((r) => r.items.find((i) => String(i.s).trim() === '單位'))
    .find(Boolean);
  const 值左界 = 單位表頭 ? (centerOf(單位表頭) + cols[0]) / 2 : cols[0] - 20;
  const out = [];
  let started = false;
  for (const row of rows) {
    const head = row.items.filter((i) => i.x < 名稱右界).map((i) => i.s).join('').trim();
    if (!started) { if (/施工項目/.test(head)) started = true; continue; }
    if (SECTION_END_RE.test(head)) break;

    const 單位 = text(row.items.filter((i) => i.x >= 名稱右界 && i.x < 值左界)
      .map((i) => i.s).join('').trim());
    const vals = {};
    for (const it of row.items.filter((i) => centerOf(i) >= 值左界)) {
      for (const tk of numTokens(it)) {
        let bi = 0;
        for (let i = 1; i < cols.length; i++) {
          if (Math.abs(cols[i] - tk.cx) < Math.abs(cols[bi] - tk.cx)) bi = i;
        }
        const key = SUB_COLS[bi];
        if (vals[key] === undefined) vals[key] = numOf(tk.t);
      }
    }

    const m = ITEM_HEAD_RE.exec(head);
    if (!m) {
      // 名稱續行:名稱補回去,值只補「還沒拿到的」——實測項次 4 的單位與全部數字
      // 都印在續行那一列,不補的話那一列整排 null 而名稱看起來完好。
      const last = out[out.length - 1];
      if (last) {
        // ⚠️ **補值不可以用「head 非空」當前提**。名稱換行時值自己佔一列
        // (實測項次 1:名稱 642.1 / 值 637.0 / 單位 636.4 / 名稱續行 631.6),
        // 那一列的名稱欄是空的 → 舊寫法整列跳過 → 項次 1、3 的單位與六個數值
        // 全部變 null,而名稱看起來完好。名稱只在 head 非空時才接。
        if (head) last.工程項目 = `${last.工程項目 || ''}${head}`;
        if (last.單位 == null) last.單位 = 單位;
        for (const k of ['契約數量', '契約單價', '本日完成數量', '本日完成金額', '累計完成數量']) {
          if (last[k] == null && vals[k] !== undefined) last[k] = vals[k];
        }
      }
      continue;
    }
    out.push({
      項次: m[1],
      工程項目: text(m[2]),
      單位,
      契約單價: vals.契約單價 === undefined ? null : vals.契約單價,
      契約數量: vals.契約數量 === undefined ? null : vals.契約數量,
      本日完成數量: vals.本日完成數量 === undefined ? null : vals.本日完成數量,
      本日完成金額: vals.本日完成金額 === undefined ? null : vals.本日完成金額,
      累計完成數量: vals.累計完成數量 === undefined ? null : vals.累計完成數量,
    });
  }
  return out;
}

/** 第二聯頁上的日期(用來與第一聯配對;一天有兩頁第二聯)。 */
const dateOfPage = (rows) => rocToISO(rows.map((r) => r.items.map((i) => i.s).join('')).join(''));

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft) throw new Error('缺少 ctx.filetypes(檔型工具需由 registry 注入)');
  const pages = await ft.extractItems(filePath);
  const 第一聯 = [];                 // { 日期, header }
  const 第二聯 = new Map();          // 日期 → dailyRows(一天兩頁,要接起來)
  for (const p of pages) {
    const rows = groupRows(p.items);
    if (isSecondPage(rows)) {
      const 日 = dateOfPage(rows);
      if (!日) continue;
      const cur = 第二聯.get(日) || [];
      cur.push(...parseSecondPage(rows));
      第二聯.set(日, cur);
      continue;
    }
    if (!isLogPage(rows)) continue;
    const header = parseHeader(rows);
    第一聯.push({ 日期: header.填報日期, header, rows });
  }
  if (!第一聯.length) throw new Error('讀不到任何「表報編號」頁(非展翔格式?)');

  // 明細一律取第二聯(完整清單)。某一天的第二聯缺頁時**退回第一聯那一天的列**,
  // 不回空陣列——空陣列會被上游當成「這天沒施工」而靜靜略過,而實際上是缺頁。
  return 第一聯.map(({ 日期, header, rows }) => ({
    header,
    dailyRows: 第二聯.get(日期) || collectRows(rows),
    extras: {},
  }));
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
    version: '2.0.0',
    targetFields: [
      '工程名稱', '填報日期', '星期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約數量', '契約單價',
      '本日完成數量', '本日完成金額', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { groupRows, collectRows, parseHeader, rocToISO, parseSecondPage },
};
