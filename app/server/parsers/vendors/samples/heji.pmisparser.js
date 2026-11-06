/**
 * heji.pmisparser.js — 禾吉土木包工業施工日誌讀取器(長福國小老舊廁所整修)
 *
 * ⚠️ 別和 `hejie`(禾結土木包工業)搞混,兩家只差一個字、版面完全不同。
 *
 * vendorKey 取自日誌每一頁的「承攬廠商名稱」與承辦人提供的檔名
 * `(禾吉土木包工業)1151022-1151031-施工日誌-長福國小….pdf`。
 *
 * ── 版面事實(實測 1151022-1151031,20 頁 = 10 天 × 2 頁)──
 * 有文字層的 PDF,一天兩頁,**兩頁都印同一份表頭**(表報編號、填報日期…):
 *   頁 1  表頭 + 「一、依施工計畫執行…」施工項目表
 *   頁 2  表頭 + 特定施工項目 A./B.(空白範本)+ 材料表 + 人員機具
 * 兩頁依填報日期併成一天。
 *
 * ── 施工項目表是**左右兩組並排**──
 *   左 表頭 x: 施工項目59 單位143 契約數量173 本日完成216 累計完成257
 *   右 表頭 x: 施工項目332 單位410 契約數量436 本日完成477 累計完成518 備註558
 * 左邊 16 列、右邊 15 列,每天都印完整清單(沒施作的數量欄空白)。
 * **沒有項次欄、沒有單價與金額**。項次用「左欄由上而下、再右欄由上而下」的
 * **出現序**(先例 以勒/德信):每天同一份清單同一個順序,出現序是穩定的位置事實。
 * 費用項(職業安全衛生管理費…營業稅)也照出現序編號,SP3 以費用名目認得它們。
 *
 * 值靠右對齊、表頭靠左,值的中心落在自己表頭起點與下一欄表頭起點之間
 * (左累計值 c285 在 [257,295)),所以欄界用**表頭起點**。
 *
 * ── 名稱跨行,數值印在整塊名稱的**垂直中央** ──
 * 「既有地坪、台階…」四行 573.9/562.7/551.5/540.3,單位與數值在 556.4(二、三行之間);
 * 「施工動線開闢…」三行 616.3/603.8/591.5,數值 603.6(與中間那行同帶)。
 * 「離最近的數值列」在高矮格相鄰時會選錯(右欄「施做緊急求救按鈕」五行,第一行
 * 離自己的數值 25.2、離上一列 26.8,只差 1.6),所以用**對稱分配**:由上往下,
 * 每一列先把「上一列在它上方收了幾行」原數還給上一列當下方,剩下的才是自己的上方。
 * 見 `assignNames`。
 *
 * ── 一個字型缺字:10/29 那兩頁 ──
 * 第 15、16 頁的「115年10月2?日」與「?日曆天」,數字被抽成控制字元
 * (`\u001c`、`\u001b`),**PDF 文字層本身就是這樣**。不硬猜:只有在
 * ①日期萬用比對 ②印出的星期 ③開工日期 + (核定工期 − 剩餘工期) − 1
 * 三者交集**恰好一個日期**時才採用(實測交集 = 2026-10-29),否則填報日期留 null。
 *
 * ── 照收不修的來源值 ──
 * 「職業安全衛生管理費)」多一個右括號;費用項的本日/累計是比例(0.010);
 * 營造綜合保險費本日印 1.000、累計印 1.00。進度印百分數(0.35%),照收不換算。
 *
 * ── 人員機具三組並排 ──
 *   表頭 x: 人員機具57/245/445 本日人機數140/298/497 累計人機數196/365/538
 * 第三組混著「油漆工、機械操作工」與「挖土機、傾卸機」:名稱以「機」結尾的
 * 收進主要機具,其餘收進出工明細。只收本日有數字的。
 */

const META_VENDOR_KEY = '禾吉土木包工業';

const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'kg', '噸', 'T',
  '公尺', '公斤', '平方公尺', '立方公尺', '場', '座', '組', '支', '個', '只', '片',
  '面', '處', '間', '棵', '株', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '才', '天', '日', '人']);

// 一列的各段 y 差不到 1(數值 660.7、單位 660.2),列距 ≥ 12。
const BAND = 2;
// 名稱行與數值帶相差 ≤ 3 才算「同一行」(實測 0.2~0.8;兩行名稱夾數值時差 5~7)。
const OWN_LINE = 3;

const nfkc = (v) => String(v == null ? '' : v).normalize('NFKC');
const despace = (v) => nfkc(v).replace(/[\s　]/g, '');

function text(v) {
  const s = nfkc(v).replace(/[\r\n]+/g, '').trim();
  return s === '' || /^-+$/.test(s) || s === '－' ? null : s;
}

function num(v) {
  const s = nfkc(v).replace(/[,\s　%]/g, '');
  if (s === '' || /^-+$/.test(s) || s === '－') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const unitOf = (v) => {
  const s = despace(v);
  return s && KNOWN_UNITS.has(s) ? s : null;
};

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** 民國「115年10月22日」→ ISO。 */
function rocToISO(v) {
  const m = despace(v).match(/(\d{2,3})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  return iso(Number(m[1]) + 1911, Number(m[2]), Number(m[3]));
}

/** 以 `w / s.length` 推每個字元的 x,切成 {s, x, c}。 */
function tokensOf(it) {
  const s = String(it.s);
  const cw = s.length ? it.w / s.length : 0;
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(s))) {
    const x = it.x + m.index * cw;
    out.push({ s: m[0], x, c: x + (m[0].length * cw) / 2, y: it.y });
  }
  return out;
}

/** 依 y 分帶(由上而下)。 */
function bands(items, tol = BAND) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const out = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - it.y) <= tol) last.items.push(it);
    else out.push({ y: it.y, items: [it] });
  }
  for (const b of out) b.items.sort((a, c) => a.x - c.x);
  return out;
}

const findItem = (items, re) => items.find((i) => re.test(despace(i.s)));
/** 標籤右邊、同一帶、x 在 [label 右緣, xMax) 的值。 */
function rightOf(items, label, xMax = Infinity) {
  if (!label) return null;
  const vals = items.filter((i) => i !== label && Math.abs(i.y - label.y) <= BAND
    && i.x >= label.x + label.w - 1 && i.x < xMax).sort((a, b) => a.x - b.x);
  return text(vals.map((i) => i.s).join('')) || null;
}

/**
 * 字型缺字時(數字被抽成控制字元)的填報日期還原:三個來源欄位的交集恰好一天才採用。
 */
function recoverDate(raw, 星期, 開工, 核定, 剩餘) {
  const s = despace(raw);
  if (!/[\u0000-\u001f]/.test(s)) return null;
  const pat = s.replace(/[\u0000-\u001f]/g, '\\d');
  const m = s.match(/^(.*?)年/);
  if (!m) return null;
  const want = 開工 && 核定 != null && 剩餘 != null ? (() => {
    const d = new Date(`${開工}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + (核定 - 剩餘) - 1);
    return d.toISOString().slice(0, 10);
  })() : null;
  if (!want) return null;
  const [y, mo, da] = want.split('-').map(Number);
  const roc = `${y - 1911}年${mo}月${da}日`;
  if (!new RegExp(`^${pat}$`).test(roc)) return null;
  const wd = '日一二三四五六'[new Date(`${want}T00:00:00Z`).getUTCDay()];
  if (星期 && !星期.endsWith(wd)) return null;
  return want;
}

/** 兩頁共用的表頭。 */
function parseHeader(items) {
  const h = {};
  const dateLabel = findItem(items, /^填報日期:?$/);
  const dateRaw = dateLabel ? rightOf(items, dateLabel) : null;
  const wk = items.find((i) => /^星期[日一二三四五六]$/.test(despace(i.s)));
  h.星期 = wk ? despace(wk.s) : null;
  const dateText = dateRaw && wk ? dateRaw.replace(despace(wk.s), '') : dateRaw;
  h.填報日期 = rocToISO(dateText);

  const wx = items.find((i) => /^本日天氣/.test(despace(i.s)));
  if (wx) {
    const m = despace(wx.s).match(/上午:(.*?)下午:(.*)$/);
    h.天氣_上午 = m ? text(m[1]) : null;
    h.天氣_下午 = m ? text(m[2]) : null;
  }
  const vendorLabel = findItem(items, /^承攬廠商名稱$/);
  h.工程名稱 = rightOf(items, findItem(items, /^工程名稱$/), vendorLabel ? vendorLabel.x : Infinity);
  h.承包廠商 = rightOf(items, vendorLabel);
  const startLabel = findItem(items, /^開工日期$/);
  const endLabel = findItem(items, /^完工日期$/);
  h.開工日期 = rocToISO(rightOf(items, startLabel, endLabel ? endLabel.x : Infinity));
  const actLabel = findItem(items, /^實際進度/);
  h.預定進度 = num(rightOf(items, findItem(items, /^預定進度/), actLabel ? actLabel.x : Infinity));
  h.實際進度 = num(rightOf(items, actLabel));

  if (!h.填報日期 && dateText) {
    const accLabel = findItem(items, /^累計工期$/);
    const 核定Label = findItem(items, /^核定工期$/);
    const remLabel = findItem(items, /^剩餘工期$/);
    const extLabel = findItem(items, /^工期展延天數$/);
    const days = (v) => { const m = despace(v).match(/^(\d+)/); return m ? Number(m[1]) : null; };
    const 核定 = days(rightOf(items, 核定Label, accLabel ? accLabel.x : Infinity));
    const 剩餘 = days(rightOf(items, remLabel, extLabel ? extLabel.x : Infinity));
    h.填報日期 = recoverDate(dateText, h.星期, h.開工日期, 核定, 剩餘);
  }
  return h;
}

/**
 * 對稱分配名稱行(見檔頭)。anchors / lines 都由上而下排好。
 * 回傳每個 anchor 的名稱行陣列(由上而下)。
 */
function assignNames(anchors, lines) {
  const out = anchors.map(() => []);
  let li = 0;
  let quota = 0;                                      // 上一列還要收幾行下方
  for (let k = 0; k < anchors.length; k += 1) {
    const ay = anchors[k].y;
    const between = [];
    while (li < lines.length && lines[li].y > ay + OWN_LINE) between.push(lines[li++]);
    const giveBack = Math.min(quota, between.length);
    if (k > 0) out[k - 1].push(...between.slice(0, giveBack));
    const above = between.slice(giveBack);
    out[k].push(...above);
    while (li < lines.length && Math.abs(lines[li].y - ay) <= OWN_LINE) out[k].push(lines[li++]);
    quota = above.length;
  }
  // 最後一列:剩下的全歸它
  if (anchors.length) out[anchors.length - 1].push(...lines.slice(li));
  return out;
}

/** 頁 1 的施工項目表。回傳依出現序排好的 dailyRows(項次待編)。 */
function parseItemsTable(items) {
  const hdr = (re) => items.filter((i) => re.test(despace(i.s))).sort((a, b) => a.x - b.x);
  const names = hdr(/^施工項目$/);
  const units = hdr(/^單位$/);
  const qtys = hdr(/^契約數量$/);
  const todays = hdr(/^本日完成$/);
  const cums = hdr(/^累計完成$/);
  const remark = findItem(items, /^備註$/);
  if (names.length !== 2 || units.length !== 2 || qtys.length !== 2
    || todays.length !== 2 || cums.length !== 2) return null;
  const topY = Math.min(...[...units, ...qtys, ...todays, ...cums].map((i) => i.y)) - 4;
  // 左組的右界 = 左組累計表頭右緣;右組名稱從這之後開始(實測左 293.4、右名稱 297.3)
  const split = cums[0].x + cums[0].w + 1;
  const halves = [
    { lo: -Infinity, hi: split, unit: units[0], qty: qtys[0], today: todays[0], cum: cums[0], end: split },
    { lo: split, hi: Infinity, unit: units[1], qty: qtys[1], today: todays[1], cum: cums[1],
      end: remark ? remark.x : Infinity },
  ];
  const body = items.filter((i) => i.y < topY && String(i.s).trim() !== '');
  const rows = [];
  for (const hf of halves) {
    const mine = body.filter((i) => i.x >= hf.lo && i.x < hf.hi);
    const nameItems = mine.filter((i) => i.x < hf.unit.x - 5);
    const rest = mine.filter((i) => i.x >= hf.unit.x - 5);
    const valBands = bands(rest).filter((b) => b.items.some((i) => unitOf(i.s) || num(i.s) != null));
    const lines = bands(nameItems);
    const owned = assignNames(valBands, lines);
    valBands.forEach((b, k) => {
      const r = {
        項次: null,
        工程項目: text(owned[k].map((l) => l.items.map((i) => nfkc(i.s).trim()).join('')).join('')),
        單位: null, 契約單價: null, 契約數量: null,
        本日完成數量: null, 本日完成金額: null, 累計完成數量: null,
      };
      for (const it of b.items) {
        if (it.x < hf.qty.x) { r.單位 = r.單位 || unitOf(it.s); continue; }
        for (const t of tokensOf(it)) {
          const v = num(t.s);
          if (v == null) continue;
          if (t.c >= hf.qty.x && t.c < hf.today.x) r.契約數量 = v;
          else if (t.c >= hf.today.x && t.c < hf.cum.x) r.本日完成數量 = v;
          else if (t.c >= hf.cum.x && t.c < hf.end) r.累計完成數量 = v;
        }
      }
      rows.push(r);
    });
  }
  return rows;
}

/** 頁 2 的人員機具(三組並排)。 */
function parseCrew(items) {
  const heads = items.filter((i) => despace(i.s) === '人員機具').sort((a, b) => a.x - b.x);
  const todays = items.filter((i) => despace(i.s) === '本日人機數').sort((a, b) => a.x - b.x);
  const cums = items.filter((i) => despace(i.s) === '累計人機數').sort((a, b) => a.x - b.x);
  const sec4 = items.find((i) => /^四、/.test(despace(i.s)));
  if (heads.length !== 3 || todays.length !== 3 || cums.length !== 3) return null;
  const hy = Math.min(...[...heads, ...todays, ...cums].map((i) => i.y));
  const bottom = sec4 ? sec4.y + BAND : -Infinity;
  const body = items.filter((i) => i.y < hy - 4 && i.y > bottom);
  const 出工明細 = [];
  const 主要機具 = [];
  let 出工總人數 = null;
  for (const b of bands(body)) {
    for (let g = 0; g < 3; g += 1) {
      const lo = heads[g].x - 10;
      const hi = g < 2 ? heads[g + 1].x - 10 : Infinity;
      const inG = b.items.filter((i) => i.x >= lo && i.x < hi);
      const name = text(inG.filter((i) => i.x < todays[g].x - 2 && num(i.s) == null)
        .map((i) => nfkc(i.s).trim()).join(''));
      let n = null;
      for (const it of inG) {
        for (const t of tokensOf(it)) {
          if (t.c >= todays[g].x && t.c < cums[g].x && num(t.s) != null) n = num(t.s);
        }
      }
      if (!name || n == null || n <= 0) continue;
      if (/機$/.test(name)) 主要機具.push({ 名稱: name, 數量: n });
      else {
        出工明細.push({ 工別: name, 人數: n });
        出工總人數 = (出工總人數 || 0) + n;
      }
    }
  }
  return { 出工明細, 主要機具, 出工總人數 };
}

const isLogPage = (items) => items.some((i) => despace(i.s) === '公共工程施工日誌')
  && items.some((i) => /^填報日期:?$/.test(despace(i.s)));

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.extractItems !== 'function') throw new Error('heji 讀取器需要 ctx.filetypes.extractItems');
  const pages = await ft.extractItems(filePath);
  if (!pages.length || pages.every((p) => !(p.items || []).length)) {
    throw new Error('PDF 沒有文字層(掃描件)');
  }
  const days = [];
  let cur = null;
  for (const pg of pages) {
    const items = pg.items || [];
    if (!isLogPage(items)) continue;
    const h = parseHeader(items);
    const table = parseItemsTable(items);
    const crew = parseCrew(items);
    // 一天兩頁:同一個填報日期(或日期讀不到時,緊接在後、表報編號相同)併成一天
    const no = rightOf(items, findItem(items, /^表報編號:?$/));
    const same = cur && ((h.填報日期 && h.填報日期 === cur.header.填報日期)
      || (!h.填報日期 && !cur.header.填報日期 && no && no === cur._no));
    if (!same) {
      cur = {
        _no: no,
        header: {
          工程名稱: h.工程名稱 || null,
          填報日期: h.填報日期 || null,
          星期: h.星期 || null,
          天氣_上午: h.天氣_上午 || null,
          天氣_下午: h.天氣_下午 || null,
          預定進度: h.預定進度 == null ? null : h.預定進度,
          實際進度: h.實際進度 == null ? null : h.實際進度,
          出工總人數: null,
          本日累計金額: null,
          承包廠商: h.承包廠商 || null,
          開工日期: h.開工日期 || null,
        },
        dailyRows: [],
        extras: {},
      };
      days.push(cur);
    }
    if (table && !cur.dailyRows.length) {
      cur.dailyRows = table.map((r, i) => ({ ...r, 項次: String(i + 1) }));  // 出現序(見檔頭)
    }
    if (crew) {
      cur.header.出工總人數 = crew.出工總人數;
      if (crew.出工明細.length) cur.extras.出工明細 = crew.出工明細;
      if (crew.主要機具.length) cur.extras.主要機具 = crew.主要機具;
    }
  }
  for (const d of days) delete d._no;
  if (!days.length || days.every((d) => !d.header.填報日期)) {
    throw new Error('讀不到填報日期(此檔可能不是禾吉土木包工業的施工日誌)');
  }
  return days;
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest 用**真實座標**(取自 1151022-1151031 第 1、15 頁,只換工程名稱):
 * 左右兩組並排、名稱夾著數值的對稱分配、字型缺字的日期還原。
 */
function selfTest() {
  const it = (y, x, w, s) => ({ x, y, w, s });
  const head = [
    it(814.7, 234.1, 127.7, '公共工程施工日誌'),
    it(799.3, 20.4, 55.2, '表報編號:'), it(799.1, 78.4, 7.0, '1'),
    it(785.8, 436.5, 77.2, '115年10月22日'), it(785.6, 530.0, 33.1, '星期四'),
    it(785.2, 20.4, 156.8, '本日天氣:上午: 晴天  下午:晴天'), it(784.9, 371.6, 60.0, '填報日期:'),
    it(769.1, 25.2, 44.2, '工程名稱'), it(769.1, 78.2, 162.6, '測試工程'),
    it(769.1, 327.5, 66.2, '承攬廠商名稱'), it(769.1, 407.1, 77.3, META_VENDOR_KEY),
    it(752.0, 25.2, 44.2, '核定工期'), it(752.0, 95.9, 52.2, '160日曆天'),
    it(752.0, 189.3, 44.2, '累計工期'), it(752.0, 265.9, 39.5, '1日曆天'),
    it(752.0, 338.6, 44.2, '剩餘工期'), it(752.0, 414.7, 30.1, '159天'),
    it(752.0, 462.1, 66.2, '工期展延天數'),
    it(737.5, 70.9, 44.2, '開工日期'), it(737.5, 203.2, 77.6, '115年10月22日'),
    it(737.5, 353.0, 44.2, '完工日期'),
    it(723.4, 62.5, 61.0, '預定進度(%)'), it(723.4, 226.4, 31.3, '0.35%'),
    it(723.4, 344.6, 61.0, '實際進度(%)'), it(723.4, 436.0, 31.3, '0.80%'),
  ];
  const table = [
    it(697.3, 216.7, 36.0, '本日完成'), it(697.3, 257.4, 36.0, '累計完成'),
    it(697.3, 477.2, 36.0, '本日完成'), it(697.3, 518.0, 36.0, '累計完成'),
    it(691.2, 59.5, 36.0, '施工項目'), it(691.2, 173.3, 36.0, '契約數量'),
    it(691.2, 332.8, 36.0, '施工項目'), it(691.2, 436.8, 36.0, '契約數量'),
    it(690.9, 558.6, 16.8, '備註'), it(690.7, 143.3, 18.0, '單位'), it(690.7, 410.8, 18.0, '單位'),
    it(632.9, 297.3, 104.2, '13mm熱固性樹脂板小便斗隔屏'),
    it(632.7, 19.9, 114.2, '工程告示牌與職安衛告示牌(租用)'),
    it(632.4, 194.8, 17.6, '1.00'), it(632.4, 235.6, 17.6, '1.00'), it(632.4, 276.4, 17.6, '1.00'),
    it(632.4, 455.4, 17.6, '1.00'), it(631.9, 147.7, 9.0, '式'), it(631.9, 415.4, 9.0, '片'),
    it(616.3, 20.0, 108.0, '施工動線開闢與損壞復原,'),
    it(604.4, 297.4, 72.4, '既有洗手台拉皮工程'),
    it(604.1, 194.8, 17.6, '1.00'), it(604.1, 455.4, 17.6, '2.00'),
    it(603.8, 20.0, 108.0, '既有設備管線遷移與復原;'),
    it(603.6, 147.7, 9.0, '式'), it(603.6, 415.4, 9.0, '座'),
    it(591.5, 20.0, 45.0, '測量與放樣'),
    it(575.4, 297.5, 99.0, '安裝輕鋼架、金屬烤漆透'),
    it(573.9, 19.9, 112.6, '既有地坪、台階、磁磚、衛生設'),
    it(562.9, 297.5, 99.0, '空網與耐燃一級貼皮天花'),
    it(562.7, 19.9, 112.6, '備、給排水設施、搗擺及天花板'),
    it(556.9, 194.8, 17.6, '1.00'), it(556.9, 455.4, 17.6, '1.00'),
    it(556.4, 147.7, 9.0, '式'), it(556.4, 415.4, 9.0, '式'),
    it(551.5, 19.9, 112.1, '等拆除(含切割)及運棄(含合法證'),
    it(550.5, 297.5, 101.9, '板(含必要之側封板與窗簾'),
    it(540.3, 19.9, 68.6, '明);環境保護與清潔'),
    it(538.1, 297.5, 47.9, '盒批土刷漆)'),
    it(193.3, 297.4, 56.3, '營造綜合保險費'),
    it(193.0, 455.4, 17.6, '1.00'), it(193.0, 491.0, 22.7, '1.000'), it(193.0, 537.0, 17.6, '1.00'),
    it(192.5, 415.4, 9.0, '式'),
  ];
  const h = parseHeader(head);
  if (h.填報日期 !== '2026-10-22' || h.星期 !== '星期四' || h.開工日期 !== '2026-10-22') return false;
  if (h.工程名稱 !== '測試工程' || h.承包廠商 !== META_VENDOR_KEY) return false;
  if (h.天氣_上午 !== '晴天' || h.天氣_下午 !== '晴天') return false;
  if (h.預定進度 !== 0.35 || h.實際進度 !== 0.8) return false;

  const rows = parseItemsTable([...head, ...table]);
  if (!rows || rows.length !== 7) return false;
  const [l1, l2, l3, r1, r2, r3, r4] = rows;
  if (l1.工程項目 !== '工程告示牌與職安衛告示牌(租用)' || l1.單位 !== '式') return false;
  if (l1.契約數量 !== 1 || l1.本日完成數量 !== 1 || l1.累計完成數量 !== 1) return false;
  if (l2.工程項目 !== '施工動線開闢與損壞復原,既有設備管線遷移與復原;測量與放樣') return false;
  if (l3.工程項目 !== '既有地坪、台階、磁磚、衛生設備、給排水設施、搗擺及天花板等拆除(含切割)及運棄(含合法證明);環境保護與清潔') return false;
  if (l2.本日完成數量 !== null || l2.累計完成數量 !== null) return false;
  if (r1.工程項目 !== '13mm熱固性樹脂板小便斗隔屏' || r1.單位 !== '片') return false;
  if (r2.契約數量 !== 2 || r2.單位 !== '座') return false;
  if (r3.工程項目 !== '安裝輕鋼架、金屬烤漆透空網與耐燃一級貼皮天花板(含必要之側封板與窗簾盒批土刷漆)') return false;
  if (r4.工程項目 !== '營造綜合保險費' || r4.本日完成數量 !== 1 || r4.累計完成數量 !== 1) return false;

  // 第 15 頁:數字被抽成控制字元,靠三個來源欄位的交集還原
  const p15 = head.map((i) => {
    if (i.s === '115年10月22日' && i.x === 436.5) return { ...i, s: '115年10月2\u001c日' };
    if (i.s === '1日曆天') return { ...i, s: '\u001b日曆天' };
    if (i.s === '159天') return { ...i, s: '152天' };
    return i;
  });
  if (parseHeader(p15).填報日期 !== '2026-10-29') return false;
  // 星期對不上就不還原
  const bad = p15.map((i) => (i.s === '星期四' ? { ...i, s: '星期三' } : i));
  if (parseHeader(bad).填報日期 !== null) return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '星期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '出工總人數', '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約數量', '本日完成數量', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parseHeader, parseItemsTable, parseCrew, assignNames, recoverDate },
};
