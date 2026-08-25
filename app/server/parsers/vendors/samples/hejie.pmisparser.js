/**
 * hejie.pmisparser.js — 禾結土木包工業施工日誌讀取器(元長國小污水處理設施)
 *
 * vendorKey 取自**決標公告的得標廠商**;日誌每一頁抬頭也寫「禾結土木包工業」,兩邊一致。
 *
 * ── 版面事實(實測 3 份 PDF / 41 天)──
 * 有文字層的 PDF,**一天兩頁**:第一聯(表頭/出工/機具/材料)、第二聯(完整明細)。
 * 第二聯的表頭:項次 / 工程項目 / 單位 / 契約單價 / 契約數量 /
 *              本日完成數量 / 本日完成金額 / 累計完成數量 / 備註
 * 明細之後有一列「累計(本日完成金額)」= 到當日為止的累計完成金額 → header.本日累計金額。
 *
 * ── 四個坑 ──
 * ① **右邊三欄的表頭是「一個 item」**:`"本日完成數量  本日完成金額   累計完成數量"`。
 *    取不到三個欄界,只能用 `w / s.length` 推每個字元的 x,再取各 token 的**起點**
 *    當欄界。同樣地,**資料也會兩欄擠在同一個 item 裡**
 *    (`"  17,500.00         7.00"` 同時裝著本日金額與累計數量),所以值也要先切 token
 *    再依中心點歸欄——直接拿 item 的中心會把兩個數字算成一個。
 * ② **項次與名稱都印在「工程項目」表頭的左邊**(項次 x≈60、名稱 x≈75,而表頭在 x≈111)。
 *    用表頭欄界會把名稱歸進項次欄。左半改用**形狀**判定:最左的 token 若長得像項次
 *    (阿拉伯數字或中文大寫/天干)就是項次,其餘串起來是名稱。
 * ③ **標籤字之間有空白**(`表 報 編 號 :`、`本 日 氣 候`),而且日期是一個字一個 item
 *    (`114`、`年`、`6`、`月`、`1`、`日`)。所有標籤比對一律先去空白,日期則整段接起來再 regex。
 * ④ **表格尾端有一整片「-」的空白列**(範本印好的列)。`-` 一律當 null,整列皆 null 就跳過;
 *    不跳的話每天會多出十幾列沒有名稱的假項目。
 * ⑤ **長名稱會折行,一列佔兩到三個 y 帶**,而且項次與數值不一定落在同一帶:
 *    有時數值在下面那帶(項次 3「測量與放樣」),有時項次在上面那帶而數值在下面
 *    (項次 27 求救按鈕),契約數量甚至會自己單獨一帶。一帶當一列的話,每天會多出
 *    一批沒有項次的假列(SP3 的 A4 硬錯)、真列的名稱只剩半截(E3 警告),還會漏掉
 *    契約數量(A7 硬錯)。實測明禮 30 天:1050 列裡 30 個 A4、21 個 A7,全是這個。
 *    見 `mergeWrapped`。
 *
 * ── 進度取哪一組 ──
 * 表頭同時有「本日預定/實際進度」與「累計預定/實際進度」。**取累計那一組**:
 * SP3 的 F3/H1 驗的是累計語意。PDF 印的就是百分數(36.00%),照收不換算。
 *
 * ── 沒做的部分(明講,不是漏掉)──
 * 第一聯的出工/機具/材料**刻意不收**:那三張表是左右兩個並排的區塊,而且值印在自己
 * 表頭的左邊(「鐵工」x186.5 vs 表頭 x194.4),要正確拆得先解決區塊歸屬與偏移兩件事;
 * schema 裡 extras 是「有才填」,而 SP3 與報表都沒有任何規則吃 出工總人數。
 * 真要補時記得:那一區的欄界不能直接用表頭 x。
 */

const META_VENDOR_KEY = '禾結土木包工業';

const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'kg', '噸', 'T',
  '公尺', '公斤', '平方公尺', '立方公尺', '場', '座', '組', '支', '個', '只', '片',
  '面', '處', '間', '棵', '株', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '才', '天', '日', '人']);
// 項次:阿拉伯數字、中文大寫(壹貳參…)、天干(甲乙丙…,這家的最上層大類用它)
const NO_RE = /^(\d{1,3}|[壹貳參参肆伍陸柒捌玖拾]+|[甲乙丙丁戊己庚辛壬癸]+)$/;

const nfkc = (v) => String(v == null ? '' : v).normalize('NFKC');
const despace = (v) => nfkc(v).replace(/[\s　]/g, '');

/**
 * 無資料標記一律 null。範本印好的空白列**每一格都是「-」**,而左半的項次與名稱
 * 會被串成「--」——只比對單一個「-」的話那些列會變成名稱叫「--」的假項目。
 */
function text(v) {
  const s = nfkc(v).replace(/[\r\n]+/g, '').trim();
  return s === '' || /^[-－\s]+$/.test(s) ? null : s;
}

function num(v) {
  const s = nfkc(v).replace(/[,\s　%]/g, '');
  if (s === '' || s === '-' || s === '－') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const unitOf = (v) => {
  const s = despace(v);
  return s && KNOWN_UNITS.has(s) ? s : null;
};

function rocTextToISO(v) {
  const m = despace(v).match(/(\d{2,4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  let y = Number(m[1]);
  if (y < 1911) y += 1911;
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(Number(m[2]))}-${p(Number(m[3]))}`;
}

/**
 * 把一個 item 切成 token,並依 `w / s.length` 推每個 token 的起點與中心。
 * 這家的資料常常兩欄擠在同一個 item(見檔頭①),不切就會把兩個數字當成一個。
 */
function tokensOf(it) {
  const s = String(it.s == null ? '' : it.s);
  const cw = s.length ? (it.w || 0) / s.length : 0;
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const a = m.index;
    const b = a + m[0].length - 1;
    out.push({ x: it.x + cw * a, cx: it.x + cw * (a + b + 1) / 2, y: it.y, s: m[0] });
  }
  return out;
}

/**
 * 依 y 分帶。**容差要 5**:長名稱印在自己的基線上,同一列的最上與最下差到 3.2
 * (名稱 635.0、契約數量 631.8);容差取 2 會把名稱與數值拆成兩列,於是每天多出
 * 一半沒有名稱的列與一半沒有數值的列。列距最小 11.3,取 5 不會併到相鄰列。
 */
function bands(items, tol = 5) {
  const out = [];
  for (const it of items.slice().sort((a, b) => b.y - a.y)) {
    const last = out[out.length - 1];
    if (last && last.y - it.y <= tol) last.items.push(it);
    else out.push({ y: it.y, items: [it] });
  }
  for (const b of out) b.items.sort((a, b2) => a.x - b2.x);
  return out;
}

const bandText = (b) => despace(b.items.map((i) => i.s).join(''));

/** 取某標籤右邊、下一個標籤左邊的字(同一帶內;標籤字間有空白,一律去空白比對)。 */
function pick(band, labelRe, stopRe) {
  if (!band) return null;
  const its = band.items;
  const li = its.findIndex((i) => labelRe.test(despace(i.s)));
  if (li < 0) return null;
  let end = its.length;
  if (stopRe) {
    for (let i = li + 1; i < its.length; i++) if (stopRe.test(despace(its[i].s))) { end = i; break; }
  }
  return text(its.slice(li + 1, end).map((i) => i.s).join(''));
}

const bandWith = (all, re) => all.find((b) => b.items.some((i) => re.test(despace(i.s))));

/** 第一聯:表頭欄位。 */
function parseCover(items) {
  const all = bands(items);
  const bNo = bandWith(all, /^表報編號[:：]?$/);
  const bName = bandWith(all, /^工程名稱$/);
  // 有些天的『本 日 氣 候』與『上午:』印在同一個 item 裡,不能用完全相等比對
  const bWx = bandWith(all, /^本日氣候/);
  const bStart = bandWith(all, /^開工日期$/);
  const bPlan = bandWith(all, /^累計預定進度$/);
  const bActual = bandWith(all, /^累計實際進度$/);

  const wxText = bWx ? bandText(bWx) : '';
  const wm = wxText.match(/上午[:：](.*?)下午[:：](.+?)$/);
  const dateText = bNo ? (bandText(bNo).match(/\d{2,4}年\d{1,2}月\d{1,2}日/) || [])[0] : null;
  const week = bNo ? (bandText(bNo).match(/星期[一二三四五六日天]/) || [])[0] : null;

  return {
    工程名稱: pick(bName, /^工程名稱$/, /^本日氣候/),
    填報日期: rocTextToISO(dateText),
    星期: week || null,
    天氣_上午: wm ? text(wm[1]) : null,
    天氣_下午: wm ? text(wm[2]) : null,
    // 累計那一組才是 SP3 的 F3/H1 要驗的語意;PDF 印的是百分數,照收
    預定進度: num(pick(bPlan, /^累計預定進度$/)),
    實際進度: num(pick(bActual, /^累計實際進度$/)),
    開工日期: rocTextToISO(pick(bStart, /^開工日期$/, /^本日實際進度$/)),
  };
}

/** 第二聯:完整明細 + 當日累計金額。 */
/**
 * 名稱折行時,一列會佔兩到三個 y 帶。把不含項次的帶併回**最近的項次帶**。
 *
 * ⚠️ 不可以用「間距小於某個值就併」——那會連鎖。實測明禮 30 天:項次 3 的
 * 契約數量「1」自己單獨一帶(離項次帶 5.4),而項次 4 的名稱首行離它只有 7.7,
 * 照間距併會把 3 和 4 併成一列。改成算「到最近項次帶的距離」就分得開:
 * 5.4 vs 12.9、5.2 vs 13.1。
 *
 * 門檻取 8.5:同一列各帶的距離實測 5.0~7.7,不同列的項次帶最小 9.5(n=1050)。
 * 併不到的帶(範本印好的整列「-」)維持原樣自成一列,由既有的整列 null 規則濾掉。
 */
const MAX_WRAP_GAP = 8.5;

function mergeWrapped(bands) {
  const 有項次 = (b) => {
    const left = b.items.flatMap(tokensOf).filter((t) => t.cx < 62).sort((a, c) => a.x - c.x);
    return left.length > 0 && NO_RE.test(despace(left[0].s));
  };
  const anchors = bands.filter(有項次);
  if (!anchors.length) return bands;
  const out = new Map(anchors.map((b) => [b, { y: b.y, items: b.items.slice() }]));
  const loose = [];
  for (const b of bands) {
    if (out.has(b)) continue;
    let best = null;
    for (const a of anchors) {
      const d = Math.abs(a.y - b.y);
      if (d <= MAX_WRAP_GAP && (best == null || d < Math.abs(best.y - b.y))) best = a;
    }
    if (best) out.get(best).items.push(...b.items);
    else loose.push({ y: b.y, items: b.items.slice() });
  }
  return [...out.values(), ...loose].sort((a, b) => b.y - a.y);
}

/** 同一列內先分行(y 容差 4,同一行的基線本來就差到 3.2),行內再由左到右。 */
function 依閱讀序(tokens) {
  const lines = [];
  for (const t of tokens.slice().sort((a, b) => b.y - a.y)) {
    const last = lines[lines.length - 1];
    if (last && last.y - t.y <= 4) last.ts.push(t);
    else lines.push({ y: t.y, ts: [t] });
  }
  return lines.flatMap((l) => l.ts.sort((a, b) => a.x - b.x));
}

function parseDetail(items) {
  const all = bands(items);
  const flat = items.flatMap(tokensOf);
  const hdrTok = (label) => flat.find((t) => despace(t.s) === label);
  // 右邊三欄的表頭是同一個 item,切 token 後各取起點當欄界(見檔頭①)
  const hNo = hdrTok('項次');
  const hUnit = hdrTok('單位');
  const hPrice = hdrTok('契約單價');
  const hQty = hdrTok('契約數量');
  const hToday = hdrTok('本日完成數量');
  const hAmt = hdrTok('本日完成金額');
  const hCum = hdrTok('累計完成數量');
  const hMemo = hdrTok('備註');
  if (!hNo || !hUnit || !hPrice || !hQty || !hToday || !hAmt || !hCum) {
    throw new Error('第二聯表頭欄位找不到(非禾結格式?)');
  }
  const xs = [-Infinity, hUnit.x, hPrice.x, hQty.x, hToday.x, hAmt.x, hCum.x,
    hMemo ? hMemo.x : Infinity];

  const stop = flat.find((t) => /^累計\(本日完成金額\)$/.test(despace(t.s)));
  const 本日累計金額 = stop
    ? num(flat.filter((t) => t !== stop && t.y > stop.y - 2 && t.y < stop.y + 2 && t.cx > stop.x)
      .map((t) => t.s).join(''))
    : null;

  const 明細帶 = all.filter((b) => b.y < hNo.y - 0.5
    && !(stop && b.y <= stop.y + 2));
  const dailyRows = [];
  for (const b of mergeWrapped(明細帶)) {
    const cells = xs.map(() => []);
    for (const t of b.items.flatMap(tokensOf)) {
      let k = 0;
      while (k + 1 < xs.length && t.cx >= xs[k + 1]) k++;
      cells[k].push(t);
    }
    const left = cells[0].sort((a, c) => a.x - c.x);
    let 項次 = null;
    let rest = left;
    // 項次與名稱都在「工程項目」表頭左邊,只能靠形狀分(見檔頭②)
    if (left.length && NO_RE.test(despace(left[0].s))) {
      項次 = despace(left[0].s);
      rest = left.slice(1);
    }
    // 名稱片段跨行時要照「上到下、左到右」接回去,不能照 x 排——兩行的起點 x
    // 幾乎相同(69.1 vs 69.0),靠 sort 的穩定性接對只是碰巧(見檔頭⑤)
    const name = 依閱讀序(rest).map((t) => t.s).join('');
    const join = (k) => cells[k].map((t) => t.s).join('');
    const row = {
      項次,
      工程項目: text(name),
      單位: unitOf(join(1)),
      契約單價: num(join(2)),
      契約數量: num(join(3)),
      本日完成數量: num(join(4)),
      本日完成金額: num(join(5)),
      累計完成數量: num(join(6)),
    };
    // 範本印好的空白列:整列都是「-」(見檔頭④)
    if (row.項次 == null && row.工程項目 == null) continue;
    dailyRows.push(row);
  }
  return { dailyRows, 本日累計金額 };
}

const pageKind = (items) => {
  for (const it of items) {
    const s = despace(it.s);
    if (s.startsWith('第一聯')) return 'cover';
    if (s.startsWith('第二聯')) return 'detail';
  }
  return null;
};

/**
 * 第二聯表尾的文字雖寫「累計(本日完成金額)」，但有些禾結版面實際填的是**本日**
 * 合計。累計值依日期不可能倒退；一旦發現倒退，該欄便不是 schema 所需的日累計
 * 金額，必須整批留 null，不能拿本日金額去觸發 B4 假錯。
 */
function clearNonCumulativeHeaders(days) {
  const values = days
    .map((d) => ({ date: d.header.填報日期, amount: d.header.本日累計金額 }))
    .filter((x) => x.date != null && x.amount != null)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let prev = null;
  for (const { amount } of values) {
    if (prev != null && Number(amount) < Number(prev) - 0.01) {
      for (const d of days) d.header.本日累計金額 = null;
      return true;
    }
    prev = amount;
  }
  return false;
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.extractItems !== 'function') throw new Error('缺少注入的 filetypes.extractItems');
  const pages = await ft.extractItems(filePath);
  const total = pages.reduce((a, p) => a + (p.items || []).length, 0);
  // 回空陣列會被上游當成「這份沒有資料」而靜靜略過。掃描件一定要明講。
  if (!total) throw new Error('PDF 沒有文字層(掃描件),無法解析');

  const groups = [];
  let cur = null;
  for (const p of pages) {
    const items = p.items || [];
    const kind = pageKind(items);
    if (kind === 'cover') { cur = { cover: items, details: [] }; groups.push(cur); }
    else if (kind === 'detail') {
      if (!cur) { cur = { cover: null, details: [] }; groups.push(cur); }
      cur.details.push(items);
    }
  }
  if (!groups.length) throw new Error('找不到第一聯/第二聯(此檔非禾結格式)');

  const days = groups.map((g) => {
    const h = g.cover ? parseCover(g.cover) : {};
    let dailyRows = [];
    let 本日累計金額 = null;
    for (const d of g.details) {
      const r = parseDetail(d);
      dailyRows = dailyRows.concat(r.dailyRows);
      if (r.本日累計金額 != null) 本日累計金額 = r.本日累計金額;
    }
    return {
      header: {
        工程名稱: h.工程名稱 || null,
        填報日期: h.填報日期 || null,
        星期: h.星期 || null,
        天氣_上午: h.天氣_上午 || null,
        天氣_下午: h.天氣_下午 || null,
        預定進度: h.預定進度 == null ? null : h.預定進度,
        實際進度: h.實際進度 == null ? null : h.實際進度,
        出工總人數: null,                                   // 刻意不收,見檔頭
        本日累計金額,
        承包廠商: META_VENDOR_KEY,
        開工日期: h.開工日期 || null,
      },
      dailyRows,
      extras: {},
    };
  });
  const filled = days.filter((d) => d.header.填報日期 != null
    || d.dailyRows.some((r) => r.本日完成數量));
  clearNonCumulativeHeaders(filled);
  return filled;
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest 用**真實座標**(取自 `6.1-6.20.pdf` 第 1~2 頁,只換工程名稱)。
 * 要驗的三件事都是形狀問題:三欄擠在一個表頭 item、兩個數值擠在一個資料 item、
 * 項次與名稱都在「工程項目」表頭的左邊。
 */
function selfTest() {
  const it = (x, y, w, s) => ({ x, y, w, s });
  const cover = [
    it(238.7, 772.6, 110.5, META_VENDOR_KEY),
    it(240.4, 754.6, 106.7, '公共工程施工日誌'),
    it(407.2, 739.8, 11.2, '114'), it(427.2, 739.8, 7.4, '年'), it(443.5, 739.8, 3.7, '6'),
    it(456.1, 739.8, 7.4, '月'), it(472.6, 739.8, 3.7, '1'), it(485.2, 739.8, 7.4, '日'),
    it(110.3, 739.7, 50.8, '表 報 編 號 :'), it(370.6, 739.7, 33.9, '日 期 :'),
    it(53.0, 739.6, 29.3, '第一聯 '), it(503.0, 739.6, 25.1, '星期日'), it(164.0, 739.2, 9.1, '33'),
    it(126.7, 727.8, 218.2, '測試工程 '),
    it(53.0, 726.4, 71.4, '工   程   名   稱'), it(353.6, 726.4, 50.8, '本 日 氣 候'),
    it(412.0, 726.2, 25.1, '上午:'), it(457.1, 726.2, 69.8, '晴    下午:   陰'),
    it(407.2, 713.2, 52.7, '本 日 預 定 進 度'), it(474.4, 712.9, 16.7, '2.00'),
    it(509.5, 712.4, 4.1, '%'),
    it(239.9, 699.7, 68.9, '開   工   日   期'), it(311.5, 699.7, 12.5, '114'),
    it(332.6, 699.7, 8.3, '年'), it(349.6, 699.7, 4.1, '4'), it(362.3, 699.7, 8.3, '月'),
    it(379.3, 699.7, 8.4, '30'), it(396.2, 699.7, 8.3, '日'),
    it(407.2, 699.8, 52.7, '本 日 實 際 進 度'), it(474.4, 699.6, 16.7, '2.48'),
    it(407.2, 686.5, 52.7, '累 計 預 定 進 度'), it(472.2, 686.3, 20.9, '36.00'),
    it(509.5, 685.8, 4.1, '%'),
    it(407.2, 673.2, 52.7, '累 計 實 際 進 度'), it(472.2, 673.0, 20.9, '90.08'),
    it(509.5, 672.5, 4.1, '%'),
  ];
  const detail = [
    it(236.9, 773.4, 106.7, '公共工程施工日誌'),
    it(52.1, 758.6, 16.0, '第 二 聯     '),
    it(90.7, 741.1, 230.3, '測試工程 '),
    it(380.6, 739.7, 12.5, '114'), it(405.2, 739.7, 8.3, '年'), it(425.6, 739.7, 4.1, '6'),
    it(441.8, 739.7, 8.3, '月'), it(462.2, 739.7, 4.1, '1'), it(478.3, 739.7, 8.3, '日'),
    it(53.0, 739.6, 33.5, '工程名稱'), it(339.7, 739.1, 37.8, '日期:   '),
    it(110.9, 726.4, 46.1, '工 程 項 目'), it(285.1, 726.4, 33.5, '契約數量'),
    it(54.0, 726.1, 14.9, '項次'),
    it(333.0, 726.1, 150.4, '本日完成數量  本日完成金額   累計完成數量'),
    it(202.8, 725.9, 16.6, '單位'), it(500.6, 725.9, 16.6, '備註'),
    it(235.4, 725.8, 33.5, '契約單價'),
    // 大類:甲(天干)與壹,整列只有名稱與「-」
    it(76.3, 712.9, 41.9, '發包工程費'), it(57.5, 712.7, 7.8, '甲'),
    it(380.6, 712.6, 37.8, '        -'), it(435.0, 712.6, 37.7, '        -'),
    it(268.7, 712.4, 4.1, '-'), it(214.2, 712.1, 4.6, '-'), it(314.8, 711.7, 4.1, '-'),
    // 一般項目:名稱與項次都在「工程項目」表頭左邊
    it(75.6, 686.8, 115.1, '工程告示牌與職業安全告示牌(租用)'),
    it(380.6, 685.9, 37.8, '        -'), it(435.0, 685.9, 46.1, '       1.00'),
    it(59.4, 685.8, 4.1, ' '), it(60.6, 685.8, 4.1, '1'),
    it(251.9, 685.8, 20.9, '6,000'), it(206.9, 685.4, 9.1, '式'),
    it(285.4, 685.1, 33.5, '        '), it(314.8, 685.1, 4.1, '1'),
    // 兩個數值擠在同一個 item:「  17,500.00         7.00」= 本日金額 + 累計數量
    it(331.8, 607.2, 46.1, '       7.00'),
    it(76.3, 606.4, 109.1, '安裝5吋不鏽鋼清潔口與PVC管'),
    it(380.6, 606.0, 100.5, '  17,500.00         7.00'),
    it(59.4, 605.9, 4.1, ' '), it(60.6, 605.9, 4.1, '7'),
    it(251.9, 605.9, 20.9, '2,500'), it(206.9, 605.5, 9.1, '組'),
    it(285.4, 605.2, 33.5, '        '), it(314.8, 605.2, 4.1, '7'),
    // 範本印好的空白列:整列都是「-」
    it(76.3, 155.3, 4.1, ' '), it(187.0, 155.3, 4.1, '-'),
    it(380.6, 154.9, 37.8, '        -'), it(435.0, 154.9, 37.7, '        -'),
    it(59.4, 154.8, 4.1, ' '), it(60.6, 154.8, 4.1, '-'),
    it(268.7, 154.8, 4.1, '-'), it(214.2, 154.4, 4.6, '-'), it(314.8, 154.1, 4.1, '-'),
    it(72.1, 102.0, 75.5, '累計(本日完成金額)'), it(380.6, 101.6, 46.1, '  20,105.23'),
    it(88.1, 88.7, 188.9, '本日完成進度=(本日累計完成金額÷契約金額)%='), it(280.3, 88.2, 22.8, '2.48%'),
  ];

  const cov = parseCover(cover);
  if (cov.工程名稱 !== '測試工程') return false;
  if (cov.填報日期 !== '2025-06-01' || cov.星期 !== '星期日') return false;
  if (cov.開工日期 !== '2025-04-30') return false;
  if (cov.天氣_上午 !== '晴' || cov.天氣_下午 !== '陰') return false;
  // 取累計那一組,不是本日那一組(2.00 / 2.48)
  if (cov.預定進度 !== 36 || cov.實際進度 !== 90.08) return false;

  const det = parseDetail(detail);
  if (det.本日累計金額 !== 20105.23) return false;
  if (det.dailyRows.length !== 3) return false;            // 空白列不算
  const [c0, r1, r7] = det.dailyRows;
  if (c0.項次 !== '甲' || c0.工程項目 !== '發包工程費') return false;
  if (c0.單位 !== null || c0.契約數量 !== null) return false;   // 大類:「-」一律 null
  if (r1.項次 !== '1' || r1.工程項目 !== '工程告示牌與職業安全告示牌(租用)') return false;
  if (r1.單位 !== '式' || r1.契約單價 !== 6000 || r1.契約數量 !== 1) return false;
  if (r1.本日完成數量 !== null || r1.累計完成數量 !== 1) return false;
  // 兩欄擠在同一個 item:切 token 才分得開
  if (r7.項次 !== '7' || r7.本日完成數量 !== 7) return false;
  if (r7.本日完成金額 !== 17500 || r7.累計完成數量 !== 7) return false;
  if (Math.abs(r7.本日完成金額 - r7.本日完成數量 * r7.契約單價) > 0.5) return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.1.0',
    targetFields: [
      '工程名稱', '填報日期', '星期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '本日累計金額', '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約單價', '契約數量',
      '本日完成數量', '本日完成金額', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parseCover, parseDetail, tokensOf, bands, clearNonCumulativeHeaders },
};
