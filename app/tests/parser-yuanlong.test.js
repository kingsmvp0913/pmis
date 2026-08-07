/**
 * 沅隆營造有限公司施工日誌讀取器測試(兩案兩種載體)。
 *
 * fixture 兩份都要:`yuanlong.xls`(鹿場,一天一個「表報編號」區塊)與
 * `yuanlong.pdf`(麥寮,一天一頁)。PDF 那份的重點是「長名稱拆成 2~4 行、數值印在
 * 整塊名稱的垂直中央」——3/04 那天兩個項目連在一起,是最容易把名稱接錯的形狀。
 */
const fs = require('fs');
const path = require('path');
const mod = require('../server/parsers/vendors/samples/yuanlong.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const XLS = path.join(__dirname, 'fixtures', 'yuanlong.xls');
const PDF = path.join(__dirname, 'fixtures', 'yuanlong.pdf');
const ctx = { filetypes };

test('selfTest 通過(Excel 與 PDF 兩條路)', () => {
  expect(mod.selfTest(filetypes)).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商;名字對不上 vendors 表的話,
// 讀取器讀得動也永遠不會被叫到,而且不會有任何錯誤訊息。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('沅隆營造有限公司');
});

describe('Excel(鹿場)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(XLS, ctx); }, 120000);

  // 兩個分頁涵蓋同一段日期(未去重時 64 天裡有 31 天重複,SP3 會噴 D1 並把累計算兩遍)
  test('兩個分頁的重複日期要去重', () => {
    expect(days.length).toBe(33);
    const dates = days.map((d) => d.header.填報日期);
    expect(new Set(dates).size).toBe(dates.length);
    expect(dates[0]).toBe('2025-12-01');
    expect(dates[dates.length - 1]).toBe('2026-01-02');
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('114年度非山非市鹿場國小校門口意象暨磁磚剝落改善工程');
    expect(h.承包廠商).toBe('沅隆營造有限公司');
    expect(h.開工日期).toBe('2025-12-01');
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    expect(h.預定進度).toBe(0.07);
    expect(h.出工總人數).toBe(1);
  });

  test('明細:項次用名稱,單位白名單', () => {
    const r = days[0].dailyRows[0];
    expect(r.項次).toBe(r.工程項目);
    expect(r).toMatchObject({
      工程項目: '工程告示牌與職安告示牌(租用)', 單位: '式', 契約數量: 1,
      本日完成數量: 1, 累計完成數量: 1, 契約單價: null, 本日完成金額: null,
    });
  });
});

describe('PDF(麥寮)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(PDF, ctx); }, 180000);

  test('一天一頁', () => {
    expect(days.length).toBe(26);
    expect(days[0].header.填報日期).toBe('2026-03-02');
    expect(days[days.length - 1].header.填報日期).toBe('2026-03-27');
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('雲林縣麥寮國小公立中小學校園環境安全改善計畫防水隔熱活動中心頂樓鋼棚汰舊換新工程');
    expect(h.承包廠商).toBe('沅隆營造有限公司');
    expect(h.星期).toBe('星期一');
    expect(h.開工日期).toBe('2026-03-02');
    // 天氣與填報日期同一帶(y 差 0.5):整帶接起來再 regex 會把日期與星期當成下午天氣
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    expect(h.預定進度).toBe(1.64);
    expect(h.實際進度).toBe(11.43);
  });

  // 名稱拆成 2~4 行,數值印在整塊名稱的垂直中央。3/04 兩個項目相鄰:
  // 上面那個 4 行(值在中央)、下面那個 2 行,中間的「路」屬於上面那個。
  // 用「離最近的數值列」判斷會把它接到下面那個項目的開頭。
  test('跨行名稱要上下對稱地接回自己那一列', () => {
    const d = days.find((x) => x.header.填報日期 === '2026-03-04');
    expect(d.dailyRows.map((r) => r.工程項目)).toEqual([
      '施工動線開闢與損壞復原,既有設備、構造物、障礙物拆除、或遷移與復原,與施工介面相關之管線路查修與清除廢棄管線路',
      '吊車、吊裝與清運設備、施工安全索與防墜措施(租用)',
    ]);
    expect(d.dailyRows[0]).toMatchObject({ 單位: '式', 契約數量: 1, 本日完成數量: 0.3, 累計完成數量: 0.6 });
    expect(d.dailyRows[1]).toMatchObject({ 單位: '式', 契約數量: 1, 本日完成數量: 0.5, 累計完成數量: 0.5 });
  });

  test('項次用名稱(此格式沒有項次欄,逐日只列當天有印的項目)', () => {
    for (const d of days) for (const r of d.dailyRows) expect(r.項次).toBe(r.工程項目);
  });

  // 單位走白名單:3/10 那列的來源印的是「M4」(不是有效單位),留 null 讓 A6 報出來,
  // 不要為了讓它有值而放寬判定。
  test('不在字典裡的單位留 null', () => {
    const d = days.find((x) => x.header.填報日期 === '2026-03-10');
    const r = d.dailyRows.find((y) => y.工程項目.includes('0.7t以上'));
    expect(r.單位).toBeNull();
    expect(r.契約數量).toBe(1287);
  });
});

test('parse 回第一天', async () => {
  const one = await mod.parse(XLS, ctx);
  expect(one.header.填報日期).toBe('2025-12-01');
});

// 回空陣列會被上游當成「這份沒有資料」而靜靜略過,一定要吵。
test('別家格式的檔要明確失敗', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/表報編號/);
}, 180000);

test('錨點對上但版面不同的活頁簿要明確失敗', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'qiquan.xlsx'), ctx))
    .rejects.toThrow(/讀不到填報日期|表報編號/);
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'yuanlong.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('沅隆營造有限公司');
});
