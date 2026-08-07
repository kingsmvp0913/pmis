/**
 * 嘉原營造有限公司(民生國小綜合球場)施工日誌讀取器測試。
 *
 * fixture 是 `民生(球場2)日誌-0401-0430.pdf`(30 天,一天一頁)。這家的明細很稀疏
 * ——30 天裡只有 8 天填了東西——所以測試要同時釘住「有填的那幾天讀對」與
 * 「沒填的天不要生出假資料」。
 */
const fs = require('fs');
const path = require('path');
const mod = require('../server/parsers/vendors/samples/jiayuan.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'jiayuan.pdf');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest()).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商;名字對不上 vendors 表的話,
// 讀取器讀得動也永遠不會被叫到,而且不會有任何錯誤訊息。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('嘉原營造有限公司');
});

describe('parseAll(民生球場 4 月)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 180000);

  test('一天一頁', () => {
    expect(days.length).toBe(30);
    expect(days[0].header.填報日期).toBe('2025-04-01');
    expect(days[days.length - 1].header.填報日期).toBe('2025-04-30');
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('雲林縣民生國小綜合球場整建工程');
    expect(h.承包廠商).toBe('嘉原營造有限公司');
    expect(h.開工日期).toBe('2025-02-28');
    expect(h.星期).toBe('星期二');
    // 上午/下午的值印在兩個標籤之間,取到帶尾會把「填表日期」那串也吃進來
    expect(h.天氣_上午).toBe('雨');
    expect(h.天氣_下午).toBe('晴');
    // PDF 印的就是百分數(6.93%),照收不換算
    expect(h.預定進度).toBe(6.93);
    expect(h.實際進度).toBe(4.29);
  });

  // 表頭置中、值靠左:名稱(x≈87)落在「合約項次」表頭(x≈56)與「工程項目」表頭
  // (x≈176)之間。用表頭欄界判斷會把整個名稱歸進項次欄。
  test('名稱靠左印仍要與項次分開', () => {
    const d = days.find((x) => x.header.填報日期 === '2025-04-14');
    expect(d.dailyRows).toEqual([
      {
        項次: '1', 工程項目: '工程告示牌、職安衛告示牌、施工圍籬與交通管制設施(租用)',
        單位: '式', 契約單價: null, 契約數量: 1, 本日完成數量: 1, 本日完成金額: null, 累計完成數量: 1,
      },
      {
        項次: '2', 工程項目: '施工動線開闢與復原;測量與放樣',
        單位: '式', 契約單價: null, 契約數量: 1, 本日完成數量: 1, 本日完成金額: null, 累計完成數量: 1,
      },
    ]);
  });

  // 費用項的項次是中文大寫,但它們有單位有數量,是真項目不是大類。
  test('費用項是明細不是大類', () => {
    const d = days.find((x) => x.header.填報日期 === '2025-04-09');
    expect(d.dailyRows.map((r) => r.項次)).toEqual(['貳', '参', '肆', '陸']);
    for (const r of d.dailyRows) {
      expect(r.單位).toBe('式');
      expect(r.契約數量).toBe(1);
      expect(r.本日完成數量).toBe(0.1);
      expect(r.累計完成數量).toBe(0.4);
    }
  });

  // 30 天裡只有 8 天填了明細、6 天填了人數。沒填就是沒填,不可生出 0 或空字串的假列。
  test('沒填的天不生假資料', () => {
    expect(days.filter((d) => d.dailyRows.length).length).toBe(8);
    expect(days.filter((d) => d.header.出工總人數).length).toBe(6);
    for (const d of days) {
      for (const r of d.dailyRows) expect(r.工程項目).toBeTruthy();
      if (!d.header.出工總人數) expect(d.extras.出工明細).toBeUndefined();
    }
  });

  test('出工只加本日人數,沒填人數的工別不列', () => {
    const d = days.find((x) => x.header.填報日期 === '2025-04-14');
    expect(d.header.出工總人數).toBe(3);
    expect(d.extras.出工明細).toEqual([{ 工別: '一般工', 人數: 3 }]);
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
  expect(one.header.填報日期).toBe('2025-04-01');
}, 180000);

// 回空陣列會被上游當成「這份沒有資料」而靜靜略過,一定要吵。
test('別家格式的 PDF 要明確失敗', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/表單編號/);
}, 180000);

test('沒有文字層的 PDF 要 throw', () => {
  const fake = { filetypes: { extractItems: async () => [{ page: 1, items: [] }] } };
  return expect(mod.parseAll('x.pdf', fake)).rejects.toThrow(/文字層/);
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'jiayuan.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('嘉原營造有限公司');
});
