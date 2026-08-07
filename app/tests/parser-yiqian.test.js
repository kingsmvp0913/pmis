/**
 * 宜謙營造工程有限公司施工日誌讀取器測試。
 *
 * 兩份 fixture 是刻意配對的最小組合:
 *   yiqian.pdf  = 饒平 `0711A-0711A.pdf`(1 天,176KB)—— PDF 路徑,**沒有中類**,
 *                 項次就是 1..N,用來釘住「大類(壹)不當前綴」這個決定。
 *   yiqian.xlsx = 棒球場 `0923A-0930A.xlsx`(8 天,70KB)—— Excel 路徑,**有中類**
 *                 (一/二/三 各自從 1 編號),用來釘住「中類要當前綴」。
 * 兩者合起來才驗得到「前綴只在會撞號時出現」;只測其中一份都會漏掉另一半。
 */
const fs = require('fs');
const path = require('path');
const mod = require('../server/parsers/vendors/samples/yiqian.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const PDF = path.join(__dirname, 'fixtures', 'yiqian.pdf');
const XLSX = path.join(__dirname, 'fixtures', 'yiqian.xlsx');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest()).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商;名字對不上 vendors 表的話,
// 讀取器讀得動也永遠不會被叫到,而且不會有任何錯誤訊息。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('宜謙營造工程有限公司');
});

describe('PDF(饒平 0711A,無中類)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(PDF, ctx); }, 120000);

  test('一天兩頁(第一聯+第二聯)合成一天', () => {
    expect(days.length).toBe(1);
    expect(days[0].header.填報日期).toBe('2024-07-11');
    expect(days[0].header.星期).toBe('星期四');
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    // 工程名稱取第二聯抬頭:第一聯那格是斷成兩個 item 的,接回來容易少字
    expect(h.工程名稱).toBe('雲林縣莿桐鄉饒平國民小學辦理「高級中等以下學校運動操場及周邊設施整建計畫」');
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    // PDF 印的是「53.01 %」——已經是百分數,不可再 ×100(Excel 版才是分數)
    expect(h.預定進度).toBe(53.01);
    expect(h.實際進度).toBe(59.86);
    // 出工總人數只加「本日人數」;誤取旁邊的累計欄會讓整份的人數暴增
    expect(h.出工總人數).toBe(7);
    expect(h.本日累計金額).toBeNull();
  });

  test('出工明細只收有出工的工別(表上其餘工別填 0)', () => {
    expect(days[0].extras.出工明細).toEqual([
      { 工別: '現場工程師', 人數: 1 }, { 工別: '普通工', 人數: 6 },
    ]);
    // 「二、工地材料管理概況」那張表在此家實測全空,不是沒讀
    expect(days[0].extras.主要材料).toBeUndefined();
  });

  // 這一案沒有中類,項次就是發包後經費總表上的 1..N。若照大類(壹)加前綴變成
  // 「壹.1」,SP3 的 contractByNo 會全部對不上,每天每列噴一個 E1 硬錯。
  test('沒有中類時項次不加前綴,與經費總表同號', () => {
    const rows = days[0].dailyRows;
    expect(rows[0]).toMatchObject({ 項次: '壹', 工程項目: '直接工程', 單位: null, 契約數量: null });
    expect(rows[1].項次).toBe('1');
    expect(rows.filter((r) => r.單位 == null).length).toBe(1);   // 只有「壹」是大類列
  });

  // 費用項(貳~陸)的項次也是中文數字,但它們有單位有數量,是真項目 —— 既不能
  // 當成大類丟掉,也不能加前綴。
  test('費用項是明細不是大類,且不加前綴', () => {
    const fee = days[0].dailyRows[days[0].dailyRows.length - 1];
    expect(fee).toMatchObject({ 項次: '陸', 單位: '式', 契約數量: 1, 本日完成數量: 0.0209 });
  });

  test('數值右對齊會超出表頭欄界,仍要歸對欄', () => {
    const r16 = days[0].dailyRows.find((r) => r.項次 === '16');
    expect(r16).toMatchObject({
      工程項目: '鋪13mm MDI 全密式PU跑道面層',
      單位: 'M2', 契約數量: 2590, 本日完成數量: 100, 累計完成數量: 900,
    });
  });

  // 兩聯都沒有單價與金額。用「數量×別處的單價」回推是推導不是來源值。
  test('此格式沒有單價與金額,一律 null 不回推', () => {
    for (const r of days[0].dailyRows) {
      expect(r.契約單價).toBeNull();
      expect(r.本日完成金額).toBeNull();
    }
  });
});

describe('Excel(棒球場 0923A,有中類)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(XLSX, ctx); }, 120000);

  test('一天一個「第一聯」區塊,依日期排序', () => {
    expect(days.map((d) => d.header.填報日期)).toEqual([
      '2025-09-23', '2025-09-24', '2025-09-25', '2025-09-26',
      '2025-09-27', '2025-09-28', '2025-09-29', '2025-09-30',
    ]);
  });

  // 中類各自從 1 編號,不加前綴的話同一天會有三個「1」,SP3 以項次為鍵的
  // prevCum/dailySum 會把三個不同項目的累計混在一起。
  test('中類當前綴,項次在一天之內唯一', () => {
    const rows = days[0].dailyRows;
    expect(rows.filter((r) => r.單位 == null).map((r) => r.項次)).toEqual(['壹', '一', '二', '三']);
    expect(rows.find((r) => r.工程項目.includes('工程告示牌')).項次).toBe('一.1');
    expect(rows.find((r) => r.工程項目.includes('新設RC地坪')).項次).toBe('三.1');
    const nos = rows.map((r) => r.項次);
    expect(new Set(nos).size).toBe(nos.length);
  });

  // Excel 的進度欄存的是分數(0.0028),PDF 印的是「0.28 %」。不換算會差 100 倍。
  test('Excel 的進度是分數,要換算成百分數', () => {
    expect(days[7].header.預定進度).toBe(0.28);
    expect(days[7].header.實際進度).toBe(0.89);
  });

  test('儲存格裡的手動換行要併掉,全形標點折半形(才與 PDF 版同一個名稱)', () => {
    const r = days[7].dailyRows.find((x) => x.項次 === '二.1');
    expect(r.工程項目).toBe('產品,整地,開挖多餘土方回填基地南側整平,表層石塊清運');
  });

  // dailyRows 一律取第二聯:第一聯的「一、施工項目」表只列當天有施作的項目,
  // 收它會讓每天的明細列數不一樣,累計與契約比對全部落空。
  test('明細取第二聯(完整明細),每天列數固定', () => {
    for (const d of days) expect(d.dailyRows.length).toBe(50);
    const 有量 = days[7].dailyRows.filter((r) => r.本日完成數量);
    expect(有量.length).toBe(7);                        // 當天只做了 2 項 + 5 個費用項
  });

  test('出工總人數只加本日人數', () => {
    expect(days[7].header.出工總人數).toBe(5);
    expect(days[7].extras.出工明細).toEqual([
      { 工別: '現場工程師', 人數: 1 }, { 工別: '普通工', 人數: 4 },
    ]);
  });
});

test('parse 回第一天', async () => {
  const one = await mod.parse(XLSX, ctx);
  expect(one.header.填報日期).toBe('2025-09-23');
});

// 回空陣列會被上游當成「這份沒有資料」而靜靜略過。此家 25 份日誌裡有 11 份是
// 無文字層的掃描件,一定要吵。
test('沒有文字層的 PDF 要 throw,不可回空陣列', () => {
  expect(() => mod._internal.parsePages([{ page: 1, items: [] }, { page: 2, items: [] }]))
    .toThrow(/文字層/);
});

test('別家格式的檔要明確失敗', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow();
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'yiqian.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('宜謙營造工程有限公司');
});
