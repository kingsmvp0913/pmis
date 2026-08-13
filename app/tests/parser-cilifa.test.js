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
