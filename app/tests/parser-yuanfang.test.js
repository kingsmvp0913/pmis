/**
 * 元方營造有限公司(古坑國中小老舊廁所整修)施工日誌讀取器測試。
 *
 * fixture 是古坑國小案(52 頁 = 封面 1 頁 + 17 天 × 3 頁)。
 *
 * 斷言集中在三個「錯了不會有任何欄位變 null」的地方:
 *   ① 同一天的兩張第二聯要**接起來**,去重會靜靜丟掉一半的項目
 *   ② 名稱橫跨三帶,而**中間那一段就印在數值帶上** —— 只收中間會少掉前後
 *   ③ 兩個欄位的值黏在同一個 item(「1.00    162,321.」)
 */
const fs = require('fs');
const path = require('path');
const mod = require('../server/parsers/vendors/samples/yuanfang.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'yuanfang.pdf');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest()).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商(古坑國中小廁所決標公告 A1150508)
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('元方營造有限公司');
});

describe('parseAll(古坑國小)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 180000);

  // 52 頁 = 封面 1 + 17 天 × 3(第一聯 + 第二聯兩頁)
  test('17 天,依填報日期排序且不重複', () => {
    expect(days.length).toBe(17);
    expect(days[0].header.填報日期).toBe('2026-07-15');
    expect(days[16].header.填報日期).toBe('2026-07-31');
    const d = days.map((x) => x.header.填報日期);
    expect([...d].sort()).toEqual(d);
    expect(new Set(d).size).toBe(d.length);
  });

  test('header 逐欄(第一聯來的)', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('114年度老舊廁所整修工程-國小部B棟西側');
    expect(h.承包廠商).toBe('元方營造有限公司');
    expect(h.開工日期).toBe('2026-07-15');            // 來源是民國「115年7月15日」
    expect(h.星期).toBe('三');
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    // 進度是 PDF 印的百分數(0.33%),照收不換算
    expect(h.預定進度).toBe(0.33);
    expect(h.實際進度).toBe(1.63);
  });

  // ① 一天的明細分在兩張第二聯上。依日期「去重」會只留一張,而剩下的那一張
  // 自己完全自洽——少掉的一半沒有任何地方看得出來。
  test('同一天的兩張第二聯接起來,每天 35 項', () => {
    const 列數 = days.map((d) => d.dailyRows.length);
    expect(new Set(列數)).toEqual(new Set([35]));
    const nos = days[0].dailyRows.map((r) => r.項次);
    expect(nos.slice(0, 3)).toEqual(['1', '2', '3']);
    // 35 項全部切得出項次(數字或中文大寫的費用項)
    expect(nos.filter((n) => !/^([0-9]+|[壹貳參肆伍陸])$/.test(n))).toHaveLength(0);
  });

  // ② 項次 4 的名稱橫跨三帶,而**第二段就印在數值帶上**。
  // 只收數值帶自己那段的話,讀出來會是「設施、搗擺及天花板等拆除(含切割)及運棄」
  // ——前半段掉了,而且 splitNo 切不出項次。
  // ③ 同一列的「1.00    162,321.」是一個 item,整個丟給 num() 得 NaN,
  // 契約數量與契約單價會一起變 null。
  test('跨三帶的名稱要接完整,黏在一起的數量與單價要切開', () => {
    const r = days[0].dailyRows.find((x) => x.項次 === '4');
    expect(r.工程項目).toBe(
      '既有牆面、地坪、磁磚、衛生設備、給排水設施、搗擺及天花板等拆除(含切割)及運棄(含合法證明);環境保護與清潔'
    );
    expect(r.契約數量).toBe(1);
    expect(r.契約單價).toBe(162321);
    expect(r.本日完成數量).toBe(0.05);
    expect(r.本日完成金額).toBe(8116);
  });

  test('明細第一列逐欄', () => {
    const r = days[0].dailyRows[0];
    expect(r.項次).toBe('1');
    expect(r.工程項目).toBe('乙種施工圍籬、警示帶、安全警示燈等安全措施(租用)');
    expect(r.單位).toBe('式');
    expect(r.契約單價).toBe(2750);
    expect(r.本日完成金額).toBe(2750);
  });

  test('必要欄位零缺漏', () => {
    const rows = days.flatMap((d) => d.dailyRows);
    expect(rows).toHaveLength(595);
    expect(rows.filter((r) => r.單位 == null)).toHaveLength(0);
    expect(rows.filter((r) => r.契約數量 == null)).toHaveLength(0);
    expect(rows.filter((r) => r.契約單價 == null)).toHaveLength(0);
    expect(rows.filter((r) => r.項次 == null)).toHaveLength(0);
  });
});

test('不是元方的檔要 throw,不可回空陣列', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/元方/);
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'yuanfang.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('元方營造有限公司');
});
