/**
 * 振典實業(宜梧國中 / 溝壩國小 / 永慶沙灘排球)施工日誌讀取器測試。
 *
 * fixture 是三案裡最小的一份(永慶「日報表1141231(更).xlsx」,35 天);
 * 宜梧 945KB、溝壩 1.4MB 的完整檔不進 repo——關卡 b/c 用外部樣本跑。
 * 只在 fixture 裡看得到的形狀由 selfTest 以真實座標補齊(欄 6 殘值、
 * 名稱合併範圍不一致那兩條)。
 */
const path = require('path');
const mod = require('../server/parsers/vendors/samples/zhendian.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'zhendian.xlsx');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest(filetypes)).toBe(true);
});

// vendorKey 的權威來源是**決標公告的得標廠商**,不是樣本檔、更不是命名慣例
// (玉森靠慣例推定而猜錯,71 份日誌閒置了一整輪且沒有任何錯誤訊息)。
// 這裡要特別注意:永慶案的日誌「廠商名稱」欄**是空白的**,只有決標公告查得到。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('振典實業有限公司');
});

describe('parseAll(永慶沙灘排球)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 120000);

  // 廠商把整個工期的區塊一次建好再逐日填,交檔當下(12/31)工期還沒結束。
  // 不濾掉「還沒填」的區塊的話會多出一批只有公式日期的天,SP3 噴一整片 A2。
  // 天數止於檔名日期正是濾對了的佐證。
  test('只回傳已填寫的天,止於交檔日', () => {
    expect(days.length).toBe(35);
    expect(days[0].header.填報日期).toBe('2025-11-27');
    expect(days[days.length - 1].header.填報日期).toBe('2025-12-31');
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('114年度沙灘排球場地整建');
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    expect(h.開工日期).toBe('2025-11-27');
    expect(h.星期).toBeNull();          // 此格式不提供
    // 這一案的「廠商名稱」值格在來源就是空的,不是讀錯欄——不硬湊
    expect(h.承包廠商).toBeNull();
  });

  // 此格式同時有「本日」與「累計」兩組進度。SP3 的 F3(實際進度不得逐日變小)
  // 與 C4(0~100)驗的都是累計語意,取本日那組會讓 F3 每天誤報。
  test('進度取累計那一組(逐日不遞減)', () => {
    let prev = -1;
    for (const d of days) {
      expect(d.header.實際進度).toBeGreaterThanOrEqual(prev);
      prev = d.header.實際進度;
    }
    expect(days[days.length - 1].header.實際進度).toBeGreaterThan(0);
  });

  test('大類列不當明細;項次直接取自來源', () => {
    const rows = days[0].dailyRows;
    expect(rows[0]).toMatchObject({ 項次: '壹', 工程項目: '直接工程', 單位: null, 契約數量: null });
    expect(rows[1].項次).toBe('1');
  });

  // 欄 15 的表頭寫「總價」,值卻是當日金額。收下來之前用「單價 × 本日完成數量」
  // 交叉核對過(祥賀踩過反向的同一個坑:標籤寫「累計」但值是當日)。
  test('本日完成金額 = 契約單價 × 本日完成數量', () => {
    const d = days.find((x) => x.header.填報日期 === '2025-11-28');
    const r1 = d.dailyRows.find((r) => r.項次 === '1');
    expect(r1).toMatchObject({ 契約單價: 4000, 本日完成數量: 1, 本日完成金額: 4000 });
    const r2 = d.dailyRows.find((r) => r.項次 === '2');
    expect(r2).toMatchObject({ 契約單價: 14334, 本日完成數量: 1, 本日完成金額: 14334 });
    // 表尾的「累計合計金額」以標籤定位(位移隨明細項數而變,宜梧 17 項、溝壩 25 項)
    expect(d.header.本日累計金額).toBe(4000 + 14334);
  });

  // 此格式用全形方公尺 ㎡(U+33A1),不做 NFKC 的話 SP3 的單位字典每一列都軟警告。
  test('全形單位經 NFKC 才對得上單位字典', () => {
    const r = days[0].dailyRows.find((x) => x.項次 === '5');
    expect(r.單位).toBe('m2');
  });

  // 本日人數在欄 4、累計在欄 5。沒出工的工別只填了累計那一欄,
  // 取錯欄會讓出工總人數整份偏高。
  test('出工總人數只算本日人數欄', () => {
    const d = days.find((x) => x.header.填報日期 === '2025-11-28');
    expect(d.header.出工總人數).toBe(2);
    expect(d.extras.出工明細.find((c) => c.工別 === '水泥工').人數).toBeNull();
  });
});

// 此案的 PDF 是 50MB 的掃描件,沒有文字層;SheetJS 對它會回一份空活頁簿。
// 回空陣列會被上游當成「這份沒有資料」而靜靜略過——那是最糟的失敗方式。
test('讀不動的檔要明確失敗,不可回空陣列', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/表報編號/);
});

// 「只在安裝時發作」的 bug(selfTest 內誤 require node_modules)只有走完整安裝路徑
// 才抓得到——晉林就是因為只直接呼叫 selfTest 而漏掉。
test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const fs = require('fs');
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'zhendian.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('振典實業有限公司');
});
