/**
 * 賜利發土木包工業(元長國小老舊廁所整修)施工日誌讀取器測試。
 *
 * fixture 是 `7月公共工程施工日誌-元長國小廁所(修.xls`(同資料夾的 `(X).xls` 是
 * 作廢版,有一項的單價空著)。
 *
 * 斷言集中在三個「錯了不會有任何欄位變 null」的地方:
 *   ① 兩聯分在兩個分頁,各有一半欄位 —— 只讀一聯不是少天氣就是少單價與八成明細
 *   ② 單價在**次表頭**那一列(欄4),抓主表頭會拿到契約數量欄
 *   ③ 合計列要取累計那一欄(欄9),取本日欄(欄7)的話 SP3 的 B4 天天不符
 */
const fs = require('fs');
const path = require('path');
const mod = require('../server/parsers/vendors/samples/cilifa.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'cilifa.xls');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest(filetypes)).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商(元長廁所決標公告.pdf,A1150505)
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('賜利發土木包工業');
});

describe('parseAll(元長國小廁所)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 120000);

  test('21 天,依填報日期排序且不重複', () => {
    expect(days.length).toBe(21);
    expect(days[0].header.填報日期).toBe('2026-07-11');
    expect(days[20].header.填報日期).toBe('2026-07-31');
    const dates = days.map((d) => d.header.填報日期);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
  });

  // ① 天氣/進度/廠商/開工日期只有第一聯有,明細與單價只有第二聯有。
  // 兩邊靠填報日期配對(第一聯的區塊順序不保證與第二聯相同)。
  test('第一聯的欄位有配對進來', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('元長國小辦理「114-116年公立國民中小學老舊廁所整修工程計畫」');
    expect(h.承包廠商).toBe('賜利發土木包工業');
    expect(h.開工日期).toBe('2026-07-11');            // 來源是民國字串「115年7月11日」
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    // 取的是「累計」那一組進度,存的是分數(0.83%),保留原值不換算
    expect(h.預定進度).toBe(0.0083);
    expect(h.實際進度).toBeCloseTo(0.0088939, 6);
    expect(days.filter((d) => d.header.天氣_上午 == null)).toHaveLength(0);
  });

  test('每天 33 項完整明細,大類與小計列不會變成明細', () => {
    const 列數 = days.map((d) => d.dailyRows.length);
    expect(new Set(列數)).toEqual(new Set([33]));
    const names = days[0].dailyRows.map((r) => r.工程項目);
    expect(names).not.toContain('直接工程費');
    expect(names.some((n) => /^小計/.test(n))).toBe(false);
    const nos = days[0].dailyRows.map((r) => r.項次);
    expect(nos.slice(0, 3)).toEqual(['1', '2', '3']);
    expect(nos.slice(-5)).toEqual(['貳', '參', '肆', '伍', '陸']);
  });

  // ② 主表頭那一列的欄4 是空的,單價在次表頭(欄3=數量 欄4=單價)
  test('契約單價取自次表頭那一欄', () => {
    const r = days[0].dailyRows[0];
    expect(r.工程項目).toContain('乙種施工圍籬');
    expect(r.單位).toBe('式');
    expect(r.契約數量).toBe(1);
    expect(r.契約單價).toBe(8500);
    expect(r.本日完成數量).toBe(1);
    expect(r.本日完成金額).toBe(8500);
    expect(r.累計完成數量).toBe(1);
  });

  // 693 列裡 693 列同時滿足「欄7 = 欄6 × 單價」與「欄9 = 欄8 × 單價」
  test('本日完成金額 = 本日完成數量 × 單價', () => {
    const rows = days.flatMap((d) => d.dailyRows)
      .filter((r) => r.本日完成金額 != null && r.契約單價 != null);
    expect(rows.length).toBeGreaterThan(50);
    const 不符 = rows.filter((r) => Math.abs(r.本日完成金額 - (r.本日完成數量 || 0) * r.契約單價) >= 1);
    expect(不符).toHaveLength(0);
  });

  // ③ 合計列同時有本日合計(欄7)與累計合計(欄9)。取錯的話 SP3 的 B4 天天不符。
  // 7/31 的本日合計是 0(當天沒施工),累計仍是全額。
  test('本日累計金額取的是累計合計,逐日不減', () => {
    const seq = days.map((d) => d.header.本日累計金額);
    expect(seq[0]).toBe(9706);
    expect(seq.filter((v) => v == null)).toHaveLength(0);
    expect(seq.filter((v, i) => i > 0 && v < seq[i - 1])).toHaveLength(0);
  });

  test('必要欄位零缺漏', () => {
    const rows = days.flatMap((d) => d.dailyRows);
    expect(rows).toHaveLength(693);
    expect(rows.filter((r) => r.單位 == null)).toHaveLength(0);
    expect(rows.filter((r) => r.契約數量 == null)).toHaveLength(0);
    expect(rows.filter((r) => r.契約單價 == null)).toHaveLength(0);
    expect(rows.filter((r) => r.項次 == null)).toHaveLength(0);
  });
});

// 2026 年 9 月起廠商改交 PDF(60 頁 = 第一聯 30 頁 + 第二聯 30 頁),欄位與 xls 相同。
// pdf.js 會把相鄰儲存格黏成一個 item,以下斷言都對著「黏錯也不會有欄位變 null」的坑。
describe('parseAll(元長國小廁所 9 月 PDF)', () => {
  const PDF = path.join(__dirname, 'fixtures', 'cilifa.pdf');
  let days;
  beforeAll(async () => { days = await mod.parseAll(PDF, ctx); }, 120000);
  const day = (iso) => days.find((d) => d.header.填報日期 === iso);
  const item = (iso, no) => day(iso).dailyRows.find((r) => r.項次 === no);

  test('30 天,9/1~9/30 依序', () => {
    expect(days.map((d) => d.header.填報日期))
      .toEqual(Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`));
  });

  // 兩聯在同一個檔的前後半,靠填報日期配對
  test('第一聯的欄位有配對進來', () => {
    const h = day('2026-09-04').header;
    expect(h.工程名稱).toBe('元長國小辦理「114-116年公立國民中小學老舊廁所整修工程計畫」');
    expect(h.承包廠商).toBe('賜利發土木包工業');
    expect(h.開工日期).toBe('2026-07-11');
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('雨');
    // PDF 印「46.48%」;換成與 xls 版相同的分數,同一家兩種檔才不會差 100 倍
    expect(h.預定進度).toBeCloseTo(0.4648, 10);
    expect(h.實際進度).toBeCloseTo(0.3950, 10);
    expect(days.filter((d) => d.header.天氣_上午 == null)).toHaveLength(0);
  });

  test('每天 33 項,項次與 xls 版相同', () => {
    for (const d of days) {
      expect(d.dailyRows.map((r) => r.項次)).toEqual([
        ...Array.from({ length: 28 }, (_, i) => String(i + 1)), '貳', '參', '肆', '伍', '陸']);
    }
  });

  // 「1-」是契約數量 1 黏上本日數量的「-」,item 寬度被拉到 149pt。
  // 用 w/字數推位置會把「1」算進單價欄。
  test('契約數量與單價不被黏連的 item 搞混', () => {
    const r = item('2026-09-04', '1');
    expect(r.單位).toBe('式');
    expect(r.契約數量).toBe(1);
    expect(r.契約單價).toBe(8500);
    expect(r.累計完成數量).toBe(1);
  });

  // 「75   0.448」是本日金額與累計數量黏在同一個 item
  test('同一 item 裡的兩個欄位拆回各自的欄', () => {
    const r = item('2026-09-04', '貳');
    expect(r.契約單價).toBe(9406);
    expect(r.本日完成數量).toBe(0.008);
    expect(r.本日完成金額).toBe(75);
    expect(r.累計完成數量).toBe(0.448);
    const r24 = item('2026-09-04', '24');
    expect([r24.契約單價, r24.本日完成數量, r24.本日完成金額, r24.累計完成數量])
      .toEqual([115000, 0.05, 5750, 0.75]);
  });

  // 名稱跨三行、數值印在中間那行;只收自己那行名稱會頭尾都不見
  test('跨行名稱完整收回,與 xls 版逐字相同', () => {
    expect(item('2026-09-04', '3').工程項目).toBe('施工動線開闢與損壞復原,既有設備管線遷移與復原;測量與放樣');
    expect(item('2026-09-04', '4').工程項目).toBe('既有牆面、地坪、磁磚、衛生設備、給排水設施、搗擺及天花板等拆除(含切割)'
      + '及運棄(含合法證明);環境保護與清潔');
    expect(item('2026-09-04', '25').工程項目).toBe('施做緊急求救按鈕(含閃光與蜂嗚警報器、線材、五金配件, '
      + '各層樓每間廁所皆有求救鈕,連工帶料,責任施工)');
    expect(item('2026-09-04', '1').工程項目).toBe('乙種施工圍籬、警示帶、安全警示燈等安全措施(租用)');
  });

  test('本日累計金額取累計合計那一欄', () => {
    expect(day('2026-09-04').header.本日累計金額).toBe(431077);
  });

  test('本日完成金額 = 本日完成數量 × 單價', () => {
    const rows = days.flatMap((d) => d.dailyRows)
      .filter((r) => r.本日完成金額 != null && r.本日完成數量 != null && !/^[貳參肆伍陸]$/.test(r.項次));
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.filter((r) => Math.abs(r.本日完成金額 - r.本日完成數量 * r.契約單價) >= 1)).toHaveLength(0);
  });

  test('必要欄位零缺漏', () => {
    const rows = days.flatMap((d) => d.dailyRows);
    expect(rows.filter((r) => r.單位 == null || r.契約數量 == null || r.契約單價 == null)).toHaveLength(0);
  });
});

// 沒有「第二聯」分頁的檔要明確失敗。回空陣列會被上游當成「這份沒有資料」略過。
test('不是賜利發的活頁簿要 throw,不可回空陣列', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'kunyao.xlsx'), ctx))
    .rejects.toThrow(/第二聯/);
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'cilifa.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('賜利發土木包工業');
});
