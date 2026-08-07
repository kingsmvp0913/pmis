/**
 * 利成營造有限公司(光明國中廁所整修)施工日誌讀取器測試。
 *
 * fixture 是 `施工日誌-光明國中1231.xlsx`(12/31 那份快照,96 天)。挑它是因為它是
 * **同時涵蓋「有資料的月分頁」與「空白複本分頁」**的最小一份:`12月 (2)` 是
 * 11/01~12/01 的空範本,與 `11月`／`12月` 整段重疊。空白複本蓋掉真資料是這家
 * 最容易靜默出錯的地方。
 */
const fs = require('fs');
const path = require('path');
const mod = require('../server/parsers/vendors/samples/licheng.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'licheng.xlsx');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest(filetypes)).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商;名字對不上 vendors 表的話,
// 讀取器讀得動也永遠不會被叫到,而且不會有任何錯誤訊息。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('利成營造有限公司');
});

describe('parseAll(光明國中 1231 快照)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 120000);

  test('跨分頁的日區塊合成一份,依填報日期排序', () => {
    expect(days.length).toBe(96);
    const dates = days.map((d) => d.header.填報日期);
    expect(dates[0]).toBe('2025-09-27');
    expect(dates[dates.length - 1]).toBe('2025-12-31');
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);      // 去重過,同一天不會出現兩次
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('光明國中B與C區5樓老舊廁所整修工程');
    expect(h.承包廠商).toBe('利成營造有限公司');
    expect(h.開工日期).toBe('2025-09-27');               // 來源是民國點號字串 114.9.27
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    // 進度保留來源的分數(0.01 = 1%);Excel 系讀取器的既有慣例,見讀取器的 pct()
    expect(h.預定進度).toBe(0.01);
    expect(h.實際進度).toBe(0.025);
    expect(h.出工總人數).toBe(8);                        // 2+6,累計人數欄不可混進來
    expect(days[0].extras.出工明細).toEqual([
      { 工別: '普通工', 人數: 2 }, { 工別: '體力工', 人數: 6 },
    ]);
  });

  // `12月 (2)` 是 11/01~12/01 的空範本,與 11月/12月 整段重疊。若照分頁順序後蓋前,
  // 這一天(以及整個 11 月)的施工紀錄會靜靜消失,而且不會有任何欄位變 null。
  test('空白的複本分頁不可蓋掉有明細的那一份', () => {
    const d = days.find((x) => x.header.填報日期 === '2025-11-01');
    expect(d.dailyRows).toHaveLength(1);
    expect(d.dailyRows[0]).toMatchObject({
      工程項目: '給排水系統配管與安裝', 單位: '式', 契約數量: 1,
      本日完成數量: 0.05, 累計完成數量: 0.65,
    });
    expect(days.filter((x) => x.dailyRows.length).length).toBe(56);
  });

  // 明細區的界是「二、」段落標題:表頭下方有 2~3 列空白,再來是
  // 「營造業專業工程特定施工項目 / A. / B.」三列標籤。用空白列當界會漏收,
  // 用固定列數則會在廠商把標籤列覆蓋成明細的那些天讀不到第三列。
  test('明細讀到「二、」為止,標籤列不混進來、被覆蓋的標籤列不漏收', () => {
    const d = days.find((x) => x.header.填報日期 === '2025-12-01');
    expect(d.dailyRows.map((r) => r.工程項目)).toEqual([
      '牆面貼石英磚30*60cm,白色水泥抹縫',                 // 全形逗號經 NFKC 折成半形
      '地坪、牆面1:3水泥砂漿粉刷',
      '地坪及牆面(H=1.2m)防水層粉刷',                     // 這一列坐在標籤列原本的位置
    ]);
    expect(d.dailyRows[2]).toMatchObject({ 單位: 'M2', 契約數量: 160, 本日完成數量: 60, 累計完成數量: 160 });
    const names = days.flatMap((x) => x.dailyRows.map((r) => r.工程項目));
    expect(names.some((n) => /^(A|B)\.$/.test(n) || n.includes('營造業專業工程特定施工項目'))).toBe(false);
  });

  // 此格式沒有項次欄,逐日又只列當天施作的項目,出現序在跨檔合併時會漂到別的項目上。
  // 名稱是這份文件唯一穩定的識別,故項次直接用名稱。
  test('項次用項目名稱(此格式沒有項次欄)', () => {
    for (const d of days) for (const r of d.dailyRows) expect(r.項次).toBe(r.工程項目);
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

test('parse 回時序上的第一天', async () => {
  const one = await mod.parse(FIXTURE, ctx);
  expect(one.header.填報日期).toBe('2025-09-27');
});

// 同案的「施工進度(光明-日誌用).xls」其實是預算書,檔名含「日誌」會被上游的檔名規則
// 收進來。回空陣列會被當成「這份沒有資料」而靜靜略過,一定要吵。
test('不是日誌的活頁簿要明確失敗,不可回空陣列', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow();
});

// 齊全那家的活頁簿也有「表報編號：」錨點(兩家都是工程會標準表單改的),光靠錨點
// 會假陽性:讀得出 94 天、卻每一天的日期與明細都是空的。這種「讀得動」比讀不動更危險。
test('錨點對上但版面不同的檔要明確失敗,不可回一堆空白天', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'qiquan.xlsx'), ctx))
    .rejects.toThrow(/讀不到填表日期/);
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'licheng.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('利成營造有限公司');
});
