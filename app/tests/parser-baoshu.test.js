/**
 * 寶樹體育設備工程(豐榮國小人工草皮)施工日誌讀取器測試。
 *
 * fixture 是最新也最完整的那份 xls(115 天)。這案的 9 份 PDF 是同一份資料按月
 * 拆開的列印版(有文字層,但版面逐字散開),xls 已涵蓋 115/120 天,故未實作 PDF 路徑
 * ——見讀取器檔頭的說明。
 */
const path = require('path');
const mod = require('../server/parsers/vendors/samples/baoshu.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'baoshu.xls');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest(filetypes)).toBe(true);
});

// vendorKey 的權威來源是**決標公告的得標廠商**,不是樣本檔、更不是命名慣例。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('寶樹體育設備工程有限公司');
});

describe('parseAll(豐榮國小)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 120000);

  // 分頁名帶日期區間(`1140401~1140729施工日誌`),每份檔都不一樣,
  // 所以掃所有分頁找錨點而不是挑名字。
  test('115 天,止於交檔日', () => {
    expect(days.length).toBe(115);
    expect(days[0].header.填報日期).toBe('2025-04-01');
    expect(days[days.length - 1].header.填報日期).toBe('2025-07-24');
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toContain('豐榮國小修整建');
    expect(h.承包廠商).toBe('寶樹體育設備工程有限公司');
    // 開工日期在來源是字串「114 年 04 月 01 日」不是 Excel 序號
    expect(h.開工日期).toBe('2025-04-01');
    // 天氣的標籤與值黏在同一格(「上午：晴 下午：晴」)
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    expect(h.預定進度).toBe(0.037);
    expect(h.星期).toBeNull();
  });

  test('明細 19 項,止於「二、工地材料管理概況」', () => {
    const rows = days[0].dailyRows;
    expect(rows.length).toBe(19);
    expect(rows.map((r) => r.項次)).toEqual(
      Array.from({ length: 19 }, (_, i) => String(i + 1))
    );
    expect(rows[rows.length - 1].工程項目).toBe('營業稅（(壹~肆)*5％）');
  });

  // 此格式用全形方公尺 ㎡(U+33A1),不做 NFKC 的話 SP3 的單位字典每一列都軟警告。
  test('全形單位經 NFKC 才對得上單位字典', () => {
    const units = new Set();
    for (const d of days) for (const r of d.dailyRows) if (r.單位) units.add(r.單位);
    expect([...units].sort()).toEqual(['M', 'm2', '座', '式']);
  });

  // 表格右外側有一區「項目名 | 契約數量 | 契約總價 | 完成總價 | 累計總價」,
  // 看起來剛好補上此格式缺的金額,但它**與左邊的明細錯開一列**——
  // 照列對應會把每一項的金額貼到別的項目上,而每一格都還是有值,關卡看不見。
  // 而且欄 62 是契約複價不是單價,反推單價會讓 E6/E7 變成自我循環。
  test('右外側計算區不可當單價/金額,一律 null', () => {
    for (const d of days) {
      for (const r of d.dailyRows) {
        expect(r.契約單價).toBeNull();
        expect(r.本日完成金額).toBeNull();
      }
      expect(d.header.本日累計金額).toBeNull();
    }
  });

  test('本日與累計完成數量', () => {
    const d = days.find((x) => x.header.填報日期 === '2025-04-07');
    expect(d.dailyRows[0]).toMatchObject({ 本日完成數量: 0.8, 累計完成數量: 0.8 });
    expect(d.dailyRows[1]).toMatchObject({ 本日完成數量: 0.3, 累計完成數量: 0.3 });
    // 本日人數在欄 10、累計在欄 20;取錯欄會讓出工總人數整份偏高
    expect(d.header.出工總人數).toBe(2);
  });
});

// 9 份 PDF 未實作(見檔頭)。回空陣列會被上游當成「這份沒有資料」而靜靜略過。
test('讀不動的檔要明確失敗,不可回空陣列', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/表報編號/);
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const fs = require('fs');
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'baoshu.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('寶樹體育設備工程有限公司');
});
