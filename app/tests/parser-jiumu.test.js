/**
 * 久木營造(林內國中 PU 跑道整修)施工日誌讀取器測試。
 *
 * fixture 是 114.06 月檔:工程會版表單、**一天一個分頁**(分頁名 `月(日)`),
 * 分頁在檔案裡倒序排列。挑這個月是因為它同時涵蓋了本家最容易讀錯的幾件事——
 * 第二聯的金額合併格、跨月的累計、有值與沒值的機具欄、雨天。
 */
const path = require('path');
const mod = require('../server/parsers/vendors/samples/jiumu.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'jiumu.xls');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest()).toBe(true);
});

test('PDF 第二聯欄位依實際座標對應', () => {
  const mk = (y, items) => ({ y, items: items.map(([x, s]) => ({ x, y, s })) });
  const rows = [
    mk(779, [[46, '項次'], [134, '工 程 項 目'], [232, '單位']]),
    mk(747.8, [[72, '工程告示牌、職安衛告示牌與交通管制措施']]),
    mk(743.3, [[59, '1'], [239, '式'], [277, '1'], [303, '6,000'], [342, '6,000'],
      [384, '0.008'], [410, '0.267'], [457, '50'], [482, '1,600']]),
    mk(738, [[72, '(租用)']]),
    mk(371, [[72, '累計(本日完成金額合計)'], [442, '19,675']]),
  ];
  expect(mod._internal.parsePdfItemRows(rows)).toEqual([{
    項次: '1', 工程項目: '工程告示牌、職安衛告示牌與交通管制措施(租用)', 單位: '式',
    契約數量: 1, 契約單價: 6000, 本日完成數量: 0.008, 本日完成金額: 50,
    累計完成數量: 0.267,
  }]);
});

// vendorKey 的權威來源是決標公告的得標廠商;名字對不上 vendors 表的話,
// 讀取器讀得動也永遠不會被叫到,而且不會有任何錯誤訊息。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('久木營造有限公司');
});

describe('parseAll(林內國中 114.06)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 120000);

  // 分頁在檔案裡是倒序(6(30) 在最前),不重排的話整份輸出的時序是反的,
  // 而累計類驗證全都依賴時序。
  test('每個分頁一天,並依填報日期排成時序', () => {
    expect(days.length).toBe(31);
    expect(days[0].header.填報日期).toBe('2025-05-31');
    expect(days[days.length - 1].header.填報日期).toBe('2025-06-30');
    const dates = days.map((d) => d.header.填報日期);
    expect([...dates].sort()).toEqual(dates);
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('113年7月凱米颱風公共設施復建-林內國中PU跑道整修工程');
    expect(h.承包廠商).toBe('久木營造有限公司');
    expect(h.開工日期).toBe('2025-05-14');           // 來源是「114 年 05 月 14日」,夾著空白
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    // 累計進度取第一聯 r7。抓錯欄不會變 null,只會變成右外側殘留公式的值。
    expect(h.預定進度).toBeCloseTo(0.05721, 5);
    expect(h.實際進度).toBeCloseTo(0.12228, 5);
  });

  test('天氣逐日不同(不是把表頭或標籤當成值)', () => {
    const rain = days.find((d) => d.header.填報日期 === '2025-06-03');
    expect(rain.header.天氣_上午).toBe('雨');
    expect(rain.header.天氣_下午).toBe('雨');
  });

  // 第二聯欄17「本日完成金額」與欄18「累計完成金額」在資料列是同一個合併格。
  // 那個值經整份 4104 列統計確認是**本日**金額(符合「本日量×單價」2996 列、
  // 符合「累計量×單價」0 列)。照表頭把它當累計收下去,每天的金額都會多算。
  test('第二聯的金額合併格收的是本日金額(用單價×數量交叉核對)', () => {
    const d = days.find((x) => x.header.填報日期 === '2025-06-15');
    const r6 = d.dailyRows.find((r) => r.項次 === '6');
    expect(r6).toMatchObject({
      工程項目: '新設涵管銜接陰井', 單位: 'M', 契約單價: 3800, 契約數量: 30, 本日完成數量: 2,
    });
    expect(r6.本日完成金額).toBe(7600);
    expect(r6.本日完成金額).toBe(r6.本日完成數量 * r6.契約單價);
    expect(r6.累計完成數量).toBe(11);                 // 累計數量另有其欄,不等於本日
  });

  // r82 標著「累計(本日完成金額合計)」,值其實是當天的本日金額合計;
  // 收進 header.本日累計金額 會讓 SP3 的 B4(對各項**累計**金額總和)每天硬錯。
  test('本日累計金額一律 null(r82 是本日合計不是累計)', () => {
    for (const d of days) expect(d.header.本日累計金額).toBeNull();
  });

  test('明細取第二聯的完整 28 列,不是第一聯那份「當天有施作」摘要', () => {
    const d = days.find((x) => x.header.填報日期 === '2025-06-15');
    expect(d.dailyRows.length).toBe(28);              // 大類 1 + 細項 22 + 費用項 5
    expect(d.dailyRows[0]).toMatchObject({ 項次: '壹', 工程項目: '直接工程', 單位: null, 契約單價: null });
    expect(d.dailyRows[d.dailyRows.length - 1].項次).toBe('陸');
    // 合計列(「累計(本日完成金額合計)」)必須被切掉,否則會多出一列假項目
    expect(d.dailyRows.some((r) => String(r.工程項目 || '').startsWith('累計('))).toBe(false);
  });

  // 名稱裡的 RC/AC 這類工程縮寫被當成單位的話,名稱會被截斷而且不會有欄位變 null。
  test('項目名稱完整,工程縮寫不被當成單位', () => {
    const d = days.find((x) => x.header.填報日期 === '2025-06-15');
    const r14 = d.dailyRows.find((r) => r.項次 === '14');
    expect(r14.工程項目).toBe('刨除既有AC面層1~3cm');
    expect(r14.單位).toBe('M2');
    expect(d.dailyRows.find((r) => r.項次 === '8').工程項目)
      .toBe('新設RC水溝面(含排水孔)，面層鋪設PU顆粒面層');
  });

  // 沒填的本日數量是「無資料」不是 0——兩者在累計驗證裡意義不同。
  test('沒施工的天:本日數量 null,累計數量仍在', () => {
    const last = days[days.length - 1];                // 6/30 全天沒施工
    const r1 = last.dailyRows.find((r) => r.項次 === '1');
    expect(r1.本日完成數量).toBeNull();
    expect(r1.累計完成數量).toBe(0.5);
  });

  // 出工/機具三個區塊的表頭都寫「工別 / 本日人數」,但第二區塊放的是機具。
  // 照標籤收會讓挖土機變成人,出工總人數整份偏高。
  test('第二區塊是機具不是人;出工總人數只算人', () => {
    const d = days.find((x) => x.header.填報日期 === '2025-06-15');
    expect(d.extras.出工明細).toEqual([{ 工別: '組工', 人數: 1 }, { 工別: '技術工', 人數: 2 }]);
    expect(d.extras.主要機具).toEqual([{ 名稱: '挖土機', 數量: 1 }, { 名稱: '鏟土機', 數量: null }]);
    expect(d.header.出工總人數).toBe(3);
  });

  // 合併填充讓每一列的第 0 欄都有值,靠「整列皆空」當結束條件會把整個第一聯的
  // 敘述文字(段落標題、安衛檢查事項…)都收成材料。
  test('材料只收材料區兩列,不吃到後面的段落', () => {
    const d = days.find((x) => x.header.填報日期 === '2025-06-15');
    expect(d.extras.主要材料).toEqual([
      { 名稱: '鋪設新品密級配AC(平均H4cm以上)', 單位: 'm2', 數量: null },
      { 名稱: '鋪設13mm MDI 全密式PU跑道面層', 單位: 'm2', 數量: null },
    ]);
  });
});

test('parse 回時序上的第一天', async () => {
  const one = await mod.parse(FIXTURE, ctx);
  expect(one.header.填報日期).toBe('2025-05-31');
});

// 回空陣列會被上游當成「這份沒有資料」而靜靜略過。
test('讀不動的檔要明確失敗,不可回空陣列', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow();
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const fs = require('fs');
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'jiumu.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('久木營造有限公司');
});
