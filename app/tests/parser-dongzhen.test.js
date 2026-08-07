/**
 * 東震營造工程有限公司(古坑國中小圍籬/車棚)施工日誌讀取器測試。
 *
 * 兩份 fixture 都要:`dongzhen.xls`(25 天,**有契約單價與本日完成金額**)與
 * `dongzhen.pdf`(30 天,那兩欄是隱藏欄所以沒有,但多了 4/14~4/18)。
 * 只測其中一份都會漏掉另一邊獨有的東西。
 */
const fs = require('fs');
const path = require('path');
const mod = require('../server/parsers/vendors/samples/dongzhen.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const XLS = path.join(__dirname, 'fixtures', 'dongzhen.xls');
const PDF = path.join(__dirname, 'fixtures', 'dongzhen.pdf');
const ctx = { filetypes };

test('selfTest 通過(Excel 與 PDF 兩條路)', () => {
  expect(mod.selfTest(filetypes)).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商;名字對不上 vendors 表的話,
// 讀取器讀得動也永遠不會被叫到,而且不會有任何錯誤訊息。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('東震營造工程有限公司');
});

describe('Excel(橫向 25 天)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(XLS, ctx); }, 120000);

  // 天的起點由表頭列裡值為「施工項目」的每一欄推出,不是寫死的 10 欄
  test('25 天,每天 25 列', () => {
    expect(days.length).toBe(25);
    expect(days[0].header.填報日期).toBe('2026-03-20');
    expect(days[days.length - 1].header.填報日期).toBe('2026-04-13');
    for (const d of days) expect(d.dailyRows).toHaveLength(25);
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('Danas-E-05-01-007雲林縣古坑國中小棒球場圍籬倒塌損壞及車棚毀損災後復建工程');
    expect(h.承包廠商).toBe('東震營造工程有限公司');
    expect(h.開工日期).toBe('2026-03-20');
    expect(h.天氣_上午).toBe('多雲');
    expect(h.天氣_下午).toBe('晴');
    expect(h.出工總人數).toBe(10);
  });

  // 兩個子工程合併發包(A=棒球場圍籬、B=車棚),項次是三層複合編號
  test('項次是 A.壹.1 / B.壹.11 這種複合編號,費用項是共用的貳~陸', () => {
    const nos = days[0].dailyRows.map((r) => r.項次);
    expect(nos[0]).toBe('A.壹.1');
    expect(nos).toContain('B.壹.11');
    expect(nos.slice(-5)).toEqual(['貳', '参', '肆', '伍', '陸']);
  });

  test('xls 版有契約單價與本日完成金額,且金額 = 數量 × 單價', () => {
    const d = days[0];
    const r = d.dailyRows.find((x) => x.項次 === 'B.壹.3');
    expect(r).toMatchObject({ 契約單價: 105661, 本日完成數量: 0.5, 本日完成金額: 52831 });
    for (const x of days) {
      for (const row of x.dailyRows) {
        if (row.本日完成金額 && row.契約單價 && row.本日完成數量) {
          // 廠商把金額四捨五入到整數(0.5 × 105661 = 52830.5 → 52831),容差取 1 元
          expect(Math.abs(row.本日完成金額 - row.本日完成數量 * row.契約單價)).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  // 機具的本日與累計是相鄰兩欄;少了「累計使用數量」那一界會把 1 與 1 併成 11
  test('機具數量取本日那一欄', () => {
    expect(days[0].extras.主要機具).toEqual([
      { 名稱: '吊車', 數量: 1 }, { 名稱: '高空車', 數量: 1 }, { 名稱: '貨車', 數量: 2 },
    ]);
  });
});

describe('PDF(一天一頁 30 天)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(PDF, ctx); }, 180000);

  // PDF 比 xls 多 4/14~4/18 五天:只做 xls 會少讀五天
  test('30 天,比 xls 多五天', () => {
    expect(days.length).toBe(30);
    expect(days[0].header.填報日期).toBe('2026-03-20');
    expect(days[days.length - 1].header.填報日期).toBe('2026-04-18');
  });

  test('header 逐欄(PDF 版有星期,進度印的是百分數)', () => {
    const h = days[0].header;
    expect(h.星期).toBe('星期五');
    expect(h.預定進度).toBe(2.85);
    expect(h.實際進度).toBe(3.71);
    expect(h.天氣_上午).toBe('多雲');
    expect(h.天氣_下午).toBe('晴');
  });

  // 「這兩欄印出前隱藏」——PDF 版沒有單價也沒有金額,不可從別處回推
  test('PDF 版沒有單價與金額,一律 null', () => {
    for (const d of days) for (const r of d.dailyRows) {
      expect(r.契約單價).toBeNull();
      expect(r.本日完成金額).toBeNull();
    }
  });

  // 表頭置中、值靠左:項次(x49)與名稱(x80)都在「施工項目」表頭(x165)左邊
  test('項次與名稱要分得開', () => {
    const r = days[0].dailyRows[1];
    expect(r).toMatchObject({ 項次: 'A.壹.2', 工程項目: '施工圍籬(租用)', 單位: 'M', 契約數量: 58 });
  });

  // 兩種載體讀出來的同一天必須一致(除了 PDF 沒有的那兩欄)
  test('與 xls 同一天的數量欄一致', async () => {
    const xls = await mod.parseAll(XLS, ctx);
    const a = xls.find((d) => d.header.填報日期 === '2026-03-20');
    const b = days.find((d) => d.header.填報日期 === '2026-03-20');
    expect(b.dailyRows.map((r) => [r.項次, r.單位, r.契約數量, r.累計完成數量]))
      .toEqual(a.dailyRows.map((r) => [r.項次, r.單位, r.契約數量, r.累計完成數量]));
    expect(b.extras).toEqual(a.extras);
  }, 180000);
});

test('parse 回第一天', async () => {
  const one = await mod.parse(XLS, ctx);
  expect(one.header.填報日期).toBe('2026-03-20');
});

// 回空陣列會被上游當成「這份沒有資料」而靜靜略過,一定要吵。
test('別家格式的檔要明確失敗', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/表報編號/);
}, 180000);

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'dongzhen.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('東震營造工程有限公司');
});
