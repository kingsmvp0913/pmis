/**
 * 惠晟工程顧問(光明國中行政大樓外牆與屋頂防水)施工日誌讀取器測試。
 *
 * 這家的逐日資料在 `內容` 這張矩陣分頁、一天一欄;`公共工程施工日誌` 只是用公式
 * 抓「當前顯示日」的單日列印範本(而且只列出當天有施做的項目)。3 份 PDF 是列印輸出。
 */
const path = require('path');
const mod = require('../server/parsers/vendors/samples/huisheng.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'huisheng.xlsm');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest(filetypes)).toBe(true);
});

// vendorKey 的權威來源是**決標公告的得標廠商**。日誌上寫的是
// 「惠晟工程顧問 股份有限公司」——中間多一個空白,照抄就對不到 vendors 表。
test('vendorKey 是決標公告上的得標廠商名(日誌上那個多一個空白)', () => {
  expect(mod.meta.vendorKey).toBe('惠晟工程顧問股份有限公司');
});

describe('parseAll(光明國中)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 120000);

  // 日期欄一路預留到工期末(112 欄),只有前 N 天有資料,N = r0 欄10。
  // 這家沒有逐日天氣可以當「還沒填」的信號,截止欄是唯一可靠的。
  test('資料截止在 r0 欄10 指到的天', () => {
    expect(days.length).toBe(36);
    expect(days[0].header.填報日期).toBe('2026-02-23');
    expect(days[days.length - 1].header.填報日期).toBe('2026-03-30');
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('光明國中-行政大樓外牆與屋頂防水工程');
    expect(h.承包廠商).toBe('惠晟工程顧問股份有限公司');   // 去掉中間那個空白
    expect(h.開工日期).toBe('2026-02-23');
    expect(h.預定進度).toBeCloseTo(0.14, 5);
    expect(h.實際進度).toBe(10.35);
  });

  // 星期在來源是數字 1~7(1=日),不是「星期一」這種字串。
  test('星期由數字轉出來', () => {
    expect(days[0].header.星期).toBe('星期一');
    expect(days[1].header.星期).toBe('星期二');
  });

  // r8/r9 的欄 6 標著「上午天氣」「下午天氣」,但欄 11.. 放的是 0/1 的篩選旗標
  // (同一列欄 9 是「全部=>」、欄 10 是項目數 144)。拿旗標充數會讓每天的天氣
  // 都變成「1」——那是合法字串,完整性關卡看不見。
  test('天氣一律 null,不拿篩選旗標充數', () => {
    for (const d of days) {
      expect(d.header.天氣_上午).toBeNull();
      expect(d.header.天氣_下午).toBeNull();
    }
  });

  // 欄 2 的編號分段:1~499=施工項目、501~599=材料、601~699=工別、701~799=機具。
  // 不分段的話材料與工別會混進 dailyRows。
  test('只收施工項目段,材料/工別/機具不混進明細', () => {
    const rows = days[0].dailyRows;
    expect(rows.length).toBe(25);
    for (const r of rows) expect(Number(r.項次)).toBeLessThan(500);
    expect(rows[0]).toMatchObject({
      項次: '1', 工程項目: '工程告示牌(租用)', 單位: '面', 契約單價: 1899, 契約數量: 1, 本日完成數量: 1,
    });
    // 出工與機具進 extras
    expect(days[0].extras.出工明細.map((c) => c.工別)).toContain('鷹架工');
    expect(days[0].header.出工總人數).toBe(8);
  });

  // 欄 8 的「累計完成」是整案最終值(跨天不變),不是當天的累計;
  // 逐日累加本日完成量是推導不是來源值。逐項金額同理(只有單價)。
  test('沒有的欄位留 null,不由別處推導', () => {
    for (const r of days[0].dailyRows) {
      expect(r.累計完成數量).toBeNull();
      expect(r.本日完成金額).toBeNull();
    }
    expect(days[0].header.本日累計金額).toBeNull();
  });
});

test('讀不動的檔要明確失敗,不可回空陣列', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/內容/);
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const fs = require('fs');
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'huisheng.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('惠晟工程顧問股份有限公司');
});
