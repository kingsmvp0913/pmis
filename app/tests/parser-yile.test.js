/**
 * 以勒綠能光電有限公司(永慶高中運動場整修)施工日誌讀取器測試。
 *
 * fixture 是唯一那份 xlsx(12 個日分頁 + 一張叫「可改」的範本分頁)。
 * 「可改」帶著與最後一天相同的填報日期,是這家唯一會靜默出錯的地方。
 */
const fs = require('fs');
const path = require('path');
const mod = require('../server/parsers/vendors/samples/yile.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'yile.xlsx');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest(filetypes)).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商;名字對不上 vendors 表的話,
// 讀取器讀得動也永遠不會被叫到,而且不會有任何錯誤訊息。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('以勒綠能光電有限公司');
});

describe('parseAll(永慶 12 天)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 120000);

  // 「可改」那張範本分頁的填報日期是 8/22(與最後一天同一天)。不去重的話那天會
  // 出現兩次,SP3 噴 D1 而且累計被算兩遍。
  test('範本分頁「可改」不可變成第 13 天', () => {
    expect(days.length).toBe(12);
    const dates = days.map((d) => d.header.填報日期);
    expect(new Set(dates).size).toBe(12);
    expect(dates[0]).toBe('2025-08-11');
    expect(dates[11]).toBe('2025-08-22');
  });

  test('header 逐欄', () => {
    const h = days.find((d) => d.header.填報日期 === '2025-08-20').header;
    expect(h.工程名稱).toBe('114年度修整建運動場地');
    expect(h.承包廠商).toBe('以勒綠能光電有限公司');
    expect(h.開工日期).toBe('2025-08-11');
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    expect(h.預定進度).toBe(0.333);                      // 分數保留原值
  });

  // 每一天都把全部 9 個項目照同一順序列完,所以出現序是穩定的位置事實
  test('每天 9 列、項次是出現序', () => {
    for (const d of days) {
      expect(d.dailyRows).toHaveLength(9);
      expect(d.dailyRows.map((r) => r.項次)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    }
    expect(days[0].dailyRows[0].工程項目).toBe('工程告示牌與職安衛告示牌(租用)');
  });

  test('單位走白名單(「盞」在字典裡),數量讀得到', () => {
    const r = days[0].dailyRows[3];
    expect(r).toMatchObject({ 項次: '4', 單位: '盞', 契約數量: 10 });
    for (const d of days) for (const x of d.dailyRows) {
      expect(x.單位).not.toBeNull();
      expect(x.契約數量).not.toBeNull();
    }
  });

  test('此格式沒有單價與金額,一律 null 不回推', () => {
    for (const d of days) {
      expect(d.header.本日累計金額).toBeNull();
      for (const r of d.dailyRows) {
        expect(r.契約單價).toBeNull();
        expect(r.本日完成金額).toBeNull();
      }
    }
  });
});

test('parse 回第一天', async () => {
  const one = await mod.parse(FIXTURE, ctx);
  expect(one.header.填報日期).toBe('2025-08-11');
});

// 回空陣列會被上游當成「這份沒有資料」而靜靜略過,一定要吵。
test('讀不動的檔要明確失敗', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/表報編號/);
});

// 工程會標準表單很多家在用,「表報編號:」錨點會碰巧命中別家的檔。
test('錨點對上但版面不同的檔要明確失敗', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'qiquan.xlsx'), ctx))
    .rejects.toThrow(/讀不到填報日期|表報編號/);
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'yile.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('以勒綠能光電有限公司');
});
