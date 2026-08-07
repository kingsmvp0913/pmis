/**
 * 尚仁營造(台西國中活動中心牆體整修)施工日誌讀取器測試。
 *
 * fixture 是 8 份 xlsm 裡最新的一份。這家的逐日資料在兩張並排的矩陣分頁
 * (`key in` = 本日、`累計` = 累計),`施工日誌`/`施工-第二聯` 只是用公式抓當天值的
 * 單日列印範本。2 份 PDF 是掃描件。
 */
const path = require('path');
const mod = require('../server/parsers/vendors/samples/shangren.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'shangren.xlsm');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest(filetypes)).toBe(true);
});

// vendorKey 的權威來源是**決標公告的得標廠商**,不是樣本檔、更不是命名慣例。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('尚仁營造有限公司');
});

describe('parseAll(台西活動中心)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 120000);

  test('一天一欄,160 天', () => {
    expect(days.length).toBe(160);
    expect(days[0].header.填報日期).toBe('2026-01-14');
    expect(days[days.length - 1].header.填報日期).toBe('2026-06-22');
  });

  // 工程名稱只能取 `施工日誌`:`施工-第二聯` 的抬頭寫著「114年度桃園市政府工務局
  // 轄管道路公共…」,那是拿別的案子的檔改的範本殘留。
  test('工程名稱取自 施工日誌,不是第二聯的範本殘留', () => {
    expect(days[0].header.工程名稱).toBe('台西國中活動中心牆體整修工程');
    expect(days[0].header.工程名稱).not.toMatch(/桃園/);
    expect(days[0].header.承包廠商).toBe('尚仁營造有限公司');
    expect(days[0].header.開工日期).toBe('2026-01-14');
  });

  // 兩張矩陣分頁長得一模一樣,錯開一欄/一列不會讓任何值變 null。
  // 這條驗的是「本日取自 key in、累計取自 累計」確實分開了。
  test('本日與累計分別取自兩張分頁', () => {
    const d1 = days[0];
    const d2 = days[1];
    const 圍籬1 = d1.dailyRows.find((r) => r.項次 === '2');
    const 圍籬2 = d2.dailyRows.find((r) => r.項次 === '2');
    expect(圍籬1).toMatchObject({ 單位: 'M', 契約數量: 210, 契約單價: 643, 本日完成數量: 100, 累計完成數量: 100 });
    expect(圍籬2).toMatchObject({ 本日完成數量: 110, 累計完成數量: 210 });
  });

  // 日期欄與項目列對不齊時一定要 throw,不可默默錯位。
  test('兩張分頁對不齊會 throw', () => {
    const wb = filetypes.readWorkbook(FIXTURE);
    const cum = wb.sheets['累計'].map((r) => (r ? r.slice() : r));
    cum[7][2] = '被改掉的項目名';
    expect(() => mod._internal.alignSheets(wb.sheets['key in'], cum)).toThrow(/對不齊/);
  });

  test('項次直接取自來源,含大類與費用項', () => {
    const nos = days[0].dailyRows.map((r) => r.項次);
    expect(nos[0]).toBe('壹');
    expect(nos[1]).toBe('1');
    expect(nos[nos.length - 1]).toBe('陸');
    expect(new Set(nos).size).toBe(nos.length);
    // 大類列的單位/數量/單價都空著,SP3 的 isCategoryRow 才認得出來
    expect(days[0].dailyRows[0]).toMatchObject({ 單位: null, 契約數量: null, 契約單價: null });
  });

  // `累計` r2 是「累計金額(未稅)」——這是真的當日累計金額,不是逐日累加推導出來的。
  test('本日累計金額取自來源的累計金額欄', () => {
    expect(days[0].header.本日累計金額).toBe(92497);
    expect(days[1].header.本日累計金額).toBe(603087);
    // 逐項的本日金額此格式不存在,不由單價 × 數量回推
    for (const r of days[0].dailyRows) expect(r.本日完成金額).toBeNull();
  });

  test('出工與機具在同一張矩陣的固定列序段', () => {
    const d = days[1];
    expect(d.extras.出工明細.map((c) => c.工別))
      .toEqual(['工地負責人', '品管人員', '職安人員', '大工', '小工']);
    expect(d.header.出工總人數).toBe(7);
    expect(d.extras.主要機具.map((c) => c.名稱)).toEqual(['挖土機', '水車', '貨車', '拖車']);
  });
});

test('讀不動的檔要明確失敗,不可回空陣列', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/key in/);
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const fs = require('fs');
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'shangren.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('尚仁營造有限公司');
});
