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

  // ⛔ 這條原本斷言「項次 3、26 的契約數量在原文件就是空白」——**那個診斷是錯的**。
  // 值一直印在表上(項次3 的 1.00 在 x=313、y 比項次低 5),是分帶把它丟掉了:
  // 帶的 y 錨在第一個進來的 item,長名稱換行時錨點被拉到名稱續行,契約數量就超出容差。
  // 錯在「缺的是欄位不是列」——列數、天數、名稱全對,只有一欄靜靜消失,
  // 而當時把它寫成來源缺陷,等於把讀取器的 bug 蓋章成廠商的錯。
  // 逐天檢查而非只看第一天:項次 26 當初只在 19 天裡的 13 天缺,只驗一天看不到。
  test('契約數量與單價整份零缺漏(長名稱換行的項次 3、26 也要有)', () => {
    const 缺 = new Set();
    for (const d of all) {
      for (const r of d.dailyRows) {
        if (r.單位 == null && r.契約數量 == null && r.契約單價 == null) continue; // 大類列
        if (r.契約數量 == null || r.契約單價 == null) 缺.add(r.項次);
      }
    }
    expect([...缺].sort()).toEqual([]);
    const r3 = all[0].dailyRows.find((r) => r.項次 === '3');
    expect(r3).toMatchObject({ 單位: '式', 契約數量: 1, 契約單價: 393773 });
  });
});
