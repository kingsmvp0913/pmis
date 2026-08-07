/**
 * 德信土木包工業(石龜國小漏水改善)施工日誌讀取器測試。
 *
 * fixture 是 `石龜施工日誌.xlsx`(32 天)。這家最容易讀錯的是表格右外側那個
 * 「完成數量*單價」欄——標籤沒說是哪一個完成數量,實際是**累計**金額。
 * 第 20 天(4/18)是唯一驗得到這件事的形狀:本日完成數量空著、累計有值。
 */
const fs = require('fs');
const path = require('path');
const mod = require('../server/parsers/vendors/samples/dexin.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'dexin.xlsx');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest(filetypes)).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商;名字對不上 vendors 表的話,
// 讀取器讀得動也永遠不會被叫到,而且不會有任何錯誤訊息。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('德信土木包工業');
});

describe('parseAll(石龜 32 天)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 120000);

  test('依填報日期排序', () => {
    expect(days.length).toBe(32);
    expect(days[0].header.填報日期).toBe('2026-03-30');
    expect(days[days.length - 1].header.填報日期).toBe('2026-04-30');
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('雲林縣114年度災損復原-石龜國小辦理A棟及C1棟漏水改善工程');
    expect(h.承包廠商).toBe('德信土木包工業');
    expect(h.開工日期).toBe('2026-03-30');               // 來源是「115年3月30日」字串
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    expect(h.預定進度).toBe(0.00786);                    // 分數保留原值
    expect(h.出工總人數).toBe(2);
    expect(days[0].extras.出工明細).toEqual([
      { 工別: '大工', 人數: 1 }, { 工別: '小工', 人數: 1 },
    ]);
  });

  // 每一天都把全部 18 個項目照同一順序列完(不是只列當天施作的),所以出現序是
  // 穩定的位置事實。實測與發包後經費總表逐項同序:1~13 對到契約表的 1~13,
  // 14~18 對到費用項貳~陸(編號體系不同,由 SP3 的名稱後備索引對應)。
  test('項次用出現序,每天 18 列且順序固定', () => {
    for (const d of days) {
      expect(d.dailyRows).toHaveLength(18);
      expect(d.dailyRows.map((r) => r.項次)).toEqual(
        Array.from({ length: 18 }, (_, i) => String(i + 1)),
      );
    }
    expect(days[0].dailyRows[0].工程項目).toBe('工程告示牌、交通管制與防護措施(租用)');
    expect(days[0].dailyRows[13].工程項目).toBe('職業安全衛生管理費(壹*1%)');
  });

  // 契約數量欄橫跨 5~7,欄 6 是單位字串「式」、欄 7 是數量的複本。
  // 取合併範圍的第一欄才拿得到數字。
  test('契約數量取合併範圍最左欄,不會被中間那格單位字串弄成 null', () => {
    for (const d of days) for (const r of d.dailyRows) {
      expect(r.契約數量).not.toBeNull();
      expect(r.單位).not.toBeNull();
      expect(r.契約單價).not.toBeNull();
    }
  });

  // 欄19「完成數量*單價」= 累計完成數量 × 單價,不是本日。第 20 天項次 1 的
  // 本日是空的、累計是 1,而欄19 = 50000 —— 照標籤收會讓 B3/B4 每天硬錯。
  test('本日完成金額留 null(來源那欄其實是累計金額)', () => {
    const d = days.find((x) => x.header.填報日期 === '2026-04-18');
    expect(d.dailyRows[0]).toMatchObject({
      項次: '1', 本日完成數量: null, 累計完成數量: 1, 契約單價: 50000, 本日完成金額: null,
    });
    expect(d.dailyRows[9]).toMatchObject({ 項次: '10', 累計完成數量: 110, 契約單價: 400 });
    for (const x of days) for (const r of x.dailyRows) expect(r.本日完成金額).toBeNull();
  });
});

test('parse 回第一天', async () => {
  const one = await mod.parse(FIXTURE, ctx);
  expect(one.header.填報日期).toBe('2026-03-30');
});

// 同案的 PDF 版餵給 SheetJS 會回空活頁簿。回空陣列會被上游當成「這份沒有資料」
// 而靜靜略過,一定要吵。
test('讀不動的檔要明確失敗,不可回空陣列', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/表報編號/);
});

// 工程會標準表單很多家在用,「表報編號：」錨點會碰巧命中別家的檔。
test('錨點對上但版面不同的檔要明確失敗', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'qiquan.xlsx'), ctx))
    .rejects.toThrow(/讀不到填表日期|表報編號/);
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'dexin.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('德信土木包工業');
});
