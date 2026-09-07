/**
 * 阿奎營造(新社高中弘揚樓廁所)施工日誌讀取器測試。
 *
 * 舊版新社高中 xls 一個檔一天；外埔國小另有可獨立讀取的橫向 xlsm 與雙頁 PDF。
 */
const path = require('path');
const mod = require('../server/parsers/vendors/samples/akui.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'akui.xls');
const WAIPU_XLSM = path.join(__dirname, 'fixtures', 'akui-waipu.xlsm');
const WAIPU_PDF = path.join(__dirname, 'fixtures', 'akui-waipu.pdf');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest(filetypes)).toBe(true);
});

// vendorKey 的權威來源是**決標公告的得標廠商**,不是樣本檔、更不是命名慣例。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('阿奎營造有限公司');
});

describe('parseAll(新社高中)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 120000);

  test('一個檔就是一天', () => {
    expect(days.length).toBe(1);
    expect(days[0].header.填報日期).toBe('2024-07-28');
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('113年度弘揚樓廁所整修工程');
    expect(h.承包廠商).toBe('阿奎營造有限公司');
    expect(h.開工日期).toBe('2024-07-01');
    expect(h.天氣_上午).toBe('晴天');
    expect(h.天氣_下午).toBe('雨天');
    expect(h.預定進度).toBe(9.42);
    expect(h.出工總人數).toBe(4);
    expect(h.星期).toBeNull();
  });

  // 明細區的結尾是一整排數字 0,不是空白列。用「名稱為空」當停止條件會多收
  // 一堆項目名稱叫「0」的列。
  test('明細止於那排 0,不會多收', () => {
    expect(days[0].dailyRows.length).toBe(36);
    for (const r of days[0].dailyRows) expect(r.工程項目).not.toMatch(/^\d+$/);
  });

  // 表頭的「預算數量」橫跨欄 3~4,但合併範圍逐列不同:多數列欄 4 是單位「式」
  // 跨進來的、費用項那幾列欄 4 卻是數量。只讀合併起點欄會在某些列讀到字串而變 null。
  test('契約數量往右掃到第一個數字', () => {
    const rows = days[0].dailyRows;
    expect(rows[1]).toMatchObject({ 單位: '式', 契約數量: 1 });
    const 職安 = rows.find((r) => r.項次 === '32');
    expect(職安).toMatchObject({
      工程項目: '職業安全衛生管理費(壹*0.6%)', 單位: '式', 契約數量: 1,
      本日完成數量: 0.01, 累計完成數量: 0.2800000000000001,
    });
  });

  // 第 1 列那天整列沒填(來源就空著),但它仍是一個項目、要佔項次——
  // 此格式**沒有大類列**(費用項就是一般明細),出現序不排除任何列。
  test('沒填的那一列仍佔項次', () => {
    const r = days[0].dailyRows[0];
    expect(r.項次).toBe('1');
    expect(r.工程項目).toMatch(/^工程告示牌/);
    expect(r.單位).toBeNull();
    expect(r.契約數量).toBeNull();
  });

  test('此格式沒有單價與金額,一律 null', () => {
    for (const r of days[0].dailyRows) {
      expect(r.契約單價).toBeNull();
      expect(r.本日完成金額).toBeNull();
    }
    expect(days[0].header.本日累計金額).toBeNull();
  });
});

describe('parseAll(外埔國小 Excel)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(WAIPU_XLSM, ctx); }, 120000);

  test('從數量表與出工表讀出所有已填日，不受日誌分頁目前選取日限制', () => {
    expect(days).toHaveLength(23);
    expect(days[0].header.填報日期).toBe('2026-08-12');
    expect(days.at(-1).header.填報日期).toBe('2026-09-03');
  });

  test('header 與 38 項明細逐欄', () => {
    expect(days[0].header).toMatchObject({
      工程名稱: '114-116年度D棟老舊廁所整修工程',
      星期: '三', 天氣_上午: '晴', 天氣_下午: '晴',
      預定進度: 0, 實際進度: 0.00651,
      出工總人數: 1, 承包廠商: '阿奎營造有限公司', 開工日期: '2026-08-12',
    });
    expect(days[0].dailyRows).toHaveLength(38);
    expect(days[0].dailyRows[0]).toMatchObject({
      項次: '1', 單位: '式', 契約數量: 1, 本日完成數量: 1, 累計完成數量: 1,
    });
    expect(days[0].dailyRows.slice(-6).map((r) => r.項次))
      .toEqual(['貳', '參', '肆', '伍', '陸', '柒']);
  });
});

describe('parseAll(外埔國小 PDF)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(WAIPU_PDF, ctx); }, 120000);

  test('每天兩頁只收一筆明細，共 20 天', () => {
    expect(days).toHaveLength(20);
    expect(days.map((d) => d.header.填報日期))
      .toEqual(Array.from({ length: 20 }, (_, i) => `2026-08-${String(i + 12).padStart(2, '0')}`));
  });

  test('項次欄與跨行名稱各自正確，不把項次黏進名稱', () => {
    expect(days[0].dailyRows).toHaveLength(38);
    expect(days[0].dailyRows[0]).toMatchObject({
      項次: '1', 工程項目: '乙種施工圍籬、警示帶、安全警示燈等安全措施(租用)',
      單位: '式', 契約數量: 1, 本日完成數量: 1, 累計完成數量: 1,
    });
    expect(days[0].dailyRows[3].工程項目).toMatch(/含合法證明.*環境保護與清潔/);
    expect(days[0].dailyRows.slice(-6).map((r) => r.項次))
      .toEqual(['貳', '參', '肆', '伍', '陸', '柒']);
  });

  test('第二頁人員資料會合併回同一天', () => {
    expect(days[0].header.出工總人數).toBe(1);
    expect(days[0].extras.出工明細.map((x) => x.工別)).toEqual(['技工', '普工', '水電工']);
  });

  test('PDF 百分數與 Excel 比例在 parser 輸出內統一', async () => {
    const excel = await mod.parseAll(WAIPU_XLSM, ctx);
    // PDF 只印到百分比小數 2 位(0.65%)，Excel 保留 0.00651；只容許來源顯示精度的差。
    expect(days[0].header.預定進度).toBeCloseTo(excel[0].header.預定進度, 4);
    expect(days[0].header.實際進度).toBeCloseTo(excel[0].header.實際進度, 4);
    expect(days[0].dailyRows.map((r) => [r.項次, r.契約數量, r.本日完成數量, r.累計完成數量]))
      .toEqual(excel[0].dailyRows.map((r) => [r.項次, r.契約數量, r.本日完成數量, r.累計完成數量]));
  });
});

// 13/14 份是無文字層的掃描 PDF,SheetJS 對它回一份空活頁簿。
test('讀不動的檔要明確失敗,不可回空陣列', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/找不到|阿奎/);
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const fs = require('fs');
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'akui.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('阿奎營造有限公司');
});
