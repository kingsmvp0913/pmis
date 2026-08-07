/**
 * 義鼎營造有限公司(四湖國小活動中心)施工日誌讀取器測試。
 *
 * fixture 是 `1131111-1131130(新)…日誌.xlsx`(20 天,一天一分頁)。挑它是因為
 * 這一份同時帶著這家的兩個來源資料錯誤:下午天氣整份空白、`1131112` 分頁的
 * 填表日期被填成 11/13(與下一頁撞號)。兩者都要照收讓 SP3 報出來,不可自己「修好」。
 */
const fs = require('fs');
const path = require('path');
const mod = require('../server/parsers/vendors/samples/yiding.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'yiding.xlsx');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest(filetypes)).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商;名字對不上 vendors 表的話,
// 讀取器讀得動也永遠不會被叫到,而且不會有任何錯誤訊息。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('義鼎營造有限公司');
});

describe('parseAll(四湖 1111-1130)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 120000);

  test('一天一分頁,依填報日期排序', () => {
    expect(days.length).toBe(20);
    expect(days[0].header.填報日期).toBe('2024-11-11');
    expect(days[days.length - 1].header.填報日期).toBe('2024-11-30');
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('四湖國小活動中心場地整修工程');
    expect(h.承包廠商).toBe('義鼎營造有限公司');
    expect(h.開工日期).toBe('2024-11-11');               // 來源是 Excel 序號,不是字串
    expect(h.天氣_上午).toBe('晴');
    expect(h.預定進度).toBe(0.0009);                     // 分數保留原值
  });

  // 「下午：」那格的值是空的(整份 40 天都沒填)。往右一路找非空值會撈到同一列的
  // 「填表日期：」這個標籤字串當成天氣——空的就要是 null,讓 SP3 的 A2 報「未填」。
  test('下午天氣空白時回 null,不可撈到下一個標籤', () => {
    for (const d of days) {
      expect(d.header.天氣_下午).toBeNull();
      expect(d.header.天氣_上午).not.toBeNull();
    }
  });

  // 分頁 1131112 的填表日期被廠商填成 11/13(序號序列中間缺 45608)。分頁名不是
  // 文件內容,拿它去覆蓋填表日期就是猜;照收才會被 SP3 的 D1 抓出來。
  test('廠商填錯的重複日期照收,不可去重也不可拿分頁名覆蓋', () => {
    const dates = days.map((d) => d.header.填報日期);
    expect(dates.filter((x) => x === '2024-11-13')).toHaveLength(2);
    expect(dates).not.toContain('2024-11-12');
  });

  test('明細:大類、項次「壹N」、單位白名單', () => {
    const rows = days[0].dailyRows;
    expect(rows.length).toBe(11);                        // 大類 1 + 細項 10
    expect(rows[0]).toMatchObject({ 項次: '壹', 工程項目: '直接工程', 單位: null, 契約數量: null });
    expect(rows[1]).toMatchObject({
      項次: '壹1', 工程項目: '工程告示牌與職安告示牌(租用)', 單位: '式', 契約數量: 1,
    });
    // 沒填就是 null(不是 0):累計驗證裡兩者意義不同
    expect(rows[1].本日完成數量).toBeNull();
  });

  test('出工只加本日人數;材料表有資料要收進 extras', () => {
    const d = days[days.length - 1];
    expect(d.header.出工總人數).toBe(2);
    expect(d.extras.出工明細).toEqual([{ 工別: '普通工', 人數: 2 }]);
    expect(d.extras.主要材料).toEqual([
      { 名稱: '樹脂砂漿或PU修補整平', 單位: 'M2', 數量: 0 },
      { 名稱: '刷油性強化底漆固化劑', 單位: 'M2', 數量: 203 },
    ]);
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
  expect(one.header.填報日期).toBe('2024-11-11');
});

// 同案的 PDF 版餵給 SheetJS 會回空活頁簿。回空陣列會被上游當成「這份沒有資料」
// 而靜靜略過,一定要吵。
test('讀不動的檔要明確失敗,不可回空陣列', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/日分頁/);
});

// 工程會標準表單很多家在用,「表報編號：」錨點會碰巧命中別家的檔。
test('錨點對上但版面不同的檔要明確失敗', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'qiquan.xlsx'), ctx))
    .rejects.toThrow(/讀不到填表日期|日分頁/);
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'yiding.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('義鼎營造有限公司');
});
