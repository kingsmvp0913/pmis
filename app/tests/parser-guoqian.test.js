/**
 * 國謙營造有限公司(林內國中射箭場側網修復)施工日誌讀取器測試。
 *
 * fixture 是 `施工日報表(…).xlsx`(22 天)。這家的天是**橫向**排列的(一天 16 欄),
 * 縱向疊了第一聯與第二聯,而且同一列的「預定進度」是百分數、「實際進度」是分數。
 * 3/26 那天是唯一驗得到「完成金額是本日不是累計」的形狀。
 */
const fs = require('fs');
const path = require('path');
const mod = require('../server/parsers/vendors/samples/guoqian.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'guoqian.xlsx');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest(filetypes)).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商;名字對不上 vendors 表的話,
// 讀取器讀得動也永遠不會被叫到,而且不會有任何錯誤訊息。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('國謙營造有限公司');
});

describe('parseAll(林內射箭場 22 天)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 120000);

  // 天的起點由「表頭列裡值為『項次』的每一欄」推出,不是寫死的 16 欄:
  // 另一份檔有 42 天(672 欄),寫死會少讀一半。
  test('橫向 22 天,依填報日期排序', () => {
    expect(days.length).toBe(22);
    expect(days[0].header.填報日期).toBe('2026-03-11');
    expect(days[days.length - 1].header.填報日期).toBe('2026-04-01');
  });

  test('header 逐欄(標籤與值黏在同一格,要在格內切)', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('114-Danas-E-05-01-011-雲林縣林內鄉林內國中射箭場側網毀損修復災後復建工程');
    expect(h.承包廠商).toBe('國謙營造有限公司');
    expect(h.填報日期).toBe('2026-03-11');
    expect(h.星期).toBe('星期三');
    expect(h.開工日期).toBe('2026-03-11');
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
  });

  // 同一列的兩個進度欄單位不同:預定是百分數(第 42 天 63)、實際是分數(第 42 天 1)。
  // 不統一的話同一天的兩個數字沒有可比性。
  test('預定是百分數、實際是分數,統一成百分數', () => {
    expect(days[0].header.預定進度).toBe(0.5);
    expect(days[0].header.實際進度).toBe(0.1227);         // 來源 0.00122671…
    const last = days[days.length - 1].header;
    expect(last.預定進度).toBe(17.9);
    expect(last.實際進度).toBe(29.9754);                  // 來源 0.29975…
  });

  test('明細取第二聯(完整明細),大類不帶金額', () => {
    const rows = days[0].dailyRows;
    expect(rows.length).toBe(11);                         // 大類 1 + 細項 5 + 費用項 5
    expect(rows[0]).toMatchObject({ 項次: '壹', 工程項目: '直接工程', 單位: null, 契約單價: null });
    expect(rows[0].本日完成金額).toBeNull();              // 大類列不可帶著金額 0
    expect(rows[1]).toMatchObject({
      項次: '1', 工程項目: '既有傾斜高網修復', 單位: 'M', 契約單價: 2050, 契約數量: 30,
    });
  });

  // 「完成金額」標籤沒說是本日還是累計。3/26 項次 3:本日 1、累計 2、單價 7150,
  // 金額 7150 —— 是本日 × 單價;若收成累計金額會是 14300,B3/B4 每天硬錯。
  test('完成金額是本日金額(用單價×本日數量交叉核對)', () => {
    const d = days.find((x) => x.header.填報日期 === '2026-03-26');
    const r3 = d.dailyRows.find((r) => r.項次 === '3');
    const r4 = d.dailyRows.find((r) => r.項次 === '4');
    expect(r3).toMatchObject({ 本日完成數量: 1, 累計完成數量: 2, 契約單價: 7150, 本日完成金額: 7150 });
    expect(r4).toMatchObject({ 本日完成數量: 0.2, 累計完成數量: 0.4, 本日完成金額: 14300 });
    for (const r of d.dailyRows.filter((x) => /^\d+$/.test(x.項次) && x.本日完成金額)) {
      expect(r.本日完成金額).toBeCloseTo(r.本日完成數量 * r.契約單價, 2);
    }
  });

  test('出工只加本日人數;機具照收', () => {
    const d = days.find((x) => x.header.填報日期 === '2026-03-26');
    expect(d.header.出工總人數).toBe(2);
    expect(d.extras.出工明細).toEqual([{ 工別: '鐵工', 人數: 2 }]);
    expect(d.extras.主要機具).toEqual([{ 名稱: '怪手', 數量: 1 }]);
  });

  // 廠商在費用項(貳~陸)的「完成數量」欄填的是金額(56.53 = 完成金額,而契約數量是 1 式)。
  // 照收讓 SP3 的 C1「累計超過契約數量」報出來——那是來源資料的問題,不是讀取器。
  test('費用項的數量欄照收(廠商填的是金額,不是讀取器讀錯)', () => {
    const d = days.find((x) => x.header.填報日期 === '2026-03-26');
    const fee = d.dailyRows.find((r) => r.項次 === '貳');
    expect(fee.契約數量).toBe(1);
    expect(fee.本日完成數量).toBeCloseTo(56.5333, 3);
    expect(fee.本日完成金額).toBeCloseTo(56.5333, 3);
  });
});

test('parse 回第一天', async () => {
  const one = await mod.parse(FIXTURE, ctx);
  expect(one.header.填報日期).toBe('2026-03-11');
});

// 回空陣列會被上游當成「這份沒有資料」而靜靜略過,一定要吵。
test('讀不動的檔要明確失敗,不可回空陣列', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/第二聯表頭/);
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'guoqian.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('國謙營造有限公司');
});
