/**
 * 承昇營造(明倫國小)讀取器測試。
 *
 * 對 tests/fixtures/chengsheng.xlsx(3 分頁:封面/日報/施工項目,49 天)跑,
 * 斷言來源的具體已知值。**含一條完整性斷言**——只抽驗特定項次的話,
 * 任何一列解析失敗都只會靜默變 null(金大就是這樣讓 2 列全錯的測試全綠)。
 */
const path = require('path');
const mod = require('../server/parsers/vendors/samples/chengsheng.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'chengsheng.xlsx');
const ctx = { filetypes };

describe('chengsheng meta / selfTest', () => {
  test('vendorKey 為廠商正式名稱(registry 依此歸位到同名廠商)', () => {
    expect(mod.meta.vendorKey).toBe('承昇營造有限公司');
  });

  // selfTest 不得依賴 ft 或 node_modules:讀取器裝到 data/vendor-parsers/ 時
  // 那裡沒有 node_modules,require 會被 try/catch 吃掉變成「未通過」
  test('selfTest 以內建小樣本通過,且不需注入', () => {
    expect(mod.selfTest()).toBe(true);
  });
});

describe('chengsheng parse(第一天)', () => {
  let out;
  beforeAll(async () => { out = await mod.parse(FIXTURE, ctx); });

  test('header 取自日報分頁', () => {
    expect(out.header.工程名稱).toBe('雲林縣明倫國民小學114-116年公立國民中小學老舊廁所整修工程計畫');
    expect(out.header.填報日期).toBe('2026-05-13');
    expect(out.header.天氣_上午).toBe('晴');
    expect(out.header.天氣_下午).toBe('晴');
    expect(out.header.承包廠商).toBe('承昇營造有限公司');
    expect(out.header.開工日期).toBe('2026-05-13');
  });

  // 填表日期在 Excel 裡是序號 46155,不是文字;當字串 regex 會整份抓不到日期
  test('填表日期由 Excel 序號轉出,非文字比對', () => {
    expect(out.header.填報日期).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // 「下午： 晴」把標籤與值黏在同一格,不拆的話天氣_下午會是整串標籤
  test('下午天氣要從「下午： 晴」拆出值', () => {
    expect(out.header.天氣_下午).not.toMatch(/下午/);
  });

  // 此格式沒有的欄位一律 null,不硬湊(skill 護欄)
  test.each([['星期'], ['出工總人數'], ['本日累計金額']])('%s 此格式不提供,回 null', (k) => {
    expect(out.header[k]).toBeNull();
  });

  test('明細取自「施工項目」第二聯,八欄俱全', () => {
    const r1 = out.dailyRows.find((r) => r.項次 === '1');
    expect(r1).toMatchObject({
      工程項目: '乙種施工圍籬、警示帶、安全警示燈等安全措施(租用)',
      單位: '式', 契約單價: 2200, 契約數量: 1,
      本日完成數量: 0, 本日完成金額: 0, 累計完成數量: 0,
    });
  });

  // 日報分頁的明細沒有契約單價與金額,取那邊的話這兩欄只能是 null——
  // 而它們正是 SP3 的 B3/B4/C2 驗證所需
  test('契約單價來自第二聯而非日報', () => {
    const 有單價 = out.dailyRows.filter((r) => r.契約單價 != null);
    expect(有單價.length).toBeGreaterThan(30);
  });

  test('第 2 項的單價與數量', () => {
    const r2 = out.dailyRows.find((r) => r.項次 === '2');
    expect(r2.契約單價).toBe(6000);
    expect(r2.本日完成金額).toBe(6000);
  });

  // 「壹 直接工程費」是大類標題,單位/數量/單價本來就空著
  test('大類列的數字欄為 null 而非 0', () => {
    const 壹 = out.dailyRows.find((r) => r.項次 === '壹');
    expect(壹.工程項目).toBe('直接工程費');
    expect(壹.單位).toBeNull();
    expect(壹.契約數量).toBeNull();
  });

  // 只抽驗特定項次擋不住「某一列靜默變 null」——金大 17 列裡有 2 列全錯而測試全綠
  test('每一個非大類列都解析得出單位與契約數量單價', () => {
    const 缺 = out.dailyRows
      .filter((r) => !(r.單位 == null && r.契約數量 == null && r.契約單價 == null))
      .filter((r) => r.單位 == null || r.契約數量 == null || r.契約單價 == null)
      .map((r) => `${r.項次} ${r.工程項目}`);
    expect(缺).toEqual([]);
  });
});

describe('chengsheng parseAll(逐日彙總)', () => {
  let all;
  beforeAll(async () => { all = await mod.parseAll(FIXTURE, ctx); });

  test('49 天,日期連續遞增', () => {
    expect(all).toHaveLength(49);
    expect(all[0].header.填報日期).toBe('2026-05-13');
    expect(all[all.length - 1].header.填報日期).toBe('2026-06-30');
    const dates = all.map((d) => d.header.填報日期);
    expect([...dates].sort()).toEqual(dates);
  });

  // 各天的項目數不一定相同,寫死列數會把別天的資料吃進來
  test('每一天都解析得出明細,且不會吃到別天的列', () => {
    for (const d of all) {
      expect(d.dailyRows.length).toBeGreaterThan(0);
      expect(d.dailyRows.length).toBeLessThan(48); // 天區塊間距
    }
  });

  test('累計完成數量隨日期單調不減(以項次 2 為例)', () => {
    const seq = all.map((d) => (d.dailyRows.find((r) => r.項次 === '2') || {}).累計完成數量)
      .filter((v) => v != null);
    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]);
  });
});
