/**
 * 優和建設有限公司(台西國中活動中心舞台整修)施工日誌讀取器測試。
 *
 * fixture 是 1103 那份 .xls(45 個日分頁;比 1111 那份小,而且帶著「欄 0 是簡稱、
 * 欄 1~3 才是完整敘述」那個坑)。這家最重要的事實是**明細只有名稱**:
 * 單位與三個數量欄整份全空,所以測試要釘住「名稱讀得完整」與「數量欄不可憑空生值」。
 */
const fs = require('fs');
const path = require('path');
const mod = require('../server/parsers/vendors/samples/youhe.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'youhe.xls');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest(filetypes)).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商;名字對不上 vendors 表的話,
// 讀取器讀得動也永遠不會被叫到,而且不會有任何錯誤訊息。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('優和建設有限公司');
});

describe('parseAll(台西舞台 45 天)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 180000);

  test('一天一分頁,依日期排序去重', () => {
    expect(days.length).toBe(45);
    expect(days[0].header.填報日期).toBe('2025-10-01');
    expect(days[days.length - 1].header.填報日期).toBe('2025-11-14');
    const dates = days.map((d) => d.header.填報日期);
    expect(new Set(dates).size).toBe(dates.length);
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('台西國中活動中心舞台整修工程');
    expect(h.承包廠商).toBe('優和建設有限公司');
    expect(h.開工日期).toBe('2025-10-01');
    expect(h.天氣_上午).not.toBeNull();
    expect(typeof h.預定進度).toBe('number');            // 分數保留原值
  });

  // 這家的明細只有「工程項目」一欄有東西:單位與三個數量欄整份全空。
  // 那是來源就沒有,不是讀取器讀不到——所以一律 null,不可為了看起來完整而塞 0。
  test('明細只有名稱,數量欄一律 null', () => {
    const rows = days.flatMap((d) => d.dailyRows);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.工程項目).toBeTruthy();
      expect(r.項次).toBe(r.工程項目);
      expect(r.單位).toBeNull();
      expect(r.契約數量).toBeNull();
      expect(r.本日完成數量).toBeNull();
      expect(r.累計完成數量).toBeNull();
      expect(r.契約單價).toBeNull();
      expect(r.本日完成金額).toBeNull();
    }
  });

  // 名稱欄橫跨欄 0~3,但欄 0 與欄 1~3 是兩個不同的儲存格:欄 0 是簡稱、
  // 欄 1~3 才是完整敘述。只讀欄 0 會少掉後半段。
  test('名稱取那一段裡最長的相異值', () => {
    const names = days.flatMap((d) => d.dailyRows.map((r) => r.工程項目));
    expect(names).toContain('拆除清運既有舞台布幕,既有舞台鋼構架除鏽上漆');
    expect(names).not.toContain('拆除清運既有舞台布幕');
  });

  test('出工只加本日人數', () => {
    const d = days.find((x) => x.extras.出工明細);
    expect(d.header.出工總人數).toBe(
      d.extras.出工明細.reduce((s, c) => s + c.人數, 0),
    );
  });
});

test('parse 回第一天', async () => {
  const one = await mod.parse(FIXTURE, ctx);
  expect(one.header.填報日期).toBe('2025-10-01');
}, 180000);

// 回空陣列會被上游當成「這份沒有資料」而靜靜略過,一定要吵。
test('讀不動的檔要明確失敗', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/表報編號/);
});

// 工程會標準表單很多家在用,「表報編號：」錨點會碰巧命中別家的檔。
test('錨點對上但版面不同的檔要明確失敗', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'qiquan.xlsx'), ctx))
    .rejects.toThrow(/讀不到日期|表報編號/);
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'youhe.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('優和建設有限公司');
});
