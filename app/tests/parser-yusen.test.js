/**
 * 玉森(大有國小)第二聯讀取器測試。
 * 對 tests/fixtures/yusen.xls(2 分頁:進度 / 施工日誌(第二聯)-全 (修),91 天)跑。
 */
const path = require('path');
const mod = require('../server/parsers/vendors/samples/yusen.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'yusen.xls');
const ctx = { filetypes };

test('selfTest 以內建 grid 通過,不需注入', () => {
  expect(mod.selfTest()).toBe(true);
});

describe('yusen parse(第一天)', () => {
  let out;
  beforeAll(async () => { out = await mod.parse(FIXTURE, ctx); });

  test('工程名稱去掉「工程名稱：」標籤', () => {
    expect(out.header.工程名稱).not.toMatch(/^工程名稱/);
    expect(out.header.工程名稱).toMatch(/大有國民小學/);
  });

  // 日期在儲存格裡是 Excel 序號 46113,當字串 regex 會整份抓不到
  test('填報日期由序號轉出', () => {
    expect(out.header.填報日期).toBe('2026-04-01');
  });

  // 預定進度不在第二聯,要從「進度」分頁依日期對照補進來
  test('預定進度取自進度分頁', () => {
    expect(out.header.預定進度).toBe(0.38);
  });

  test.each([['天氣_上午'], ['天氣_下午'], ['星期'], ['實際進度'], ['出工總人數']])(
    '%s 此格式不提供,回 null', (k) => {
      expect(out.header[k]).toBeNull();
    });

  test('明細八欄俱全', () => {
    const r1 = out.dailyRows.find((r) => r.項次 === '1');
    expect(r1).toMatchObject({
      單位: '式', 契約單價: 5000, 契約數量: 1,
      本日完成數量: 0.2, 本日完成金額: 1000, 累計完成數量: 0.2,
    });
  });

  // 明細區後面接著「累計(本日完成金額)」與簽名欄,不停就會吃成假項目
  test('明細讀到非項次列即停,不吃到累計列與簽名欄', () => {
    const 非項次 = out.dailyRows.filter((r) => !/^(\d+|[壹貳參参肆伍陸柒捌玖拾])$/.test(r.項次));
    expect(非項次).toEqual([]);
  });

  // 沒施工的日子:金額 0 是真的 0,數量空白才是 null——兩者語意不同
  test('空白轉 null 而 0 保持 0', () => {
    const 有零金額 = out.dailyRows.filter((r) => r.本日完成金額 === 0);
    expect(有零金額.length).toBeGreaterThan(0);
    const 有空數量 = out.dailyRows.filter((r) => r.本日完成數量 === null);
    expect(有空數量.length).toBeGreaterThan(0);
  });

  test('每一列都解析得出單位與契約數量單價', () => {
    const 缺 = out.dailyRows
      .filter((r) => r.單位 == null || r.契約數量 == null || r.契約單價 == null)
      .map((r) => `${r.項次} ${r.工程項目}`);
    expect(缺).toEqual([]);
  });
});

describe('yusen parseAll', () => {
  let all;
  beforeAll(async () => { all = await mod.parseAll(FIXTURE, ctx); });

  test('91 天,日期遞增', () => {
    expect(all).toHaveLength(91);
    const dates = all.map((d) => d.header.填報日期);
    expect([...dates].sort()).toEqual(dates);
  });

  // 施工項目的累計會累加(項次4:0.1 → 0.2),費用項目的累計欄則各家語意不一,
  // 這裡只釘住施工項目——那是 SP3 B2/F1 判硬錯的依據
  test('施工項目的累計逐日累加', () => {
    const seq = all.slice(0, 5).map((d) => (d.dailyRows.find((r) => r.項次 === '4') || {}).累計完成數量);
    expect(seq[0]).toBe(0.1);
    expect(seq[1]).toBe(0.2);
  });
});
