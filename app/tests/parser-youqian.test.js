/**
 * 有謙營造有限公司(元長國小校園鋪面改善)施工日誌讀取器測試。
 *
 * fixture 是 `施工日誌-雲林縣元長國小舖面.xlsx`——這家目前只有這一份(30 天 / 780 列)。
 *
 * 斷言集中在三個「錯了不會有任何欄位變 null」的地方:
 *   ① 實做金額是**累計**金額,收成本日金額的話每天的本日金額都會變成累計值
 *   ② 合計列下面還有一列只有欄 17(又印一次實際進度),取錯會讓累計金額變 0.0043
 *   ③ 工程名稱那格從第 3 天起是數值 0,讀成字串 "0" 會讓 SP3 每天噴一個 G1
 */
const fs = require('fs');
const path = require('path');
const mod = require('../server/parsers/vendors/samples/youqian.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'youqian.xlsx');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest(filetypes)).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商(元長鋪面決標公告.pdf,A1150522);
// 名字對不上 vendors 表的話,讀取器讀得動也永遠不會被叫到,而且不會有錯誤訊息。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('有謙營造有限公司');
});

describe('parseAll(元長國小鋪面)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 120000);

  test('30 天,依填報日期排序且不重複', () => {
    expect(days.length).toBe(30);
    const dates = days.map((d) => d.header.填報日期);
    expect(dates[0]).toBe('2026-07-09');
    expect(dates[dates.length - 1]).toBe('2026-08-07');
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('元長國小辦理114年度充實設施設備-校園鋪面改善工程');
    expect(h.承包廠商).toBe('有謙營造有限公司');
    expect(h.開工日期).toBe('2026-07-09');
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    // 進度是分數(0.437%),保留原值不換算 —— 換算成百分數會讓 SP3 的 H1 每天噴假警報
    expect(h.預定進度).toBe(0.0001);
    expect(h.實際進度).toBeCloseTo(0.0043738, 6);
    expect(h.出工總人數).toBe(2);                      // 大工 1 + 小工 1,累計欄不可混進來
    expect(h.星期).toBeNull();                         // 此格式不提供
  });

  // ③ 廠商從第 3 天起把工程名稱那格存成數值 0(30 天裡 28 天)。
  test('工程名稱是數值 0 的那些天回 null,不是字串 "0"', () => {
    expect(days.filter((d) => d.header.工程名稱 != null)).toHaveLength(2);
    expect(days[29].header.工程名稱).toBeNull();
  });

  // ② 合計列的下一列只有欄 17(實際進度又印一次),取錯會變成 0.0043
  test('本日累計金額取合計列的實做金額,逐日遞增', () => {
    expect(days[0].header.本日累計金額).toBe(19316);
    expect(days[1].header.本日累計金額).toBe(208316);
    expect(days[29].header.本日累計金額).toBe(653016);
  });

  test('每天都是完整的 26 項清單,項次用出現序', () => {
    const 列數 = days.map((d) => d.dailyRows.length);
    expect(new Set(列數)).toEqual(new Set([26]));
    expect(days[0].dailyRows.map((r) => r.項次)).toEqual(
      Array.from({ length: 26 }, (_, i) => String(i + 1)),
    );
  });

  test('明細逐欄(第一列與最後一列)', () => {
    const r1 = days[0].dailyRows[0];
    expect(r1.工程項目).toBe('工程告示牌與職安告示牌(租用)');
    expect(r1.單位).toBe('式');
    expect(r1.契約數量).toBe(1);
    expect(r1.契約單價).toBe(6000);
    expect(r1.本日完成數量).toBe(1);
    expect(r1.累計完成數量).toBe(1);
    const r26 = days[0].dailyRows[25];
    expect(r26.工程項目).toBe('營業稅((壹~伍)*5%)');    // NFKC 把全形括號/％折成半形
    expect(r26.契約單價).toBe(210299);
  });

  // ① 這是這家最容易靜默錯的一格:標籤寫「實做金額」,值卻是累計金額。
  // 780 列裡 780 列符合「= 累計 × 單價」,只有 594 列同時符合「= 本日 × 單價」。
  // 7/10 的第一列正是分得出來的那種:本日沒施工(null),實做金額卻印著 6000
  // (= 累計 1 × 單價 6000)。收成本日金額的話,這天會憑空多出 6000 的施作。
  test('本日完成金額一律 null —— 來源的「實做金額」是累計金額', () => {
    const rows = days.flatMap((d) => d.dailyRows);
    expect(rows.filter((r) => r.本日完成金額 != null)).toHaveLength(0);
    const r = days[1].dailyRows[0];
    expect(r.本日完成數量).toBeNull();
    expect(r.累計完成數量).toBe(1);
    expect(r.契約單價).toBe(6000);
  });

  // 廠商只在有施工的列填本日完成數量(780 列裡 766 列是空的)。補 0 會讓
  // SP3 的 B2「累計 = 前一日 + 本日」看起來永遠成立,真的漏填就再也看不見。
  test('沒施工的列本日完成數量回 null,不補 0', () => {
    const rows = days.flatMap((d) => d.dailyRows);
    expect(rows.filter((r) => r.本日完成數量 == null)).toHaveLength(766);
    expect(days[1].dailyRows[4].本日完成數量).toBe(9);   // 有施工的那列照讀
  });

  test('必要欄位零缺漏', () => {
    const rows = days.flatMap((d) => d.dailyRows);
    expect(rows).toHaveLength(780);
    expect(rows.filter((r) => r.單位 == null)).toHaveLength(0);
    expect(rows.filter((r) => r.契約數量 == null)).toHaveLength(0);
    expect(rows.filter((r) => r.契約單價 == null)).toHaveLength(0);
  });
});

// 「表報編號：」是至少 8 家共用的錨點。光靠錨點會假陽性:讀得出一堆天、卻每天都是空的。
// 這種「讀得動」比讀不動更危險——上游會把空白當成「這天沒施工」。
test('錨點對上但版面不同的檔要明確失敗,不可回一堆空白天', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'qiquan.xlsx'), ctx))
    .rejects.toThrow(/讀不到填報日期|表報編號|明細表頭/);
});

// 晉林那個「只在安裝時發作」的 bug 只有這條抓得到(裝到 data/vendor-parsers/ 後
// 該目錄沒有 node_modules,讀取器若自己 require 套件會靜默失敗)。
test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'youqian.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('有謙營造有限公司');
});
