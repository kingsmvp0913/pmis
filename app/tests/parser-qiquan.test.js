/**
 * 齊全土木包工業(公誠國小育英樓排水改善)施工日誌讀取器測試。
 *
 * fixture 是 0226 那份快照(76 天):6 份 xlsx 是同一個工程的逐月快照,最新的 0318
 * 含全部 94 天,舊的是它的前綴。挑 0226 是因為它是**同時涵蓋出工人數與材料**
 * 的最小一份(更早的兩份那兩區都還是空的)。
 */
const path = require('path');
const mod = require('../server/parsers/vendors/samples/qiquan.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'qiquan.xlsx');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest()).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商;名字對不上 vendors 表的話,
// 讀取器讀得動也永遠不會被叫到,而且不會有任何錯誤訊息。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('齊全土木包工業');
});

describe('parseAll(公誠育英樓 0226 快照)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 120000);

  test('每個分頁一天,依填報日期排序', () => {
    expect(days.length).toBe(76);
    expect(days[0].header.填報日期).toBe('2024-12-15');
    expect(days[days.length - 1].header.填報日期).toBe('2025-02-28');
    const dates = days.map((d) => d.header.填報日期);
    expect([...dates].sort()).toEqual(dates);
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('113年育英樓排水改善工程');
    expect(h.承包廠商).toBe('齊全土木包工業');
    expect(h.開工日期).toBe('2024-12-15');
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    // r6 是**本日**進度、r7 才是累計。抓錯列不會有欄位變 null,只會變成另一個合法數字。
    expect(h.預定進度).toBeCloseTo(0.00301, 5);
    expect(h.實際進度).toBeCloseTo(0.01579, 5);
  });

  // 星期欄沒有標籤,緊接在日期序號右邊,值是數字 1~7(1=日)。
  test('星期由沒有標籤的那一欄的數字轉出來', () => {
    expect(days.slice(0, 4).map((d) => d.header.星期))
      .toEqual(['星期日', '星期一', '星期二', '星期三']);
  });

  // r33「累計合計金額」與各項累計金額逐筆相加一致,是真正的日層級累計
  // (多數廠商的同名欄其實是本日合計,收下去會讓 SP3 的 B4 每天硬錯)。
  test('本日累計金額取 r33 的累計合計金額,且逐日遞增', () => {
    expect(days[0].header.本日累計金額).toBe(14084);
    const cum = days.map((d) => d.header.本日累計金額);
    for (let i = 1; i < cum.length; i++) expect(cum[i]).toBeGreaterThanOrEqual(cum[i - 1]);
  });

  // 明細中間夾著「合計(壹)」與「發包工程費合計」兩列小計,它們沒有單位也沒有單價,
  // 收下來會被 isCategoryRow 當成大類。判準是項次欄為空。
  test('明細 20 列,兩列小計不混進來', () => {
    const rows = days[0].dailyRows;
    expect(rows.length).toBe(20);              // 大類 1 + 細項 14 + 費用項 5
    expect(rows[0]).toMatchObject({ 項次: '壹.', 工程項目: '直接工程', 單位: null, 契約單價: null });
    expect(rows.some((r) => String(r.工程項目 || '').includes('合計'))).toBe(false);
    expect(rows[rows.length - 1].項次).toBe('陸');
  });

  // 契約單價/本日完成金額在表格**右外側**(c65/c66),與左半的數量欄分屬兩塊。
  // 錯一欄就會拿到契約總額,而且不會有任何欄位變 null。
  test('右外側金額欄與明細同列(本日金額 = 本日數量 × 單價)', () => {
    const paid = days[0].dailyRows.filter((r) => r.本日完成金額 > 0);
    expect(paid.map((r) => r.項次)).toEqual(['1', '2', '伍']);
    expect(paid[1]).toMatchObject({
      工程項目: '施工圍籬(租用)', 單位: 'M', 契約單價: 400, 契約數量: 74, 本日完成數量: 15, 本日完成金額: 6000,
    });
    for (const r of paid) expect(r.本日完成金額).toBe(r.本日完成數量 * r.契約單價);
  });

  test('項目名稱完整,工程縮寫不被當成單位', () => {
    const d = days.find((x) => x.header.填報日期 === '2025-02-11');
    const r7 = d.dailyRows.find((r) => r.項次 === '7');
    expect(r7).toMatchObject({ 工程項目: '新設RC水溝', 單位: 'M', 契約單價: 3500 });
    expect(r7.本日完成金額).toBe(17360);        // 4.96 × 3500
  });

  test('沒施工的項目:本日數量 null(不是 0),累計數量仍在', () => {
    const r1 = days[days.length - 1].dailyRows.find((r) => r.項次 === '1');
    expect(r1.本日完成數量).toBeNull();
    expect(r1.累計完成數量).toBe(1);
  });

  // 出工與機具在同一張表頭列上並排,標籤分明(「工別」vs「機具名稱」),
  // 但合併填充後不會有「整列皆空」,靠段落標題當界。
  test('出工/機具/材料各自歸位', () => {
    const d = days.find((x) => x.header.填報日期 === '2025-02-11');
    expect(d.extras.出工明細).toEqual([{ 工別: '技術工', 人數: 6 }, { 工別: '小工', 人數: 2 }]);
    expect(d.header.出工總人數).toBe(8);
    expect(d.extras.主要機具).toEqual([{ 名稱: '挖土機', 數量: null }, { 名稱: '鏟土機', 數量: null }]);
    expect(d.extras.主要材料).toEqual([{ 名稱: 'D10鋼筋', 單位: 'KG', 數量: 462.99 }]);
  });
});

test('parse 回時序上的第一天', async () => {
  const one = await mod.parse(FIXTURE, ctx);
  expect(one.header.填報日期).toBe('2024-12-15');
});

// 回空陣列會被上游當成「這份沒有資料」而靜靜略過。
test('讀不動的檔要明確失敗,不可回空陣列', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow();
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const fs = require('fs');
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'qiquan.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('齊全土木包工業');
});
