/**
 * hongen.pmisparser.js — 宏恩工程有限公司施工日誌讀取器(永隆國小桌球室地坪整修)
 *
 * vendorKey 取自**決標公告的得標廠商**;日誌每一頁的「承攬廠商名稱」欄也是同一個
 * 名稱,兩邊一致。
 *
 * ⚠️ **來源是 .doc,必須先轉成 PDF 才讀得了**
 * 這家唯一那份日誌是 `施工日誌(更).doc`,**真的 Word 97-2003 二進位檔**
 * (magic `D0CF11E0`、內含 `WordDocument` 串流;SheetJS 開它會說找不到 Workbook 串流,
 * 所以不是「副檔名寫錯的 xls」)。純 JS 沒有可靠的 .doc 表格讀法——文字流掃得到字,
 * 但**欄界在格式串流裡**,從文字流猜欄位就是編造。
 * 作業方式:先用 Word 另存 PDF(一次性),再把 PDF 當日誌上傳。轉出來的 PDF 有完整
 * 文字層與座標,本讀取器就是對著它寫的。轉檔指令(PowerShell,Word COM):
 *     $w=New-Object -ComObject Word.Application; $w.Visible=$false
 *     $d=$w.Documents.Open('C:\\path\\in.doc',$false,$true)
 *     $d.SaveAs2('C:\\path\\out.pdf',17); $d.Close(0); $w.Quit()
 * (17 = wdFormatPDF。中文路徑在 PS 5.1 下會亂碼,先複製成 ASCII 檔名再轉。)
 * 直接把 .doc 餵進來會 throw,訊息會講要先轉 PDF——**不可回空陣列**,
 * 回空會被上游當成「這份沒有資料」靜靜略過。
 *
 * ── 版面事實(轉出的 PDF,15 天,一天一頁)──
 * 工程會標準表單的單聯版,頁首是「表報編號:」。
 *   y≈776  本日天氣:上午: 晴 下午: 晴 … 填報日期: 115年1月28日(星期三)
 *   y≈754  工程名稱 值   承攬廠商名稱 值
 *   y≈733  契約工期 … 開工日期 115/1/28
 *   y≈694  預定進度 / 累計進度(標籤佔三行,**值在中間那行**)
 *   y≈643  明細表頭:施工項目 單位 契約數量 本日完成數量 累計完成數量 備註
 *   明細到「營造業專業工程特定施工項目」為止。
 *
 * ── 三個坑 ──
 * ① **Word 轉 PDF 會把數字切成好幾個 item**:「115年1月28日」是
 *    `11`+`5`+`年`+`1`+`月`+`28`+`日` 七個 item,「115/1/28」是 `115`+`/`+`1/28`。
 *    所以日期一律**整帶接起來(不留空白)再 regex**,不能逐 item 比對。
 * ② **進度的標籤佔三行(預定進度 / (%)),值印在中間那一行**,與標籤不同帶。
 *    取值要用「同一段 x 範圍 + 標籤上下一小段 y」去撈,不能只看同一帶。
 * ③ **明細的長名稱跨兩行**:第一行與數值同一帶(y 差 2.7),續行印在下面自成一帶
 *    (「施工區管制措施與防護(租用);」+ 數值 / 「既有家具設備遷移復原」)。
 *    分帶容差取 3 才會把名稱第一行與數值併成同一列;沒有數值、只有名稱的帶就是
 *    上一列的續行。容差取 2 的話一列會被拆成兩列,每天多出一半沒有數值的假項目。
 *
 * ── 項次 ──
 * 此格式沒有項次欄,而且**逐日只列當天施作的項目**(15 天共 30 列上下),
 * 出現序跨天會指到不同項目,故**項次用項目名稱**(同利成/沅隆;見招式 15c)。
 *
 * ── 此格式沒有的東西 ──
 * 沒有契約單價、沒有任何金額,一律 null 不回推。材料表實測全空。
 */

const META_VENDOR_KEY = '宏恩工程有限公司';

const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'kg', '噸', 'T',
  '公尺', '公斤', '平方公尺', '立方公尺', '場', '座', '組', '支', '個', '只', '片',
  '面', '處', '間', '棵', '株', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '才', '天', '日', '人']);

const nfkc = (v) => String(v == null ? '' : v).normalize('NFKC');
const despace = (v) => nfkc(v).replace(/[\s　]/g, '');

function text(v) {
  const s = nfkc(v).replace(/[\r\n]+/g, '').trim();
  return s === '' || /^[-－\s]+$/.test(s) ? null : s;
}

function num(v) {
  const s = nfkc(v).replace(/[,\s　%$]/g, '');
  if (s === '' || s === '-' || s === '－') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const unitOf = (v) => {
  const s = despace(v);
  return s && KNOWN_UNITS.has(s) ? s : null;
};

/** 民國/西元:「115年1月28日」與「115/1/28」兩種寫法都要吃。 */
function dateTextToISO(v) {
  const s = despace(v);
  const m = s.match(/(\d{2,4})年(\d{1,2})月(\d{1,2})日/)
    || s.match(/(\d{2,4})\/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  let y = Number(m[1]);
  if (y < 1911) y += 1911;
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(Number(m[2]))}-${p(Number(m[3]))}`;
}

/** 依 y 分帶。容差 3:同一列的名稱與數值差 2.7(Word 轉 PDF 的基線差)。 */
function bands(items, tol = 3) {
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
const bandWith = (all, re) => all.find((b) => b.items.some((i) => re.test(despace(i.s))));

/** 取某標籤右邊、下一個標籤左邊的字(同一帶內)。 */
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

/**
 * 撈「標籤附近」的數字:標籤佔三行而值在中間那行(見檔頭②),同一帶取不到。
 * @param {Array} items 整頁 items
 * @param {object} label 標籤 item
 * @param {number} x1 右界(下一個標籤的 x)
 */
function numNear(items, label, x1) {
  if (!label) return null;
  const hit = items.filter((it) => it.x >= label.x && it.x < x1
    && it.y <= label.y + 2 && it.y >= label.y - 14 && num(it.s) != null);
  if (!hit.length) return null;
  hit.sort((a, b) => a.x - b.x);
  return num(hit.map((i) => i.s).join(''));
}

/** 以「各表頭的起點 x」為分界歸欄(值靠右印,用 [x, x+w] 會落在界外)。 */
function byColumn(band, xs) {
  const cells = xs.map(() => []);
  for (const it of band.items) {
    const c = it.x + (it.w || 0) / 2;
    let k = 0;
    while (k + 1 < xs.length && c >= xs[k + 1]) k++;
    cells[k].push(it);
  }
  return cells.map((g) => g.map((i) => i.s).join('').trim());
}

/** 解析一頁(一天)。純函式,selfTest 以真實座標重用之。 */
function parsePage(items) {
  const all = bands(items);
  const find = (re) => items.find((it) => re.test(despace(it.s)));

  const bWx = bandWith(all, /^本日天氣/);
  const bName = bandWith(all, /^工程名稱$/);
  const bStart = bandWith(all, /^契約工期$/);
  const wxText = bWx ? bandText(bWx) : '';
  // 日期被切成好幾個 item(11+5+年+1+月+28+日),只能整帶接起來再 regex(見檔頭①)
  const wm = wxText.match(/上午[:：](.+?)下午[:：](.+?)(?:填[表報]日期|$)/);
  const week = (wxText.match(/星期[一二三四五六日天]/) || [])[0];

  const lPlan = find(/^預定進度$/);
  const lActual = find(/^累計進度$/);
  const lMoney = find(/^契約金額$/);

  // ── 明細 ──
  const hName = find(/^施工項目$/);
  const hUnit = find(/^單位$/);
  const hQty = find(/^契約數量$/);
  const hToday = find(/^本日完成數量$/);
  const hCum = find(/^累計完成數量$/);
  const hMemo = find(/^備註$/);
  const dailyRows = [];
  if (hName && hUnit && hQty && hToday && hCum) {
    const xs = [-Infinity, hUnit.x, hQty.x, hToday.x, hCum.x, hMemo ? hMemo.x : Infinity];
    const stop = find(/^營造業專業工程特定施工項目/) || find(/^二、/);
    const bottom = stop ? stop.y : -Infinity;
    const parsed = all
      .filter((b) => b.y < hName.y - 0.5 && b.y > bottom + 0.5)
      .map((b) => {
        // 「營造業專業工程特定施工項目」那一行有時與最後一列名稱只差 2.7,會被併進
        // 同一帶。只用帶的 y 過濾擋不掉它,收下來名稱尾巴會多一串標題(而且不會有
        // 任何欄位變 null)。逐 item 再擋一次。
        const inner = { y: b.y, items: b.items.filter((i) => i.y > bottom + 0.5) };
        const [left, 單位, 契約, 本日, 累計] = byColumn(inner, xs);
        return {
          band: b,
          name: text(left),
          單位: unitOf(單位),
          契約數量: num(契約),
          本日完成數量: num(本日),
          累計完成數量: num(累計),
          hasValue: unitOf(單位) != null || num(契約) != null
            || num(本日) != null || num(累計) != null,
        };
      });
    for (const p of parsed) {
      // 名稱的第一行與數值同一帶(差 2.7),續行則各自成帶印在下面(見檔頭③)。
      // 沒有數值、只有名稱的帶 = 上一列名稱的續行。
      if (!p.hasValue) {
        if (p.name && dailyRows.length) {
          const prev = dailyRows[dailyRows.length - 1];
          prev.工程項目 += p.name;
          prev.項次 = prev.工程項目;
        }
        continue;
      }
      const name = p.name;
      if (!name) continue;
      dailyRows.push({
        // 此格式沒有項次欄,逐日只列當天施作的項目 —— 名稱是唯一穩定的識別
        項次: name,
        工程項目: name,
        單位: p.單位,
        契約單價: null,                                  // 此格式無單價
        契約數量: p.契約數量,
        本日完成數量: p.本日完成數量,
        本日完成金額: null,                              // 此格式無金額
        累計完成數量: p.累計完成數量,
      });
    }
  }

  // ── 出工/機具 ──
  const extras = {};
  let 出工總人數 = null;
  const hCrew = find(/^工別$/);
  const hCrewToday = find(/^本日人數$/);
  const hCrewCum = find(/^累計人數$/);
  const hMach = find(/^機具名稱$/);
  const hMachToday = find(/^本日使用數量$/);
  const hMachCum = find(/^累計使用數量$/);
  if (hCrew && hCrewToday && hCrewCum && hMach && hMachToday) {
    const xs = [-Infinity, hCrewToday.x, hCrewCum.x, hMach.x, hMachToday.x,
      hMachCum ? hMachCum.x : Infinity];
    const stop = all.find((b) => b.y < hCrew.y && /^四、/.test(bandText(b)));
    const bottom = stop ? stop.y : -Infinity;
    const 出工明細 = [];
    const 主要機具 = [];
    for (const b of all) {
      if (b.y >= hCrew.y - 0.5 || b.y <= bottom + 0.5) continue;
      const [工別, 本日, , 機具, 機具本日] = byColumn(b, xs);
      const w = text(工別);
      const n = num(本日);
      if (w && n != null && n > 0) 出工明細.push({ 工別: w, 人數: n });
      if (n != null) 出工總人數 = (出工總人數 || 0) + n;
      const g = text(機具);
      const gn = num(機具本日);
      if (g && gn != null && gn > 0) 主要機具.push({ 名稱: g, 數量: gn });
    }
    if (出工明細.length) extras.出工明細 = 出工明細;
    if (主要機具.length) extras.主要機具 = 主要機具;
  }

  return {
    header: {
      工程名稱: pick(bName, /^工程名稱$/, /^承攬廠商名稱$/),
      填報日期: dateTextToISO((wxText.match(/填[表報]日期[:：](.+)$/) || [])[1] || ''),
      星期: week || null,
      天氣_上午: wm ? text(wm[1]) : null,
      天氣_下午: wm ? text(wm[2]) : null,
      // PDF 印的就是百分數(3.5 / 2),照收不換算
      預定進度: numNear(items, lPlan, lActual ? lActual.x : Infinity),
      實際進度: numNear(items, lActual, lMoney ? lMoney.x : Infinity),
      出工總人數,
      本日累計金額: null,                                // 此格式無金額
      承包廠商: pick(bName, /^承攬廠商名稱$/),
      開工日期: dateTextToISO(pick(bStart, /^開工日期$/) || ''),
    },
    dailyRows,
    extras,
  };
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.extractItems !== 'function') throw new Error('缺少注入的 filetypes.extractItems');
  // .doc 直接進來要明講怎麼辦,不可靜靜回空(見檔頭)
  if (/\.docx?$/i.test(filePath)) {
    throw new Error('宏恩的日誌是 Word 檔:請先用 Word 另存 PDF 再上傳(.doc 沒有可靠的表格讀法)');
  }
  const pages = await ft.extractItems(filePath);
  const total = pages.reduce((a, p) => a + (p.items || []).length, 0);
  if (!total) throw new Error('PDF 沒有文字層(掃描件),無法解析');
  const days = [];
  for (const p of pages) {
    const items = p.items || [];
    if (!items.some((it) => despace(it.s).startsWith('表報編號'))) continue;
    days.push(parsePage(items));
  }
  if (!days.length) throw new Error('找不到「表報編號」頁(此檔非宏恩格式)');
  const filled = days.filter((d) => d.header.填報日期 != null
    || d.dailyRows.some((r) => r.本日完成數量));
  if (!filled.some((d) => d.header.填報日期 != null)) {
    throw new Error('每一天都讀不到填報日期(此檔版面不是宏恩的)');
  }
  return filled.sort((x, y) => String(x.header.填報日期).localeCompare(String(y.header.填報日期)));
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest 用**真實座標**(取自轉出的 PDF 第 1 頁,只換工程名稱)。
 * 三條斷言各對著一個坑:日期被切成七個 item、進度的值與標籤不同帶、
 * 明細的名稱印在數值行的上下兩側。
 */
function selfTest() {
  const it = (x, y, w, s) => ({ x, y, w, s });
  const items = [
    it(243.4, 802.3, 128.0, '公共工程施工日誌'),
    it(48.2, 789.1, 49.9, '表報編號:'), it(98.2, 789.1, 10.1, 'GD'),
    it(108.3, 789.1, 5.0, '-'), it(113.3, 789.1, 15.1, '115'),
    // 天氣與日期同一帶,而且日期被切成七個 item
    it(48.2, 776.2, 79.9, '本日天氣:上午:'), it(128.2, 776.2, 10.0, '晴'),
    it(148.2, 776.2, 30.0, '下午:'), it(178.2, 776.2, 10.0, '陰'),
    it(378.4, 776.2, 49.8, '填報日期:'), it(433.3, 776.2, 10.1, '11'),
    it(443.4, 776.2, 5.0, '5'), it(450.9, 776.2, 10.0, '年'), it(463.4, 776.2, 5.0, '1'),
    it(471.0, 776.2, 10.0, '月'), it(483.5, 776.2, 9.8, '28'), it(495.9, 776.2, 10.0, '日'),
    it(505.9, 776.2, 5.0, '('), it(510.9, 776.2, 19.9, '星期'), it(530.9, 776.2, 10.0, '三'),
    it(540.8, 776.2, 10.1, ') '),
    it(115.6, 754.7, 4.3, '1'), it(119.9, 754.7, 8.4, '14'),
    it(130.6, 754.7, 161.5, '年永隆國小地下桌球室地坪整修工程採購案'),
    it(57.1, 753.6, 48.0, '工程名稱'),
    it(304.6, 753.6, 72.0, '承攬廠商名稱'), it(421.6, 753.6, 96.0, META_VENDOR_KEY),
    it(57.1, 733.2, 48.0, '契約工期'), it(131.4, 733.2, 12.0, '15'), it(146.4, 733.2, 12.0, '天'),
    it(438.4, 733.2, 48.0, '開工日期'), it(500.0, 733.2, 18.0, '115'),
    it(518.0, 733.2, 6.0, '/'), it(524.0, 733.2, 24.0, '1/28'),
    // 進度:標籤在 694.5、值在 686.7(不同帶)
    it(57.1, 694.5, 48.0, '預定進度'), it(228.2, 694.5, 48.0, '累計進度'),
    it(159.1, 686.7, 18.0, '3.5'), it(322.6, 686.7, 6.0, '2'),
    it(370.6, 686.7, 48.0, '契約金額'),
    it(72.1, 678.9, 18.0, '(%)'), it(243.2, 678.9, 18.0, '(%)'),
    it(49.6, 662.9, 414.0, '一、依施工計畫書執行按圖施工概況(含約定之重要施工項目及完成數量等):'),
    it(88.7, 643.1, 48.0, '施工項目'), it(178.7, 643.1, 24.0, '單位'),
    it(214.7, 643.1, 48.0, '契約數量'), it(277.7, 643.1, 72.0, '本日完成數量'),
    it(359.9, 643.1, 72.0, '累計完成數量'), it(486.0, 643.1, 24.0, '備註'),
    // 單行名稱:名稱與數值同一行
    it(76.7, 624.2, 72.0, '本日申報開工'), it(184.7, 624.2, 12.0, '式'),
    it(235.7, 624.2, 6.0, '1'), it(310.7, 624.2, 6.0, '1'), it(392.9, 624.2, 6.0, '1'),
    // 兩行名稱夾著數值行
    it(51.8, 604.5, 27.0, '施工區'), it(78.9, 604.5, 45.0, '管制措施與'),
    it(123.9, 604.5, 18.0, '防護'), it(141.9, 604.5, 4.5, '('), it(146.4, 604.5, 18.0, '租用'),
    it(164.4, 604.5, 9.1, ');'),
    it(184.7, 601.8, 12.0, '式'), it(235.7, 601.8, 6.0, '1'),
    it(304.7, 601.8, 18.0, '0.2'), it(386.9, 601.8, 18.0, '0.2'),
    it(67.7, 592.9, 90.0, '既有家具設備遷移復原'),
    it(49.6, 575.6, 117.0, '營造業專業工程特定施工項目'),
    it(49.6, 536.2, 168.0, '二、工地材料管理概況(含約定之重要材料使用狀況及數量等):'),
  ];

  const d = parsePage(items);
  if (d.header.工程名稱 !== '114年永隆國小地下桌球室地坪整修工程採購案') return false;
  if (d.header.承包廠商 !== META_VENDOR_KEY) return false;
  // 日期被切成 11+5+年+1+月+28+日 七個 item,整帶接起來才讀得出來
  if (d.header.填報日期 !== '2026-01-28' || d.header.星期 !== '星期三') return false;
  if (d.header.開工日期 !== '2026-01-28') return false;
  if (d.header.天氣_上午 !== '晴' || d.header.天氣_下午 !== '陰') return false;
  // 進度的值與標籤不同帶
  if (d.header.預定進度 !== 3.5 || d.header.實際進度 !== 2) return false;
  if (d.dailyRows.length !== 2) return false;
  const [r1, r2] = d.dailyRows;
  if (r1.工程項目 !== '本日申報開工' || r1.項次 !== r1.工程項目) return false;
  if (r1.單位 !== '式' || r1.契約數量 !== 1 || r1.本日完成數量 !== 1) return false;
  // 名稱印在數值行的上下兩側,要照原順序接回來
  if (r2.工程項目 !== '施工區管制措施與防護(租用);既有家具設備遷移復原') return false;
  if (r2.單位 !== '式' || r2.本日完成數量 !== 0.2 || r2.累計完成數量 !== 0.2) return false;
  if (r2.契約單價 !== null || r2.本日完成金額 !== null) return false;
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
  _internal: { parsePage, bands, numNear },
};
