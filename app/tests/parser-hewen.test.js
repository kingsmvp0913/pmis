/**
 * 和穩土木包工業(永定國小無障礙)施工日誌讀取器測試。
 *
 * fixture 是 `永定國小施工日誌.xlsx`(9/30 那份快照,21 天,最小的一份)。
 * 這家與承昇是同一套版面(`封面|日報|施工項目`),差別在明細最後多一列「計」小計、
 * 開工日期被打成「114年09年10日」——兩件事都寫成斷言,改壞了才會紅。
 */
const fs = require('fs');
const path = require('path');
const mod = require('../server/parsers/vendors/samples/hewen.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'hewen.xlsx');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest()).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商;名字對不上 vendors 表的話,
// 讀取器讀得動也永遠不會被叫到,而且不會有任何錯誤訊息。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('和穩土木包工業');
});

describe('parseAll(永定國小 0930 快照)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 120000);

  test('日報與施工項目兩個分頁的天區塊逐一對應', () => {
    expect(days.length).toBe(21);
    expect(days[0].header.填報日期).toBe('2025-09-10');
    expect(days[days.length - 1].header.填報日期).toBe('2025-09-30');
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('雲林縣永定國小114年度改善無障礙校園環境工程');
    expect(h.承包廠商).toBe('和穩土木包工業');
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');                        // 來源是「 下午： 晴」黏在同一格
    // 進度保留來源的分數(Excel 系讀取器的既有慣例,與承昇一致)
    expect(h.預定進度).toBe(0.002);
    expect(days[days.length - 1].header.預定進度).toBe(0.15);
  });

  // 來源把開工日期打成「114年09年10日」(第二個「年」是「月」的筆誤)。
  // 不容忍的話這一欄整份 null,而且不會有任何訊息。
  test('開工日期容忍「114年09年10日」這種筆誤', () => {
    expect(days[0].header.開工日期).toBe('2025-09-10');
  });

  // 明細取自「施工項目」(第二聯)而不是「日報」:日報那張只列當天施作的項目,
  // 也沒有契約單價與金額,而那兩欄正是 SP3 的 B3/B4/C2 要用的。
  test('明細取第二聯,八欄俱全', () => {
    const rows = days[0].dailyRows;
    expect(rows.length).toBe(17);                          // 大類 1 + 細項 11 + 費用項 5
    expect(rows[0]).toMatchObject({ 項次: '壹', 工程項目: '直接工程費', 單位: null, 契約單價: null });
    expect(rows[1]).toMatchObject({
      項次: '1', 工程項目: '工程告示牌與職安衛告示牌(租用)', 單位: '式',
      契約單價: 5000, 契約數量: 1, 本日完成數量: 1, 本日完成金額: 5000, 累計完成數量: 1,
    });
    expect(rows[rows.length - 1].項次).toBe('陸');          // 費用項是真項目,不可當大類丟掉
  });

  // 明細最後一列是「計」(欄 4=計、沒有項次、只有金額合計)。它三欄皆空,
  // 收下來會被 isCategoryRow 判成大類,完整性統計看不到,卻多一列假項目。
  test('最後的「計」小計列不可收成一列假項目', () => {
    for (const d of days) {
      expect(d.dailyRows.some((r) => r.工程項目 === '計')).toBe(false);
      expect(d.dailyRows.every((r) => r.項次)).toBe(true);
    }
  });

  test('本日完成金額 = 本日完成數量 × 契約單價', () => {
    const paid = days[0].dailyRows.filter((r) => r.本日完成金額);
    expect(paid.length).toBeGreaterThan(0);
    for (const r of paid) expect(r.本日完成金額).toBeCloseTo(r.本日完成數量 * r.契約單價, 2);
  });
});

test('parse 回第一天', async () => {
  const one = await mod.parse(FIXTURE, ctx);
  expect(one.header.填報日期).toBe('2025-09-10');
});

// 同案的 PDF 版餵給 SheetJS 會回一份空活頁簿。回空陣列會被上游當成
// 「這份沒有資料」而靜靜略過,一定要吵。
test('讀不動的檔要明確失敗,不可回空陣列', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/天區塊/);
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'hewen.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('和穩土木包工業');
});
