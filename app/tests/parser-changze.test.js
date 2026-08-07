/**
 * 長澤營造(光復國小 PU / 中和國小鋪面)施工日誌讀取器測試。
 *
 * 兩個 fixture 對應兩條解析路徑,都是同一套工程會標準表單、只是輸出檔型不同:
 *   - `changze.pdf` = 光復「11月日報表(修)1203.pdf」(4 天)。
 *     刻意挑這一份而不是最完整那份:它的數值欄表頭被切成「單」「位」
 *     「契約數量本日完成 累計完成 備註」三個 item,是欄界偵測最容易失手的形狀。
 *   - `changze.xls` = 中和「日報表1113(更).xls」(112 天)。xls 原稿多了 PDF
 *     根本沒印的契約單價與本日完成金額。
 */
const path = require('path');
const mod = require('../server/parsers/vendors/samples/changze.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const PDF = path.join(__dirname, 'fixtures', 'changze.pdf');
const XLS = path.join(__dirname, 'fixtures', 'changze.xls');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest(filetypes)).toBe(true);
});

// vendorKey 的權威來源是**決標公告的得標廠商**,不是樣本檔、更不是命名慣例。
// 玉森就是靠慣例推定而猜錯,讀取器完全讀得動卻永遠叫不出來(org-match 逐字相等),
// 71 份日誌閒置了一整輪且沒有任何錯誤訊息。這裡三邊一致:光復案與中和案的決標公告
// 得標廠商 = 兩案日誌的「承攬廠商名稱」欄 = 長澤營造有限公司。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('長澤營造有限公司');
});

describe('PDF 路徑(光復)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(PDF, ctx); }, 120000);

  test('一頁一天,4 天連續', () => {
    expect(days.map((d) => d.header.填報日期))
      .toEqual(['2024-11-27', '2024-11-28', '2024-11-29', '2024-11-30']);
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('雲林縣光復國小113年度操場及PU跑道整建工程');
    expect(h.星期).toBe('星期三');
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    expect(h.預定進度).toBe(0.1);
    expect(h.實際進度).toBe(1.2);
    expect(h.開工日期).toBe('2024-11-27');
    // 這份的標籤是「承攬廠商名」而不是別份的「承攬廠商名稱」,少一個字就讀不到。
    expect(h.承包廠商).toBe('長澤營造有限公司');
  });

  // 天氣列與填報日期列的 y 只差 0.4pt,分視覺行時會被併成同一行。
  // 下午天氣若用 `(\S+)` 貪婪抓,會連「填報日期113年11月28日星期四」一起吃進去——
  // 而吃進去的仍是合法字串,完整性關卡完全看不見。
  test('下午天氣不會把後面的填報日期一起吃進來', () => {
    for (const d of days) expect(d.header.天氣_下午).toMatch(/^.{1,3}$/);
  });

  test('明細:大類列不佔項次,其後依序編號', () => {
    const rows = days[0].dailyRows;
    expect(rows[0]).toMatchObject({ 項次: null, 工程項目: '一直接工程費', 單位: null });
    expect(rows[1]).toMatchObject({
      項次: '1',
      工程項目: '工程告示牌、職業安全告示牌與交通管制設施(租用)',
      單位: '式', 契約數量: 1, 本日完成數量: 1, 累計完成數量: 1,
    });
    expect(rows[2]).toMatchObject({ 項次: '2', 工程項目: '施工圍籬(租用)', 單位: 'M', 契約數量: 158 });
  });

  // 廠商當天沒填的欄**連「-」都不印**,整欄從版面上消失。靠 token 順序推欄的話
  // 會把累計完成的值當成本日完成——看起來像廠商漏填,其實是讀取器猜錯欄。
  test('沒印出來的欄是 null,不是把右邊的值往左移', () => {
    const r = days[1].dailyRows.find((x) => x.項次 === '1');
    expect(r.本日完成數量).toBeNull();
    expect(r.累計完成數量).toBe(1);
  });

  test('PDF 版面沒有單價與金額欄,一律 null 不由別處回推', () => {
    for (const r of days[0].dailyRows) {
      expect(r.契約單價).toBeNull();
      expect(r.本日完成金額).toBeNull();
    }
    expect(days[0].header.本日累計金額).toBeNull();
  });

  // 出工的「本日人數」與「累計人數」必須用 x 分辨:當天沒出工時廠商只印累計那一欄,
  // 靠順序會把累計人數當本日人數,出工總人數整份偏高。
  test('出工總人數只算本日人數欄', () => {
    const c = days[0].extras.出工明細;
    expect(c.map((x) => x.工別)).toEqual(['機械工', '板模工', '技術工', '普通工']);
    expect(days[0].header.出工總人數).toBe(4);
    expect(c.find((x) => x.工別 === '機械工').人數).toBeNull();
  });
});

describe('Excel 路徑(中和)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(XLS, ctx); }, 120000);

  // 錨點在同一份檔案裡有兩種寫法(第一天「表報編號」、其後「表報編號：」),
  // 逐字相等只會找到 1 個區塊、其餘 122 天靜靜消失。
  test('兩種錨點寫法都要認得', () => {
    expect(days.length).toBeGreaterThan(100);
    expect(days[0].header.填報日期).toBe('2025-10-14');
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('公立中小學校園環境安全改善計畫-02地坪-校園鋪面改善工程-中和國小');
    expect(h.承包廠商).toBe('長澤營造有限公司');
    expect(h.天氣_上午).toBe('晴');
    expect(h.預定進度).toBe(0.5);
    expect(h.開工日期).toBe('2025-10-14');
    expect(h.星期).toBeNull();          // 此格式不提供
  });

  // 大類列在來源是一個橫跨欄 0~13 的合併儲存格,gridFromWorksheet 把起點值填滿整區,
  // 單位欄因此也讀到「直接工程」。逐字收下的話它就不是大類,會佔掉項次 1
  // 並讓其後每一項都位移一格——而每個欄位都還是「有值」,完整性關卡看不見。
  test('合併填充的「直接工程」不可當成單位', () => {
    expect(days[0].dailyRows[0]).toMatchObject({ 項次: null, 工程項目: '直接工程', 單位: null });
    expect(days[0].dailyRows[1].項次).toBe('1');
  });

  // 欄 16 的標籤只寫「今日完成」,值必須用「單價 × 本日完成數量」交叉核對過才收下
  // (祥賀踩過:標籤寫「累計」但值是當日)。3128=3128×1、8800=44000×0.2。
  test('契約單價與本日完成金額(xls 才有),且金額 = 單價 × 本日數量', () => {
    const rows = days[0].dailyRows;
    expect(rows[1]).toMatchObject({
      工程項目: '工程告示牌與職安告示牌(租用)', 單位: '式',
      契約數量: 1, 契約單價: 3128, 本日完成數量: 1, 本日完成金額: 3128, 累計完成數量: 1,
    });
    expect(rows[2]).toMatchObject({
      工程項目: '施工管制措施(租用)', 契約單價: 44000, 本日完成數量: 0.2, 本日完成金額: 8800,
    });
  });

  // 廠商把整個工期的表格一次建好再逐日填,檔尾因此有一批「還沒填」的區塊:
  // 沒有日期、沒有天氣,累計完成卻有值(公式帶下來的)。收下來 SP3 會噴一整片 A1。
  // 但**只憑「沒有日期」就丟掉是危險的**——真的有日期卻讀不到時會靜默少一天,
  // 故要求整天沒有任何本日完成量才丟。
  test('還沒填的預備區塊不算一天', () => {
    const 有日期 = days.filter((d) => d.header.填報日期 != null);
    expect(有日期.length).toBe(101);
    // 剩下的無日期區塊都是有人填過東西的(檔尾公式炸掉的殘骸),保留讓 A1 報出來
    for (const d of days.filter((x) => x.header.填報日期 == null)) {
      expect(d.dailyRows.some((r) => r.本日完成數量)).toBe(true);
    }
  });

  test('項次與人工監造報表的契約詳細價目表逐項對齊', () => {
    // 答案卷「契約詳細價目表」是 壹.1…壹.17 + 貳~陸 共 22 項,
    // 日誌沒有印項次,以「排除大類後的出現序」補,實測兩邊逐項同序。
    const names = days[0].dailyRows.filter((r) => r.項次 != null).map((r) => r.工程項目);
    expect(names.length).toBe(22);
    expect(names[0]).toBe('工程告示牌與職安告示牌(租用)');
    expect(names[16]).toBe('廢棄物清運與環境清潔(含合法運棄證明)');   // 壹.17
    expect(names[17]).toBe('職業安全衛生管理費');                      // 貳
    expect(names[21]).toBe('營業稅');                                  // 陸
  });
});

// 「只在安裝時發作」的 bug(selfTest 內誤 require node_modules)只有走完整安裝路徑
// 才抓得到——晉林就是因為只直接呼叫 selfTest 而漏掉。
describe('registry 安裝路徑', () => {
  const fs = require('fs');
  const os = require('os');
  const registry = require('../server/parsers/registry');

  test('inspect(安裝前驗證,含在沙箱裡載入 + 跑 selfTest)通過', () => {
    const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'changze.pmisparser.js');
    const got = registry.inspect(fs.readFileSync(src));
    expect(got.error).toBeUndefined();
    expect(got.ok).toBe(true);
    expect(got.meta.vendorKey).toBe('長澤營造有限公司');
  });
});
