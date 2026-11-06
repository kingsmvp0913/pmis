/**
 * 瑞騏建築經理有限公司(115 年度補助基層運動選手訓練站-改善訓練環境及器材設備)
 * 施工日誌讀取器測試。fixture = 10 月份 PDF,26 頁一頁一天(10/01~10/26)。
 *
 * 斷言集中在「錯了不會有任何欄位變 null」的地方:
 *   ① 跨行名稱的續行要接回**上一列**,不可併進下一列(名稱錯位,欄位全都有值)
 *   ② 第 17 頁整張表右移、換行位置也不同——寫死 x 的話那天整排落空或錯欄
 *   ③ 契約數量有靠右也有置中,兩種都要歸到「契約數量」而不是「本日數量」
 *   ④ 每天印完整 18 項,項次 = 出現序;跨天同一項次必須是同一個名稱
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PMIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-ruiqi-'));

const registry = require('../server/parsers/registry');
const mod = require('../server/parsers/vendors/samples/ruiqi.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'ruiqi.pdf');
const ctx = { filetypes };

afterAll(() => {
  fs.rmSync(process.env.PMIS_DATA_DIR, { recursive: true, force: true });
});

test('selfTest 通過', () => {
  expect(mod.selfTest()).toBe(true);
});

test('vendorKey 是日誌「承攬廠商名稱」上的正式名稱', () => {
  expect(mod.meta.vendorKey).toBe('瑞騏建築經理有限公司');
});

describe('真實施工日誌 fixture', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 180000);
  const day = (iso) => days.find((d) => d.header.填報日期 === iso);
  const row = (iso, no) => day(iso).dailyRows.find((r) => r.項次 === String(no));

  test('26 天,10/01~10/26 依序不重複,每天 18 項', () => {
    expect(days).toHaveLength(26);
    expect(days[0].header.填報日期).toBe('2026-10-01');
    expect(days[25].header.填報日期).toBe('2026-10-26');
    expect(new Set(days.map((d) => d.header.填報日期)).size).toBe(26);
    for (const d of days) expect(d.dailyRows).toHaveLength(18);
  });

  test('header:天氣不帶冒號殘字、進度百分數照收、開工日期西元', () => {
    const h = day('2026-10-01').header;
    expect(h.工程名稱).toBe('115年度補助基層運動選手訓練站-改善訓練環境及器材設備');
    expect(h.承包廠商).toBe('瑞騏建築經理有限公司');
    expect(h.星期).toBe('四');
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    expect(h.預定進度).toBe(5.96);
    expect(h.實際進度).toBe(6.46);
    expect(h.開工日期).toBe('2026-09-18');
    expect(day('2026-10-23').header.天氣_上午).toBe('雨');
  });

  test('項次 = 出現序,跨天同一項次永遠是同一個名稱', () => {
    const names = new Map();
    for (const d of days) {
      for (const r of d.dailyRows) {
        if (!names.has(r.項次)) names.set(r.項次, r.工程項目);
        expect(r.工程項目).toBe(names.get(r.項次));
      }
    }
    expect(names.get('1')).toBe('工程告示牌、職安告示牌與交通管制措施(租用)');
    expect(names.get('14')).toBe('職業安全維生管理費');   // 來源錯字照收
    expect(names.get('18')).toBe('營業稅');
  });

  test('跨行名稱接回上一列,下一列不被污染(第 1 頁與換行位置不同的第 17 頁)', () => {
    for (const iso of ['2026-10-01', '2026-10-17']) {
      expect(row(iso, 8).工程項目)
        .toBe('沙灘排球場圍網整建(安裝獨立基礎鍍鋅烤漆透空網,配合地形施做三種高網 H95cm/H110cm/H125cm)');
      expect(row(iso, 9).工程項目).toBe('沙灘排球場安裝單開門附鎖件共 3 樘');
    }
  });

  test('明細逐欄:契約數量(靠右/置中)、本日、累計', () => {
    expect(row('2026-10-01', 1)).toMatchObject({ 單位: '式', 契約數量: 1, 本日完成數量: null, 累計完成數量: 1 });
    expect(row('2026-10-01', 3)).toMatchObject({ 單位: '式', 契約數量: 1, 本日完成數量: null, 累計完成數量: null });
    expect(row('2026-10-08', 2)).toMatchObject({ 單位: 'M', 契約數量: 222, 本日完成數量: 122, 累計完成數量: 222 });
    expect(row('2026-10-08', 6)).toMatchObject({ 單位: '組', 契約數量: 2, 本日完成數量: 1.82, 累計完成數量: 2 });
    // 費用項累計印的是比例,照收
    expect(row('2026-10-01', 14)).toMatchObject({ 契約數量: 1, 累計完成數量: 0.0648 });
    expect(row('2026-10-03', 14)).toMatchObject({ 本日完成數量: 0.006, 累計完成數量: 0.0708 });
    // 第 17 頁表格右移:單位與累計仍歸對欄
    expect(row('2026-10-17', 4)).toMatchObject({ 單位: 'M2', 契約數量: 337, 本日完成數量: null, 累計完成數量: 50 });
  });

  test('前一日累計 + 本日 = 當日累計(施工項目逐日成立)', () => {
    for (let i = 1; i < days.length; i++) {
      for (const r of days[i].dailyRows) {
        if (Number(r.項次) > 13) continue;
        const prev = days[i - 1].dailyRows.find((x) => x.項次 === r.項次);
        const expected = (prev.累計完成數量 || 0) + (r.本日完成數量 || 0);
        expect(r.累計完成數量 || 0).toBeCloseTo(expected, 6);
      }
    }
  });

  test('沒有單價與金額:一律 null,不由別欄回推', () => {
    for (const d of days) {
      for (const r of d.dailyRows) {
        expect(r.契約單價).toBeNull();
        expect(r.本日完成金額).toBeNull();
      }
      expect(d.header.本日累計金額).toBeNull();
    }
  });

  test('工地人員只收本日人數(值靠左印,不可落到累計欄)', () => {
    expect(day('2026-10-03').extras.出工明細).toEqual([{ 工別: '大工', 人數: 1 }, { 工別: '小工', 人數: 1 }]);
    expect(day('2026-10-03').header.出工總人數).toBe(2);
    // 10/17 只填累計人數(13/12),本日空白
    expect(day('2026-10-17').extras.出工明細).toBeUndefined();
    expect(day('2026-10-17').header.出工總人數).toBeNull();
    expect(day('2026-10-19').extras.主要機具).toEqual([{ 名稱: '卡車', 數量: 1 }]);
    // 10/20 機具只有累計 1
    expect(day('2026-10-20').extras.主要機具).toBeUndefined();
  });
});

test('parse 回傳第一天', async () => {
  const d = await mod.parse(FIXTURE, ctx);
  expect(d.header.填報日期).toBe('2026-10-01');
});

test('不是瑞騏的檔要 throw,不可回空陣列', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/瑞騏/);
});

test('registry.install 完整安裝路徑通過', () => {
  const source = fs.readFileSync(path.join(
    __dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'ruiqi.pmisparser.js'
  ));
  const result = registry.install(source, '瑞騏建築經理有限公司');
  expect(result.ok).toBe(true);
  expect(result.status && result.status.installed).toBe(true);
});
