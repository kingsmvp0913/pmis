/**
 * xincheng.pmisparser.js — 新成室內裝修企業社施工日誌讀取器(古坑國中小棒球宿舍)
 *
 * vendorKey 取自**決標公告的得標廠商**(`模板\決標公告\古坑國中小棒球宿舍_決標公告.pdf`
 * 與 `114年棒球宿舍設備改善計畫工程_決標公告.pdf`,兩份同案);日誌每天的
 * 「承攬廠商」欄也寫同一個名稱,兩邊一致。
 *
 * ── 版面:一天一個 73 列的區塊,單一分頁 ──
 * ```
 * 分頁 `施工日報`(另有 `施工封面`,非日誌)
 * 錨點  欄1 去空白 === '公共工程施工日誌'
 * +1   天氣(欄4 上午 / 欄7 下午)、填表日期(欄12,Excel 序號)
 * +2   工程名稱(欄2)、承攬廠商(欄13)
 * +3   核定工期(欄2)
 * +4   開工日期(欄2)、竣工日期(欄13)
 * +5   預定進度(欄2)、實際進度(欄13)
 * +7   明細表頭
 * +8   大類「壹 直接工程費」——沒有單位,不是項目列
 * +9~  明細:項次0 名稱1 單位7 契約數量8 本日完成數量11 累計完成數量13
 * ```
 *
 * ── ⚠️ 契約單價一律 null:那一欄在**隱藏欄**裡 ──
 * 表格右邊的 R~V 五欄**全部是隱藏的**,裝著廠商自己的計算區:
 * `S 累計完成數量 / T 單價 / U 累計完成金額(=S*T)`。
 * 承辦人在畫面上根本看不到那個價格。
 *
 * 而它與發包經費總表**17 項裡有 14 項不同**(床組 19,500/18,000、水電 46,160/31,000、
 * 小便斗 12,000/**14,500**——日誌反而高),但**逐項複價的合計兩邊都是 1,193,638、
 * 差額 0**。也就是同一筆總價的另一種分攤方式。
 *
 * 承辦人 2026-08-15 裁決:**不讀隱藏欄的單價,留空**。契約單價一律以發包經費總表
 * 為準(系統本來就有那一份)。讀進來的話,這一案每天都會被 SP3 的 E6 擋下,
 * 而原因只是廠商表格裡一個他自己都看不到的計算欄。
 *
 * 📌 通則:**隱藏欄是廠商的工作區,不是他申報的內容**,不要當成來源資料讀。
 *
 * ⚠️ **名稱一定要取欄 1(B),不可以取欄 2~6。**
 * 這份的 B 欄與 C~G 欄是**兩個不同的合併區,而且裝著兩套不同的名稱**——
 * C~G 是上一個案子的殘留沒改乾淨。從項次 12 起就對不上:
 * ```
 * 項次12  B=安裝360度吊扇            C~G=小便斗拆除與更新
 * 肆      B=包商管理及利潤費(約壹*7%)  C~G=安全衛生及管理費(約0.6%)
 * 陸      B=營業稅((壹~伍)*5％)       C~G=營造綜合保險費(約0.4%)(B)
 * ```
 * 以發包經費總表(17 項)逐項核對過:**B 欄與總表一致**。
 * 取錯欄不會有任何欄位變 null,只會靜靜地把一半的項目名稱換成別案的
 * (見 parser-pipeline-gaps 的「名稱錯了不會變 null」)。
 *
 * ⚠️ **契約數量取欄 8,不是欄 9/10。** 費用項目那幾列欄 8 是 1(正確),
 * 而欄 9~10 是另一個合併區、值恆為 10(來源殘留)。主體項目三欄同值,
 * 所以只看主體的話兩種取法都對——費用列才會現形。
 *
 * ── 進度:預定是百分數、實際是分數,同一列兩種單位 ──
 * 實測第 1 天「預定 1 / 實際 0.0128」、第 2 天「預定 10 / 實際 …」,
 * 即預定寫 `1`=1%、實際寫 `0.0128`=1.28%。這正是 skill 記的國謙那型。
 * 依**整份的最大值**判斷各欄的單位再統一輸出百分數(見 `統一進度單位`)。
 */

const META_VENDOR_KEY = '新成室內裝修企業社';

const SHEET_RE = /施工日報/;
const ANCHOR = '公共工程施工日誌';
const ANCHOR_COL = 1;

// 一天的區塊高度。實測 27 天全部等距 73 列,但仍以錨點定位、不靠這個數字推算——
// 廠商多插一列就整份錯開,而錯開之後每天都還是「讀得到東西」。
const OFFSET = {
  天氣: 1, 名稱: 2, 工期: 3, 日期: 4, 進度: 5, 明細起: 9,
};
const COL = {
  天氣上午: 4, 天氣下午: 7, 填表日期: 12,
  工程名稱: 2, 承攬廠商: 13,
  核定工期: 2, 開工日期: 2, 竣工日期: 13,
  預定進度: 2, 實際進度: 13,
  項次: 0, 名稱: 1, 單位: 7, 契約數量: 8,
  本日完成數量: 11, 累計完成數量: 13,
  // 欄 18~20(S/T/U)是隱藏的計算區,刻意不讀——見檔頭。留著常數是為了讓下一個人
  // 知道那裡有東西、而且是**故意**不讀的,不是漏掉。
  _隱藏_累計完成數量: 18, _隱藏_單價: 19, _隱藏_累計完成金額: 20,
};

// 單位一律白名單(禁樣式判定:名稱裡的 PVC/LED 會被當成單位)
const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'kg', '噸', 'T',
  '公尺', '公斤', '平方公尺', '立方公尺', '場', '座', '組', '支', '個', '只', '片',
  '面', '處', '間', '棵', '株', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '才', '天', '日', '人']);

const ITEM_NO_RE = /^(\d{1,3}|[壹貳貮參参肆伍陸陆柒捌玖拾])$/;

const despace = (v) => String(v == null ? '' : v).replace(/[\s　]/g, '');

function text(v) {
  const s = String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
  return s === '' || /^-+$/.test(s) || s === '－' ? null : s;
}

function num(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(/[,\s　%﹪]/g, '');
  if (s === '' || s === '-' || s === '－') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const unitOf = (v) => {
  const s = despace(v);
  return s && KNOWN_UNITS.has(s) ? s : null;
};

/** 天區塊的起始列(錨點在欄 1)。 */
function blockStarts(grid) {
  const out = [];
  (grid || []).forEach((row, i) => {
    if (despace((row || [])[ANCHOR_COL]) === ANCHOR) out.push(i);
  });
  return out;
}

/**
 * 一天的明細。讀到「沒有單位」的列即停——底下接的是
 * 「營造業專業工程特定施工項目」與材料/出工表,收進來會變成假項目。
 * 大類列(壹 直接工程費)同樣沒有單位,自然被擋掉。
 */
function parseItemRows(grid, start) {
  const out = [];
  for (let i = start + OFFSET.明細起; i < grid.length; i++) {
    const r = grid[i] || [];
    const u = unitOf(r[COL.單位]);
    if (!u) break;
    const 項次 = despace(r[COL.項次]);
    if (!ITEM_NO_RE.test(項次)) break;
    const 名稱 = text(r[COL.名稱]);
    if (!名稱) break;
    out.push({
      項次,
      工程項目: 名稱,
      單位: u,
      // 可見的表格沒有單價欄;隱藏欄那個是廠商的計算區,不讀(見檔頭)
      契約單價: null,
      契約數量: num(r[COL.契約數量]),
      本日完成數量: num(r[COL.本日完成數量]),
      本日完成金額: null,          // 同理:金額只在隱藏欄
      累計完成數量: num(r[COL.累計完成數量]),
    });
  }
  return out;
}

/**
 * 進度欄的單位統一成百分數。
 *
 * 同一列裡預定寫 `1`(=1%)、實際寫 `0.0128`(=1.28%),兩欄單位不同。
 * 靠**整份的最大值**判斷:一份日誌的進度不會超過 100%,所以最大值 ≤ 1.5 的那一欄
 * 是分數(×100),否則已經是百分數。
 * ⚠️ 不可以逐日判斷——開工前幾天兩欄都很小,每天判會得到不同的單位。
 */
function 統一進度單位(values) {
  const 有值 = values.filter((v) => v != null && Number.isFinite(v));
  if (!有值.length) return (v) => v;
  const max = Math.max(...有值.map(Math.abs));
  return max <= 1.5 ? (v) => (v == null ? null : v * 100) : (v) => v;
}

/** 一天(純函式,不碰檔案系統;selfTest 直接餵 grid)。 */
function parseDay(grid, start, serialToISO) {
  const at = (off, col) => (grid[start + off] || [])[col];
  const 日期序號 = num(at(OFFSET.天氣, COL.填表日期));
  return {
    header: {
      工程名稱: text(at(OFFSET.名稱, COL.工程名稱)),
      填報日期: 日期序號 == null ? null : serialToISO(日期序號),
      星期: null,                                     // 版面上沒有,不由日期回推
      天氣_上午: text(at(OFFSET.天氣, COL.天氣上午)),
      天氣_下午: text(at(OFFSET.天氣, COL.天氣下午)),
      預定進度: num(at(OFFSET.進度, COL.預定進度)),   // 單位由 parseAll 統一
      實際進度: num(at(OFFSET.進度, COL.實際進度)),
      出工總人數: null,
      本日累計金額: null,
      承包廠商: text(at(OFFSET.名稱, COL.承攬廠商)),
      開工日期: (() => {
        const s = num(at(OFFSET.日期, COL.開工日期));
        return s == null ? null : serialToISO(s);
      })(),
    },
    dailyRows: parseItemRows(grid, start),
    extras: {},
  };
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.readWorkbook !== 'function') throw new Error('缺少注入的 filetypes.readWorkbook');
  const wb = ft.readWorkbook(filePath);
  const name = (wb.sheetNames || []).find((n) => SHEET_RE.test(n));
  if (!name) throw new Error('找不到「施工日報」分頁,可能不是新成的施工日誌');
  const grid = wb.sheets[name];
  const starts = blockStarts(grid);
  const days = starts.map((s) => parseDay(grid, s, ft.excelSerialToISO));

  // 進度單位統一(見 統一進度單位):要拿整份的值判斷,故在這裡做而不是 parseDay 裡
  const 預定 = 統一進度單位(days.map((d) => d.header.預定進度));
  const 實際 = 統一進度單位(days.map((d) => d.header.實際進度));
  for (const d of days) {
    d.header.預定進度 = 預定(d.header.預定進度);
    d.header.實際進度 = 實際(d.header.實際進度);
  }

  // 「公共工程施工日誌」是工程會標準表單的共通錨點,別家的檔也會命中。
  // **全部讀不到日期就 throw**——回空陣列會被上游當成「這份沒有資料」靜靜略過。
  if (!days.length || !days.some((d) => d.header.填報日期)) {
    throw new Error('這份檔案讀不到任何施工日誌日期,可能不是新成的施工日誌');
  }
  return days;
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * 內建 grid 小樣本,不需注入也不 require node_modules(讀取器裝到
 * data/vendor-parsers/ 時那裡沒有)。欄位落點與值取自真實檔第 1 天。
 */
function selfTest() {
  const g = [];
  const put = (r, pairs) => { g[r] = g[r] || []; for (const [c, v] of pairs) g[r][c] = v; };
  put(0, [[1, '公共工程施工日誌']]);
  put(1, [[4, '晴'], [7, '雨'], [12, 46227]]);
  put(2, [[2, '114年棒球宿舍設備改善計畫工程'], [13, '新成室內裝修企業社']]);
  put(3, [[2, 30]]);
  put(4, [[2, 46227], [13, 46256]]);
  put(5, [[2, 1], [13, 0.0128]]);
  put(7, [[1, '工程項目'], [7, '單位']]);
  put(8, [[0, '壹'], [1, '直接工程費']]);                       // 大類:沒有單位
  put(9, [[0, '1'], [1, '安裝鋁擠型床組上下舖'], [7, '組'], [8, 18], [13, 0], [19, 18000], [20, 0]]);   // 欄19 是隱藏的單價,不可被讀進來
  // 名稱在 B(欄1)、別案殘留在 C~G(欄2);契約數量在欄 8、欄 9~10 是殘留的 10
  put(10, [[0, '12'], [1, '安裝360度吊扇'], [2, '小便斗拆除與更新'], [7, '組'], [8, 10], [9, 10], [10, 10], [19, 3000], [20, 0]]);
  put(11, [[0, '貳'], [1, '職業安全衛生管理費（壹*1%）'], [2, '安全衛生及管理費(約0.6%)'],
    [7, '式'], [8, 1], [9, 10], [10, 10], [11, 1], [13, 1], [19, 10391], [20, 10391]]);
  put(12, [[0, '營造業專業工程特定施工項目']]);                 // 沒有單位 → 明細到此為止

  const serialToISO = (n) => (n === 46227 ? '2026-07-24' : (n === 46256 ? '2026-08-22' : null));
  const d = parseDay(g, 0, serialToISO);
  if (d.header.填報日期 !== '2026-07-24') return false;
  if (d.header.工程名稱 !== '114年棒球宿舍設備改善計畫工程') return false;
  if (d.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (d.header.開工日期 !== '2026-07-24') return false;
  if (d.header.天氣_上午 !== '晴' || d.header.天氣_下午 !== '雨') return false;
  if (d.header.星期 !== null) return false;
  if (d.dailyRows.length !== 3) return false;                  // 大類與「營造業…」都要被擋掉
  const [a, b, fee] = d.dailyRows;
  if (a.項次 !== '1' || a.單位 !== '組' || a.契約數量 !== 18) return false;
  // 隱藏欄的單價/金額一律不讀(承辦人 2026-08-15 裁決),樣本裡放了 18000 就是要釘住這件事
  if (a.契約單價 !== null || a.本日完成金額 !== null) return false;
  // 取錯欄的話這裡會變成別案的「小便斗拆除與更新」
  if (b.工程項目 !== '安裝360度吊扇') return false;
  if (fee.項次 !== '貳' || fee.工程項目 !== '職業安全衛生管理費（壹*1%）') return false;
  // 費用列的契約數量要取欄 8(=1),取欄 9/10 會拿到殘留的 10
  if (fee.契約數量 !== 1) return false;
  if (fee.本日完成數量 !== 1 || fee.累計完成數量 !== 1) return false;

  // 進度單位:預定是百分數、實際是分數,兩欄分別判斷
  const 預定 = 統一進度單位([1, 10, 30]);
  const 實際 = 統一進度單位([0.0128, 0.05, 0.3]);
  if (預定(10) !== 10) return false;
  if (Math.abs(實際(0.0128) - 1.28) > 1e-9) return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約數量',
      '本日完成數量', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parseDay, parseItemRows, blockStarts, 統一進度單位 },
};
