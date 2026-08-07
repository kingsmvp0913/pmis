/**
 * 正郁室內裝修(成功國小思源堂 / 林內國中教室整修)施工日誌讀取器測試。
 *
 * **兩個 fixture 各一案**,因為這兩案在三件事上不一樣,任何一件搞錯都不會讓欄位變 null:
 *   ① 項次與名稱的分隔符(成功=空白、林內=頓號)
 *   ② 欄 11 的語意(成功=本日金額、林內=累計金額)
 *   ③ 成功案的月份分頁互相重疊(12 月分頁含 12/16~1/31)
 */
const path = require('path');
const mod = require('../server/parsers/vendors/samples/zhengyu.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const CHENGGONG = path.join(__dirname, 'fixtures', 'zhengyu-chenggong.xlsx');
const LINNEI = path.join(__dirname, 'fixtures', 'zhengyu-linnei.xlsx');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest(filetypes)).toBe(true);
});

// vendorKey 的權威來源是**決標公告的得標廠商**。這家名稱不帶「有限公司」,
// 照慣例補上就對不到 vendors 表(玉森踩過同型的坑,71 份日誌閒置一整輪)。
test('vendorKey 是決標公告上的得標廠商名(不帶「有限公司」)', () => {
  expect(mod.meta.vendorKey).toBe('正郁室內裝修');
});

describe('成功國小思源堂', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(CHENGGONG, ctx); }, 120000);

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('雲林縣成功國小思源堂整修工程');
    expect(h.承包廠商).toBe('正郁室內裝修');
    expect(h.填報日期).toBe('2024-12-16');
    expect(h.星期).toBe('星期一');           // 這家難得有星期,取自「(星期一)」
    expect(h.天氣_上午).toBe('晴天');
    expect(h.天氣_下午).toBe('晴天');
    expect(h.開工日期).toBe('2024-12-16');   // 字串「113年12月16日」不是序號
  });

  // 項次與名稱擠在同一格(「1 工程告示牌(租用)」),用空白分隔。
  // 切錯的話名稱會多一截編號,SP3 拿名稱對契約表就對不上——名稱錯了不會讓
  // 任何欄位變 null,完整性關卡看不見。
  test('項次與名稱以空白分隔', () => {
    expect(days[0].dailyRows[0]).toMatchObject({ 項次: '壹', 工程項目: '直接工程費', 單位: null });
    expect(days[0].dailyRows[1]).toMatchObject({ 項次: '1', 工程項目: '工程告示牌(租用)' });
    const nos = days[0].dailyRows.map((r) => r.項次);
    expect(nos[nos.length - 1]).toBe('陸');
    expect(new Set(nos).size).toBe(nos.length);
  });

  // 欄 11 在這一案 = 本日完成數量 × 單價(當天沒做就是 0)。
  test('欄 11 判定為本日完成金額', () => {
    expect(days[0].dailyRows[1]).toMatchObject({ 契約單價: 800, 本日完成數量: 1, 本日完成金額: 800 });
    expect(days[0].dailyRows[2]).toMatchObject({ 契約單價: 500, 本日完成數量: 1, 本日完成金額: 500 });
  });

  // 「12月 」分頁實測含 12/16~1/31,與「1月」分頁整整重複 31 天。
  // 不去重那 31 天會被算兩遍(D1 硬錯 31 個,逐日累加的金額全部翻倍)。
  test('月份分頁重疊的天只算一次,且輸出照時序', async () => {
    const full = await mod.parseAll(
      path.join(__dirname, 'fixtures', 'zhengyu-chenggong.xlsx'), ctx
    );
    const dates = full.map((d) => d.header.填報日期);
    expect(new Set(dates).size).toBe(dates.length);
    expect([...dates].sort()).toEqual(dates);
  });
});

describe('林內國中教室整修', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(LINNEI, ctx); }, 120000);

  test('header 與天數', () => {
    expect(days.length).toBe(6);
    expect(days[0].header.工程名稱).toBe('林內國中多功能教室裝修工程');
    expect(days[0].header.填報日期).toBe('2026-01-26');
    expect(days[days.length - 1].header.填報日期).toBe('2026-01-31');
  });

  // 這一案的分隔符是**頓號**不是空白。只認空白的話 5 個費用項每天都 A4。
  test('項次與名稱以頓號分隔', () => {
    const nos = days[0].dailyRows.map((r) => r.項次);
    expect(nos[0]).toBe('壹');
    expect(nos.slice(-5)).toEqual(['貳', '參', '肆', '伍', '陸']);
    const 貳 = days[0].dailyRows.find((r) => r.項次 === '貳');
    expect(貳.工程項目).toMatch(/^職業安全衛生管理費/);
  });

  // 這一案的欄 11 是**累計**完成數量 × 單價(跨天不變:項次 2 連三天都是
  // 25000 = 0.5 × 50000)。照「本日金額」收下去,SP3 的 B3 每天都不符。
  // schema 沒有「累計完成金額」欄,所以判定為累計時一律 null。
  test('欄 11 判定為累計金額 → 本日完成金額留 null', () => {
    const r = days[0].dailyRows.find((x) => x.項次 === '2');
    expect(r).toMatchObject({ 契約單價: 50000, 本日完成數量: 0.5, 累計完成數量: 0.5 });
    expect(r.本日完成金額).toBeNull();
    for (const d of days) for (const x of d.dailyRows) expect(x.本日完成金額).toBeNull();
  });

  // 「張」「盞」不在通用字典裡,不加進白名單的話那 3 列每天都 A6(單位未填)。
  test('這一案專有的單位也在白名單裡', () => {
    const units = new Set();
    for (const r of days[0].dailyRows) if (r.單位) units.add(r.單位);
    expect(units.has('張')).toBe(true);
    expect(units.has('盞')).toBe(true);
    for (const r of days[0].dailyRows.slice(1)) expect(r.單位).not.toBeNull();
  });
});

test('讀不動的檔要明確失敗,不可回空陣列', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/表報編號/);
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const fs = require('fs');
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'zhengyu.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('正郁室內裝修');
});
