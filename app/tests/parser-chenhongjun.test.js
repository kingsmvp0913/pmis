/**
 * 陳宏鈞土木包工業(僑美國小)讀取器測試。
 * 對 tests/fixtures/chenhongjun.pdf(38 頁 = 19 天 × 第一聯/第二聯)跑。
 */
const path = require('path');
const mod = require('../server/parsers/vendors/samples/chenhongjun.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'chenhongjun.pdf');
const ctx = { filetypes };

test('selfTest 以內建座標樣本通過,不需注入', () => {
  expect(mod.selfTest()).toBe(true);
});

describe('chenhongjun 明細列解析(純函式)', () => {
  const { parseItemRow } = mod._internal;
  const row = (items) => ({ y: 100, items: items.map(([x, s]) => ({ x, y: 100, s })) });

  // 有施工那天,三個值黏成一格
  test('末三欄黏在同一格時依數字形態切開', () => {
    const r = parseItemRow(row([[56, '1'], [69, 'A'], [212, '式'], [251, '9,500.0'],
      [313, '1.00'], [345, '1.00    9,500.00        1.000']]));
    expect(r).toMatchObject({ 本日完成數量: 1, 本日完成金額: 9500, 累計完成數量: 1 });
  });

  // 沒施工那天,同樣三欄散成 x≈397「-」與 x≈454「1.000」。
  // 只看數字序列會把「-」漏掉,於是累計被當成本日數量——數字都在,欄位卻錯了。
  test('末三欄分散時依 x 區間各自歸位', () => {
    const r = parseItemRow(row([[57, '1'], [69, 'A'], [212, '式'], [260, '9,500'],
      [327, '1'], [397, '-'], [454, '1.000']]));
    expect(r.本日完成數量).toBeNull();
    expect(r.本日完成金額).toBeNull();
    expect(r.累計完成數量).toBe(1);
  });

  // 單價的長數字會蓋掉契約數量欄,此時兩個值落在同一區間
  test('單價與契約數量黏在一起時取第二個數字當數量', () => {
    const r = parseItemRow(row([[56, '3'], [69, 'A'], [212, '式'], [238, '393,773.00 1.00'], [397, '-']]));
    expect(r.契約單價).toBe(393773);
    expect(r.契約數量).toBe(1);
  });

  // 大類列「壹」的單位欄印的是「-」;不轉 null 的話 isCategoryRow 判不出它是大類,
  // 每一天都會為它生出 A7 與 E1 兩個假硬錯
  test('「-」在文字欄也要轉 null', () => {
    const r = parseItemRow(row([[54, '壹'], [70, '直接工程費'], [210, '-'], [273, '-']]));
    expect(r.單位).toBeNull();
    expect(r.契約單價).toBeNull();
  });
});

describe('chenhongjun parseAll', () => {
  let all;
  beforeAll(async () => { all = await mod.parseAll(FIXTURE, ctx); });

  test('19 天,第一聯與第二聯依序配對', () => {
    expect(all).toHaveLength(19);
    expect(all[0].header.填報日期).toBe('2026-06-12');
  });

  test('header 取自第一聯', () => {
    expect(all[0].header).toMatchObject({
      工程名稱: '僑美國小114年老舊廁所整修工程',
      星期: '星期五', 天氣_上午: '晴', 天氣_下午: '晴',
      實際進度: 1.18, 契約金額: 3279802, 開工日期: '2026-06-12',
    });
  });

  // 名稱過長時原檔拆兩列,而續行印在**項次列的上一列**;不接回來的話,
  // 每一列都只剩殘缺的後半段,與契約表比對時整份判不一致(實測 E3 從 57 降到 1)
  test('跨行的項目名稱要接回完整', () => {
    const r1 = all[0].dailyRows.find((r) => r.項次 === '1');
    expect(r1.工程項目).toMatch(/^工程告示牌/);
    expect(r1.工程項目).toMatch(/安全措施\(租用\)$/);
  });

  // 項次 3 與 26 的契約數量在**原文件就是空白**(欄位被單價的長數字擠掉),
  // 不是讀取器讀不到——這兩個會如實變成 A7 硬錯,由承辦人向廠商補正。
  // 逐天檢查而非只看第一天:項次 26 只在其中 13 天缺,只驗一天會看不到它
  test('除原文件即空白的項次 3、26 外,其餘都解析得出契約數量單價', () => {
    const 缺 = new Set();
    for (const d of all) {
      for (const r of d.dailyRows) {
        if (r.單位 == null && r.契約數量 == null && r.契約單價 == null) continue; // 大類列
        if (r.契約數量 == null || r.契約單價 == null) 缺.add(r.項次);
      }
    }
    expect([...缺].sort()).toEqual(['26', '3']);
  });
});
