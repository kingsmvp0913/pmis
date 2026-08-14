/**
 * lilong.pmisparser.js — 力龍企業有限公司施工日誌讀取器(四湖國小跳遠場地整修工程)
 *
 * vendorKey 取自**決標公告的得標廠商**(四湖跳遠決標公告);日誌每一頁的
 * 「承攬廠商」欄也寫同一個名稱,兩邊一致。
 *
 * ── 頁面結構:封面 1 頁 + 一天 1 頁 ──
 * 7 月份 32 頁 = 封面 + 31 天;8 月份 7 頁 = 封面 + 6 天。
 * 封面沒有「施 工 項 目」表頭,靠這個排除(不是靠頁碼)。
 *
 * ── 這家的關鍵坑:表頭只有 6 個標籤,資料卻有 7 個數值欄 ──
 * ```
 * 表頭 x: 施工項目107  單位258  契約數量307  本日完成數量369  完成累計數量421  備註506
 * 值   x: 項次27  名稱52/65  單位263  契約數量320~340  本日391  累計429~433
 *         契約單價477~494   契約複價509~512   累計完成金額534~546
 * ```
 * **「備註」那個表頭(x506)底下印的其實是契約複價**,右邊三欄完全沒有表頭。
 * 所以欄界不能照 skill 的通例用表頭起點推,只有前三個數值欄推得出來;
 * 右邊三欄的界取自**實測值分佈**(見 COLS)。版面若改版,結果會是整欄變 null
 * (完整性關卡看得見),不會靜靜錯位到隔壁欄。
 *
 * 界訂得對不對用算式核對過:契約單價 × 契約數量 = 契約複價,
 * 逐列成立(350×59=20650、6×9940=59640、28866×1=28866)。
 *
 * ── 沒有「本日完成金額」欄 ──
 * 7 個數值欄裡沒有任何一欄是本日金額(x534 那欄 = 累計完成數量 × 契約單價,
 * 是**累計**金額:38×625、0.19×8247 都對得上)。所以 `本日完成金額` 一律 null,
 * 不拿累計金額頂替。
 *
 * ── 累計完成金額欄會印出 `########` ──
 * 這份 PDF 是從 Excel 印的,欄寬不足就印井字號(7 月 p10 第 9 列實測)。
 * `text()`/`num()` 把整串 `#` 當 null。該欄不進 schema,但同樣的字串若哪天
 * 出現在單價欄,結果會是 null 而不是一個假數字。
 *
 * ── 沒有「星期」欄 ──
 * 版面上沒有星期,`星期` 一律 null,不由日期回推(那是系統代填,不是來源資料)。
 *
 * ── 廠商把日期填錯的那一天,照收不修 ──
 * `四湖國小-跳遠場-施工日誌-7月.pdf` 的 p9 與 p10 **日期都印 115/7/9**(缺 7/8);
 * `…-7月(1).pdf` 是修正版,p9=7/8、p10=7/9,兩檔其餘內容逐格相同。
 * 本讀取器照實回兩個 7/9,不去重也不推算——那是真的資料錯,要讓 SP3 的 D1 報出來
 * (沿用義鼎那案的立場)。挑哪一份是上層多檔合併層的事。
 *
 * ── 名稱被 Excel 欄寬截掉 ──
 * 項次 4「跳遠場預定地及既有砂坑開挖清運廢土方,整地,」以逗號結尾,後面的字
 * 被隔壁欄蓋掉、PDF 裡根本沒有那些字元。照收,不補字。
 */

const META_VENDOR_KEY = '力龍企業有限公司';

// 實測列距 16,一列各段的 y 差 0.2~1.5。取 2 可以把同一列的五段併起來,
// 又不會併掉相鄰列。
const BAND = 2;

/**
 * 欄界(item/token 的**中心** x 落在哪一段)。前三個數值欄的界推得自表頭起點,
 * 右邊三欄沒有表頭,界取自實測值分佈(見檔頭)。
 * 契約複價與累計完成金額不進統一 schema,列在這裡是為了**擋住它們**——
 * 少了這兩段,右邊的數字會被最近的欄(契約單價)收走。
 */
const COLS = [
  ['項次', 0, 40],
  ['工程項目', 40, 255],
  ['單位', 255, 300],
  ['契約數量', 300, 365],
  ['本日完成數量', 365, 420],
  ['累計完成數量', 420, 470],
  ['契約單價', 470, 502],
  ['_契約複價', 502, 528],
  ['_累計完成金額', 528, 560],
];

const 表頭 = /施\s*工\s*項\s*目/;
const 項次型 = /^([0-9]{1,3}|[壹貳貮参參肆伍陸陆柒捌玖拾])$/;

const LABELS = ['工程名稱', '承攬廠商', '核定工期', '累計工期', '剩餘工期', '展延工期',
  '預定進度', '開工日期', '預定完工日期', '實際進度', '填表日期', '本日天氣上午', '下午',
  '表單編號'];

const nfkc = (v) => String(v == null ? '' : v).normalize('NFKC');
const despace = (v) => nfkc(v).replace(/[\s　]/g, '');

function text(v) {
  const s = nfkc(v).replace(/[\r\n]+/g, '').trim();
  // `########` 是 Excel 欄寬不足印出來的,不是資料(見檔頭)。
  if (s === '' || /^-+$/.test(s) || s === '－' || /^#+$/.test(s)) return null;
  return s;
}

function num(v) {
  const s = nfkc(v).replace(/[,\s　%]/g, '');
  if (s === '' || s === '-' || s === '－' || /^#+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 民國「115/7/1」→ 西元 ISO;已是西元(4 位年)則照原樣拆。 */
function rocSlash(s) {
  const m = despace(s).match(/^(\d{2,4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const year = y < 1911 ? y + 1911 : y;
  return `${year}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
}

const centerOf = (it) => it.x + (it.w || 0) / 2;

/** 依 y 分視覺行(容差 BAND),行內依 x 排序。 */
function bands(items) {
  const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const out = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - it.y) <= BAND) { last.items.push(it); continue; }
    out.push({ y: it.y, items: [it] });
  }
  for (const b of out) b.items.sort((a, b2) => a.x - b2.x);
  return out;
}

const bandText = (b) => b.items.map((i) => i.s).join('');

/**
 * 一個 item 切成 token,各自算中心 x。
 * 本日完成數量欄印的是 `"  -"`(前面兩個空白),整個丟給 num() 會拿到 null 沒錯,
 * 但中心會落在欄的左邊界外。用 `w / s.length` 推每個字元的 x 才歸得對。
 */
function tokens(it) {
  const s = String(it.s);
  const per = s.length ? (it.w || 0) / s.length : 0;
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    out.push({ s: m[0], cx: it.x + (m.index + m[0].length / 2) * per });
  }
  return out;
}

const colOf = (cx) => (COLS.find(([, a, b]) => cx >= a && cx < b) || [null])[0];

/**
 * 標籤右邊的值。同一帶裡有好幾組「標籤 值」(開工日期 / 預定完工日期 / 實際進度
 * 三組在同一帶),所以**撞到下一個標籤就停**,不能一路往右找。
 */
function valueAfter(bs, label, ok) {
  for (const b of bs) {
    const i = b.items.findIndex((it) => despace(it.s).includes(label));
    if (i < 0) continue;
    for (let k = i + 1; k < b.items.length; k++) {
      const s = text(b.items[k].s);
      if (s == null) continue;
      if (LABELS.some((L) => despace(s).includes(L))) break;
      if (!ok || ok(s)) return s;
    }
  }
  return null;
}

const 數字型 = (s) => /^[\d,]+(\.\d+)?$/.test(despace(s));
const 百分型 = (s) => /%$/.test(despace(s));
const 日期型 = (s) => /^\d{2,4}\/\d{1,2}\/\d{1,2}$/.test(despace(s));

/** 「二、當日材料使用數量」「三、當日出工人數及機具使用情形」那兩張橫表。 */
function 橫表(bs, 標題re, 值列標籤) {
  const ti = bs.findIndex((b) => 標題re.test(despace(bandText(b))));
  if (ti < 0) return null;
  // 標題下方第一個帶是欄名列;欄名可能分散在兩個 y(容差內併不起來),所以往下找
  // **第一個含有已知列標籤的帶之前**的所有帶都算欄名。
  const 欄名 = [];
  let vi = -1;
  for (let k = ti + 1; k < bs.length; k++) {
    if (值列標籤.some((L) => despace(bandText(bs[k])).includes(L))) { vi = k; break; }
    for (const it of bs[k].items) {
      const s = text(it.s);
      if (!s || /^(材料名稱|工別\/機具)$/.test(despace(s))) continue;
      // **單位的上標數字也印在欄名區的高度**(M3 的「3」在 y361,欄名在 y374/373.8,
      // 值在 y357;它比欄名低、比值高)。不擋掉的話它會變成一個叫「3」的材料,
      // 而且因為離單位「M」更近,單位會被指派到它身上、真正的材料欄拿不到單位。
      if ((it.w || 0) <= 4.5 && /^\d$/.test(despace(s))) continue;
      欄名.push({ s: despace(s), cx: centerOf(it) });
    }
  }
  if (vi < 0 || !欄名.length) return null;
  const 取值 = (帶) => {
    const out = new Map();
    for (const it of 帶.items) {
      for (const t of tokens(it)) {
        const s = text(t.s);
        if (s == null || 值列標籤.some((L) => despace(s).includes(L))) continue;
        // 名稱欄本身在最左(x<70),不是值
        if (t.cx < 70) continue;
        let best = null; let bd = Infinity;
        for (const c of 欄名) {
          const d = Math.abs(c.cx - t.cx);
          if (d < bd) { bd = d; best = c; }
        }
        // 同一欄的值可能分成兩個 item(混凝土的「0.0」與單位「M」),要串起來——
        // 只取第一個的話單位整個掉,而「級配」那欄剛好是黏成一個 item 的「7M」,
        // 於是同一張表裡一欄有單位、一欄沒有,看起來像來源資料不一致。
        // 右端取的是**整個 item** 的右端(不是 token 的),上標數字對齊的是 item 右緣。
        if (best && bd <= 30) {
          const prev = out.get(best.s);
          out.set(best.s, { s: (prev ? prev.s : '') + s, 右端: it.x + (it.w || 0) });
        }
      }
    }
    return out;
  };
  return { 欄名: 欄名.map((c) => c.s), 本日: 取值(bs[vi]), 值帶: bs[vi] };
}

/**
 * 單位的上標數字(M3 的 3)。它**不在單位那個 item 裡,也不在同一個 y 帶**:
 * 實測「M」在 y356.5 x120.7 w4.5、上標「3」在 y361.0 x125.3 w3.0;
 * 「7M」在 y356.5 x220.9 w9.1、上標「3」在 y230.0。位置規律得可以合回來:
 * **y 高 2~7pt、x 落在 item 右緣 -2~+8、寬度 ≤4.5 的單一數字**。
 * 不合回來的話單位會變成裸的「M」——那是個看起來合法卻錯的單位,比 null 危險。
 */
function 上標(bs, 值帶, 右端x) {
  for (const b of bs) {
    if (b.y <= 值帶.y || b.y - 值帶.y > 7) continue;
    for (const it of b.items) {
      if ((it.w || 0) > 4.5) continue;
      const s = despace(it.s);
      if (!/^\d$/.test(s)) continue;
      if (it.x >= 右端x - 2 && it.x <= 右端x + 8) return s;
    }
  }
  return null;
}

/** 單一頁 → 單日結構。純函式,不碰檔案系統(selfTest 直接餵座標)。 */
function parsePage(items) {
  const bs = bands(items);
  const hb = bs.find((b) => 表頭.test(despace(bandText(b))));
  if (!hb) return null;                                   // 封面

  const 填報日期 = rocSlash(valueAfter(bs, '填表日期', 日期型) || '');
  const 天氣上 = valueAfter(bs, '本日天氣上午', (s) => !數字型(s));
  const 天氣下 = valueAfter(bs, '下午', (s) => !數字型(s));

  // 累計金額印在「一、依施工計畫書執行按圖施工概況:」那一帶的右端:
  // x459 是契約總金額、x522 才是累計完成金額。兩個都是純數字,只能靠 x 分。
  let 本日累計金額 = null;
  const cb = bs.find((b) => /依施工計畫書執行按圖施工概況/.test(despace(bandText(b))));
  if (cb) {
    for (const it of cb.items) {
      for (const t of tokens(it)) {
        if (t.cx > 500 && 數字型(t.s)) 本日累計金額 = num(t.s);
      }
    }
  }

  const header = {
    工程名稱: valueAfter(bs, '工程名稱'),
    填報日期,
    星期: null,                                            // 版面上沒有(見檔頭)
    天氣_上午: 天氣上,
    天氣_下午: 天氣下,
    // PDF 印的是百分數(22.12%),照收不換算(既有慣例,SP3 的 H1 自己統一)。
    預定進度: num(valueAfter(bs, '預定進度', 百分型) || ''),
    實際進度: num(valueAfter(bs, '實際進度', 百分型) || ''),
    出工總人數: null,
    本日累計金額,
    承包廠商: valueAfter(bs, '承攬廠商'),
    開工日期: rocSlash(valueAfter(bs, '開工日期', 日期型) || ''),
  };

  const dailyRows = [];
  for (const b of bs) {
    if (b.y >= hb.y) continue;
    const cells = new Map();
    for (const it of b.items) {
      for (const t of tokens(it)) {
        const c = colOf(t.cx);
        if (!c) continue;
        cells.set(c, (cells.get(c) || '') + t.s);
      }
    }
    const 項次 = despace(cells.get('項次') || '');
    if (!項次型.test(項次)) continue;
    const 名稱 = text(cells.get('工程項目') || '');
    if (!名稱) continue;
    dailyRows.push({
      項次,
      工程項目: 名稱,
      單位: text(cells.get('單位') || ''),
      契約單價: num(cells.get('契約單價') || ''),
      契約數量: num(cells.get('契約數量') || ''),
      本日完成數量: num(cells.get('本日完成數量') || ''),
      本日完成金額: null,                                   // 這家沒有這一欄(見檔頭)
      累計完成數量: num(cells.get('累計完成數量') || ''),
    });
  }

  const extras = {};
  const 出工 = 橫表(bs, /當日出工人數及機具使用情形/, ['本日人數', '累計人數']);
  if (出工) {
    const 明細 = []; const 機具 = [];
    for (const 名 of 出工.欄名) {
      const cell = 出工.本日.get(名);
      const v = num(cell ? cell.s : '');
      // 「工別/機具」是同一張表,靠名稱結尾的「工」分:普通工/水泥工/鋼筋工/板模工
      // 是工別,貨車/挖土機/鏟裝機是機具。
      if (/工$/.test(名)) 明細.push({ 工別: 名, 人數: v });
      else 機具.push({ 名稱: 名, 數量: v });
    }
    if (明細.length) {
      extras.出工明細 = 明細;
      const 人 = 明細.map((d) => d.人數).filter((n) => n != null);
      if (人.length) header.出工總人數 = 人.reduce((a, b2) => a + b2, 0);
    }
    if (機具.length) extras.主要機具 = 機具;
  }
  const 材料 = 橫表(bs, /當日材料使用數量/, ['本日使用數量', '累計使用數量']);
  if (材料) {
    const list = [];
    for (const 名 of 材料.欄名) {
      const cell = 材料.本日.get(名);
      if (cell == null) continue;
      // 數字與單位黏在同一個 item(「7M」「114.3KG」);單位的上標數字另外合回來。
      const m = despace(cell.s).match(/^([\d,]+(?:\.\d+)?)([A-Za-z一-鿿]+)?$/);
      if (!m) continue;
      let 單位 = m[2] || null;
      const sup = 上標(bs, 材料.值帶, cell.右端);
      if (單位 && sup) 單位 += sup;
      list.push({ 名稱: 名, 單位, 數量: num(m[1]) });
    }
    if (list.length) extras.主要材料 = list;
  }

  return { header, dailyRows, extras };
}

async function parseAll(filePath, ctx) {
  if (/\.docx?$/i.test(filePath)) throw new Error('力龍讀取器只吃 PDF,請先把 .doc/.docx 轉成 PDF');
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.extractItems !== 'function') throw new Error('力龍讀取器需要注入 ctx.filetypes');
  const pages = await ft.extractItems(filePath);
  const days = [];
  for (const p of pages) {
    const d = parsePage(p.items || p);
    if (d) days.push(d);
  }
  // 「施 工 項 目」是工程會標準表單的共通錨點,別家的檔也會命中。**全部讀不到日期
  // 就 throw**——只回空陣列比讀不動更糟,上游會當成「這份沒有資料」靜靜略過。
  if (!days.length || !days.some((d) => d.header.填報日期)) {
    throw new Error('這份檔案讀不到任何施工日誌日期,可能不是力龍的施工日誌');
  }
  return days;
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0];
}

/**
 * 內建樣本 = 7 月份 PDF 第 2 頁(115/7/1)的**真實座標**,只留 header 區、表頭、
 * 前兩列、項次 4(名稱被欄寬截斷的那列)與費用第一列(名稱縮排到 x65)。
 * 自己編一組整齊的座標驗不到「`"  -"` 的中心要靠 w/s.length 推」這種真實形狀。
 */
const SAMPLE = [{ x: 73.7, y: 812.8, w: 13.7, s: '020' }, { x: 73.7, y: 798.1, w: 9, s: '晴' }, { x: 120.1, y: 798.1, w: 27.4, s: '下午:' }, { x: 150.8, y: 798.1, w: 9, s: '雨' }, { x: 288.2, y: 781.8, w: 36.5, s: '核定工期' }, { x: 373.7, y: 781.8, w: 9, s: '天' }, { x: 91.1, y: 765.5, w: 9.1, s: '20' }, { x: 129.7, y: 765.5, w: 9, s: '天' }, { x: 150.8, y: 765.5, w: 36.5, s: '剩餘工期' }, { x: 222.1, y: 765.5, w: 9.1, s: '40' }, { x: 262.8, y: 765.5, w: 9, s: '天' }, { x: 288.2, y: 765.5, w: 36.5, s: '展延工期' }, { x: 373.9, y: 765.5, w: 9, s: '天' }, { x: 258.5, y: 716.5, w: 18.2, s: '單位' }, { x: 28.8, y: 700.2, w: 4.5, s: '1' }, { x: 262.8, y: 700.2, w: 9, s: '式' }, { x: 390.6, y: 700.6, w: 12.2, s: '  -' }, { x: 433.3, y: 700.6, w: 12.2, s: '1.0' }, { x: 481.4, y: 700.6, w: 16.3, s: '8000' }, { x: 512.3, y: 701.4, w: 12, s: '8000' }, { x: 537, y: 701.4, w: 15, s: '8,000' }, { x: 529.9, y: 701.4, w: 9, s: '   ' }, { x: 28.8, y: 683.9, w: 4.5, s: '2' }, { x: 262.8, y: 683.9, w: 9, s: '式' }, { x: 390.6, y: 684.2, w: 12.2, s: '  -' }, { x: 433.3, y: 684.2, w: 12.2, s: '0.5' }, { x: 477.4, y: 684.2, w: 20.4, s: '12000' }, { x: 509.3, y: 685.1, w: 15, s: '12000' }, { x: 537, y: 685.1, w: 15, s: '6,000' }, { x: 529.9, y: 685.1, w: 9, s: '   ' }, { x: 28.8, y: 651.2, w: 4.5, s: '4' }, { x: 262.8, y: 651.2, w: 9.1, s: 'M2' }, { x: 390.6, y: 651.6, w: 12.2, s: '  -' }, { x: 429.2, y: 651.6, w: 16.3, s: '59.0' }, { x: 485.5, y: 651.6, w: 12.2, s: '350' }, { x: 509.3, y: 652.4, w: 15, s: '20650' }, { x: 534, y: 652.4, w: 18, s: '20,650' }, { x: 529.9, y: 652.4, w: 6, s: '  ' }, { x: 26.5, y: 471.7, w: 9, s: '貳' }, { x: 262.8, y: 471.7, w: 9, s: '式' }, { x: 429.2, y: 472.1, w: 16.3, s: '0.19' }, { x: 480, y: 472.9, w: 15, s: '8,247' }, { x: 512.3, y: 472.9, w: 12, s: '8247' }, { x: 537, y: 472.9, w: 15, s: '1,567' }, { x: 529.9, y: 472.9, w: 9, s: '   ' }, { x: 12.8, y: 812.8, w: 45.6, s: '表單編號:' }, { x: 281, y: 814, w: 114.2, s: '公共工程施工日誌' }, { x: 13.4, y: 799, w: 57.1, s: '本日天氣上午:' }, { x: 402.5, y: 797.4, w: 45.6, s: '填表日期:' }, { x: 491.3, y: 798.4, w: 35.3, s: '115/7/1' }, { x: 23.8, y: 782.3, w: 36.5, s: '工程名稱' }, { x: 73.6, y: 782.6, w: 97.9, s: '四湖國小跳遠場地整修工程' }, { x: 344.2, y: 782.3, w: 9.1, s: '60' }, { x: 400.1, y: 782.3, w: 36.5, s: '承攬廠商' }, { x: 465.5, y: 782.3, w: 72.9, s: '力龍企業有限公司' }, { x: 27.7, y: 733.3, w: 157.1, s: '一、依施工計畫書執行按圖施工概況:' }, { x: 459.2, y: 733.7, w: 24.5, s: '478372' }, { x: 522.1, y: 733.7, w: 28.6, s: '119,932' }, { x: 505.8, y: 733.7, w: 16.3, s: '    ' }, { x: 522.1, y: 733.7, w: 4, s: ' ' }, { x: 107.2, y: 717, w: 50.1, s: '施 工 項 目' }, { x: 306.7, y: 717, w: 36.5, s: '契約數量' }, { x: 369.1, y: 717.4, w: 49, s: '本日完成數量' }, { x: 421.3, y: 717.4, w: 50.4, s: '完成累計數量' }, { x: 506, y: 717, w: 18.2, s: '備註' }, { x: 23.8, y: 766, w: 36.5, s: '累計工期' }, { x: 346.4, y: 766, w: 4.5, s: '0' }, { x: 400.1, y: 766, w: 36.5, s: '預定進度' }, { x: 488, y: 766, w: 27.4, s: '22.12%' }, { x: 23.7, y: 749.6, w: 36.5, s: '開工日期' }, { x: 144.5, y: 749.6, w: 36.5, s: '115/6/12' }, { x: 264.1, y: 749.6, w: 54.7, s: '預定完工日期' }, { x: 341.7, y: 749.6, w: 36.5, s: '115/8/10' }, { x: 400.1, y: 749.6, w: 36.5, s: '實際進度' }, { x: 488.3, y: 749.6, w: 27.4, s: '25.07%' }, { x: 51.7, y: 651.7, w: 200.6, s: '跳遠場預定地及既有砂坑開挖清運廢土方,整地,' }, { x: 335, y: 651.5, w: 25.2, s: '59.00' }, { x: 51.7, y: 700.7, w: 200.6, s: '工程告示牌、職業安全衛生告示牌與工區管制設施' }, { x: 340.1, y: 700.4, w: 20.2, s: '1.00' }, { x: 51.7, y: 684.4, w: 145.9, s: '施工動線開闢及損壞復原,保護措施' }, { x: 340.1, y: 684.1, w: 20.2, s: '1.00' }, { x: 65, y: 472.2, w: 173.2, s: '職業安全衛生管理費與施工環境保護與清潔' }, { x: 340.1, y: 472, w: 20.2, s: '1.00' }];

function selfTest() {
  const d = parsePage(SAMPLE);
  if (!d) return false;
  const h = d.header;
  if (h.填報日期 !== '2026-07-01') return false;
  if (h.工程名稱 !== '四湖國小跳遠場地整修工程') return false;
  if (h.承包廠商 !== META_VENDOR_KEY) return false;
  if (h.開工日期 !== '2026-06-12') return false;
  if (h.天氣_上午 !== '晴' || h.天氣_下午 !== '雨') return false;
  if (h.預定進度 !== 22.12 || h.實際進度 !== 25.07) return false;
  if (h.本日累計金額 !== 119932) return false;
  if (h.星期 !== null) return false;
  if (d.dailyRows.length !== 4) return false;
  const r1 = d.dailyRows[0];
  if (r1.項次 !== '1' || r1.單位 !== '式') return false;
  if (r1.契約數量 !== 1 || r1.契約單價 !== 8000) return false;
  // 「  -」要變 null,不是 0——沒填與填 0 是兩件事
  if (r1.本日完成數量 !== null || r1.累計完成數量 !== 1) return false;
  if (r1.本日完成金額 !== null) return false;
  const r4 = d.dailyRows[2];
  if (r4.項次 !== '4' || r4.單位 !== 'M2') return false;
  // 單價 × 契約數量 = 契約複價(350 × 59 = 20650),欄界訂對了才會成立
  if (r4.契約單價 !== 350 || r4.契約數量 !== 59 || r4.累計完成數量 !== 59) return false;
  const fee = d.dailyRows[3];
  if (fee.項次 !== '貳' || fee.契約單價 !== 8247) return false;
  if (fee.工程項目 !== '職業安全衛生管理費與施工環境保護與清潔') return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '出工總人數', '本日累計金額', '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約單價', '契約數量',
      '本日完成數量', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parsePage, bands, tokens, colOf, SAMPLE },
};
