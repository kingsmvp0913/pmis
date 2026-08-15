/**
 * 新成室內裝修企業社(古坑國中小棒球宿舍)施工日誌讀取器測試。
 *
 * fixture 是單一 xlsx,`施工日報` 分頁一天一個 73 列區塊、共 27 天。
 *
 * 斷言集中在三個「錯了不會有任何欄位變 null」的地方:
 *   ① 名稱要取 B 欄——C~G 是**別案殘留**的另一套名稱,取錯只是靜靜換掉一半的項目
 *   ② 契約數量要取欄 8——費用列的欄 9~10 是殘留的 10,主體列三欄同值所以看不出來
 *   ③ 預定進度是百分數、實際進度是分數,同一列兩種單位
 */
const path = require('path');
const mod = require('../server/parsers/vendors/samples/xincheng.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'xincheng.xlsx');
const ctx = { filetypes };

test('selfTest 以內建 grid 通過,不需注入', () => {
  expect(mod.selfTest()).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商,不是檔名或分頁抬頭推定
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('新成室內裝修企業社');
});

describe('parseAll(古坑國中棒球宿舍)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 180000);

  test('27 天,每天 17 項,日期遞增不重複', () => {
    expect(days.length).toBe(27);
    expect(days.every((d) => d.dailyRows.length === 17)).toBe(true);
    const d = days.map((x) => x.header.填報日期);
    expect(d[0]).toBe('2026-07-24');
    expect(d[d.length - 1]).toBe('2026-08-19');
    expect([...d].sort()).toEqual(d);
    expect(new Set(d).size).toBe(d.length);
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('114年棒球宿舍設備改善計畫工程');
    expect(h.承包廠商).toBe('新成室內裝修企業社');
    expect(h.開工日期).toBe('2026-07-24');
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    // 版面上沒有星期,不由日期回推(那是系統代填,不是來源資料)
    expect(h.星期).toBeNull();
  });

  // ① C~G 欄是別案殘留:項次 12 在 B 欄是「安裝360度吊扇」、C~G 是「小便斗拆除與更新」。
  // 以發包經費總表 17 項逐項核對過,B 欄才是本案的名稱。
  test('名稱取 B 欄,不是別案殘留的 C~G', () => {
    const r12 = days[0].dailyRows.find((r) => r.項次 === '12');
    expect(r12.工程項目).toBe('安裝360度吊扇');
    const 肆 = days[0].dailyRows.find((r) => r.項次 === '肆');
    expect(肆.工程項目).toBe('包商管理及利潤費（約壹*7%）');
  });

  // ② 費用列的欄 9~10 是殘留的 10,契約數量必須取欄 8
  test('費用項目的契約數量是 1,不是欄 9/10 的殘留值', () => {
    const 費用 = days[0].dailyRows.filter((r) => !/^\d+$/.test(r.項次));
    expect(費用.map((r) => r.項次)).toEqual(['貳', '參', '肆', '伍', '陸']);
    expect(費用.every((r) => r.契約數量 === 1)).toBe(true);
  });

  // ③ 首日「預定 1 / 實際 0.0128」= 1% 與 1.28%,兩欄單位不同。
  // 依整份最大值判斷各欄單位再統一——逐日判斷會讓開工前幾天判成不同單位。
  test('進度統一成百分數,兩欄各自判斷單位', () => {
    expect(days[0].header.預定進度).toBe(1);
    expect(days[0].header.實際進度).toBeCloseTo(1.28, 1);
    const 末 = days[days.length - 1].header;
    expect(末.預定進度).toBeGreaterThan(90);
    expect(末.實際進度).toBeGreaterThan(90);
    expect(末.實際進度).toBeLessThanOrEqual(100.01);
  });

  test('大類「壹 直接工程費」不算項目列', () => {
    const rows = days.flatMap((d) => d.dailyRows);
    expect(rows.some((r) => r.項次 === '壹')).toBe(false);
    expect(rows.some((r) => /直接工程費/.test(r.工程項目))).toBe(false);
  });

  test('單位與契約數量整份零缺漏', () => {
    const rows = days.flatMap((d) => d.dailyRows);
    expect(rows.length).toBe(459);
    for (const k of ['單位', '契約數量']) {
      expect(rows.filter((r) => r[k] == null).length).toBe(0);
    }
  });

  // 表格右邊的 R~V 五欄全是隱藏的計算區(S 累計數量 / T 單價 / U 金額=S*T),
  // 承辦人在畫面上看不到。它與發包經費總表 17 項裡有 14 項不同,但逐項複價的
  // 合計兩邊都是 1,193,638——同一筆總價的另一種分攤。
  // 承辦人 2026-08-15 裁決:不讀,契約單價一律以發包經費總表為準。
  // 讀進來的話這一案每天都會被 SP3 的 E6 擋下,而原因只是廠商自己看不到的計算欄。
  test('隱藏欄的單價與金額一律不讀', () => {
    const rows = days.flatMap((d) => d.dailyRows);
    expect(rows.every((r) => r.契約單價 === null)).toBe(true);
    expect(rows.every((r) => r.本日完成金額 === null)).toBe(true);
  });

});

// 「公共工程施工日誌」是工程會標準表單的共通錨點,至少 8 家都有。只回空陣列比讀不動
// 更糟:上游會把它當成「這份沒有資料」靜靜略過。
test('餵別家的日誌要 throw,不可回空陣列', async () => {
  const 別家 = path.join(__dirname, 'fixtures', 'yusen.xls');
  await expect(mod.parseAll(別家, ctx)).rejects.toThrow(/施工日報|新成/);
}, 180000);
