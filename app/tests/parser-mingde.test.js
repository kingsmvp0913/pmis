/**
 * 明德土木包工業(嘉義縣立東榮國民中學)施工日誌讀取器測試。
 *
 * fixture 是同一案的兩聯,**分成兩個 PDF 檔**:
 *   `mingde-1.pdf` 第一聯(52 頁)有天氣與累計進度,明細沒有單價也沒有金額
 *   `mingde-2.pdf` 第二聯(26 頁)有完整明細含單價與金額,但沒有天氣也沒有進度
 * 承辦人 2026-08-13 選定的作法是「一次上傳兩個檔、系統依日期合併」,
 * 合併那一層在別處;這支只負責「單一檔案讀得到什麼就給什麼」。
 *
 * 斷言集中在兩個「錯了不會有任何欄位變 null」的地方:
 *   ① 值與表頭中心的偏移**兩聯方向相反**(第一聯偏左 24pt、第二聯偏右 14pt),
 *      用表頭起點當分界會有一聯整排錯位
 *   ② 第一聯的「承攬廠商名稱」標籤在別的帶,值卻與工程名稱同一帶
 */
const fs = require('fs');
const path = require('path');
const mod = require('../server/parsers/vendors/samples/mingde.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const F1 = path.join(__dirname, 'fixtures', 'mingde-1.pdf');
const F2 = path.join(__dirname, 'fixtures', 'mingde-2.pdf');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest()).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商(東榮國中廁所 DRJH-1140923)
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('明德土木包工業');
});

describe('第二聯(完整明細)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(F2, ctx); }, 180000);

  test('26 天,依填報日期排序且不重複', () => {
    expect(days.length).toBe(26);
    expect(days[0].header.填報日期).toBe('2026-07-06');
    expect(days[25].header.填報日期).toBe('2026-07-31');
    const d = days.map((x) => x.header.填報日期);
    expect([...d].sort()).toEqual(d);
    expect(new Set(d).size).toBe(d.length);
  });

  // ① 單價的值比表頭中心偏**右** 14pt(值 c374 vs 表頭 c360)。用表頭起點
  // 當分界會把它算進「單位」欄,金額欄整排跟著位移。
  test('明細逐欄(含單價與金額)', () => {
    const r = days[0].dailyRows[0];
    expect(r.項次).toBe('1');
    expect(r.工程項目).toContain('工程告示牌與職安衛告示牌');
    expect(r.單位).toBe('式');
    expect(r.契約單價).toBe(11000);
    expect(r.契約數量).toBe(1);
    expect(r.本日完成數量).toBe(1);
    expect(r.本日完成金額).toBe(11000);
    expect(r.累計完成數量).toBe(1);
  });

  test('必要欄位零缺漏', () => {
    const rows = days.flatMap((d) => d.dailyRows);
    expect(rows).toHaveLength(806);
    expect(rows.filter((r) => r.單位 == null)).toHaveLength(0);
    expect(rows.filter((r) => r.工程項目 == null)).toHaveLength(0);
    expect(rows.filter((r) => r.契約單價 == null)).toHaveLength(0);
    expect(rows.filter((r) => r.項次 == null)).toHaveLength(0);
  });

  // 廠商在 7/8、7/9 把費用項「貳」的本日完成金額整格留白(本日數量 0.006、
  // 累計 0.018 都有)。照讀不補,讓 SP3 的 A8 報出來——回推「數量 × 單價」
  // 會生出一個看起來完全正常的數字。
  test('廠商沒填的金額回 null,不由數量×單價回推', () => {
    const d = days.find((x) => x.header.填報日期 === '2026-07-08');
    const 貳 = d.dailyRows.find((r) => r.項次 === '貳');
    expect(貳.本日完成數量).toBe(0.006);
    expect(貳.本日完成金額).toBeNull();
  });

  test('第二聯沒有的欄位一律 null', () => {
    expect(days.filter((d) => d.header.天氣_上午 != null)).toHaveLength(0);
    expect(days.filter((d) => d.header.實際進度 != null)).toHaveLength(0);
  });
});

describe('第一聯(header)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(F1, ctx); }, 180000);

  test('26 天,天氣與累計進度都讀得到', () => {
    expect(days.length).toBe(26);
    const h = days[0].header;
    expect(h.填報日期).toBe('2026-07-06');
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    // 取的是「累計」那一組(SP3 的 F3/C4 驗累計語意),值是百分數不換算
    expect(h.預定進度).toBe(0.63);
    expect(h.實際進度).toBe(1.29);
    expect(h.開工日期).toBe('2026-07-06');            // 來源是西元斜線 2026/7/6
  });

  // ② 「承攬廠商名稱」的標籤在別的帶,值卻與工程名稱同一帶。整帶串起來會變成
  // 「…採購案明德土木包工業」——工程名稱多一截、承包廠商是 null,兩欄一起錯。
  test('工程名稱與承包廠商要切開', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('嘉義縣立東榮國民中學114-116年老舊廁所整修工程採購案');
    expect(h.承包廠商).toBe('明德土木包工業');
  });

  // 第一聯的名稱跨兩行、數值自己一行(在兩行的中間),要一上一下對稱收編。
  test('第一聯的明細讀得到,但沒有單價與金額', () => {
    const rows = days.flatMap((d) => d.dailyRows);
    expect(rows.length).toBeGreaterThan(700);
    expect(rows.filter((r) => r.單位 == null)).toHaveLength(0);
    expect(rows.filter((r) => r.契約單價 != null)).toHaveLength(0);
    expect(rows.filter((r) => r.本日完成金額 != null)).toHaveLength(0);
    expect(days[0].dailyRows[0].工程項目).toContain('工程告示牌與職安衛告示牌');
  });
});

test('不是明德的檔要 throw,不可回空陣列', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/明德/);
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'mingde.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('明德土木包工業');
});
