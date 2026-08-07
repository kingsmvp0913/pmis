/**
 * 聖隆營造(成功國小 PU / 後埔國小環境工程)施工日誌讀取器測試。
 *
 * fixture 是兩案裡最小的一份(後埔「正式版1140523.xlsm」,36 天),
 * 而且它正好是**三張 No 表**的那一案——項次撞號與大類前綴這兩件事只有它驗得到。
 */
const path = require('path');
const mod = require('../server/parsers/vendors/samples/shenglong.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'shenglong.xlsm');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest(filetypes)).toBe(true);
});

// vendorKey 的權威來源是**決標公告的得標廠商**,不是樣本檔、更不是命名慣例
// (玉森靠慣例推定而猜錯,71 份日誌閒置了一整輪且沒有任何錯誤訊息)。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('聖隆營造有限公司');
});

describe('parseAll(後埔國小)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 120000);

  // 整個工期的列是一次建好的,交檔當下(5/23)工期還沒結束;不濾掉「還沒填」的列
  // 會多出一批只有日期的天。天數止於交檔後不久正是濾對了的佐證。
  test('只回傳已填寫的天', () => {
    expect(days.length).toBe(36);
    expect(days[0].header.填報日期).toBe('2025-05-26');
    expect(days[days.length - 1].header.填報日期).toBe('2025-06-30');
  });

  // 一天的內容散在四張矩陣分頁上,靠日期序號互相對應。
  test('header 由四張分頁拼起來', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('後埔國小113年度充實設施設備-改善校園環境工程');   // 基本資料
    expect(h.承包廠商).toBe('聖隆營造有限公司');                                 // 基本資料
    expect(h.開工日期).toBe('2025-05-26');                                       // 基本資料
    expect(h.天氣_上午).toBe('晴');                                              // 記事
    expect(h.天氣_下午).toBe('晴');                                              // 記事
    expect(h.出工總人數).toBe(7);                                                // 工料
    expect(h.星期).toBeNull();
  });

  // 記事同時有本日(欄7)與累計(欄8)進度;SP3 的 F3(不得逐日變小)與 C4 驗的是累計語意。
  test('進度取累計那一組(逐日不遞減)', () => {
    let prev = -1;
    for (const d of days) {
      expect(d.header.實際進度).toBeGreaterThanOrEqual(prev);
      prev = d.header.實際進度;
    }
  });

  // 後埔把項目拆成 No1/No2/No3 三張表,**各自從 1 編號**。不加大類前綴會撞號,
  // No1 的「3」與 No2 的「3」是不同項目,SP3 會拿它們互相比對。
  // 序列與「基本資料」分頁的階層(壹 > 一 > 1..4;二 > 1..8;三 > 1..5;貳~陸)逐項對齊。
  test('項次以大類前綴唯一化,且與基本資料的階層對齊', () => {
    const nos = days[0].dailyRows.map((r) => r.項次);
    expect(nos).toEqual([
      '一', '一.1', '一.2', '一.3', '一.4',
      '二.1', '二.2', '二.3', '二.4', '二.5', '二.6', '二.7', '二.8',
      '三.1', '三.2', '三.3', '三.4', '三.5',
      '貳', '參', '肆', '伍', '陸',
    ]);
    expect(new Set(nos).size).toBe(nos.length);
  });

  // 大類的判定是**單位欄為空**,不能用「項次非數字」——費用項(貳~陸)的項次
  // 也是中文數字,但它們有單位有單價,是真項目。
  test('大類列以單位空判定,費用項不是大類', () => {
    const rows = days[0].dailyRows;
    expect(rows[0]).toMatchObject({ 項次: '一', 工程項目: '假設工程', 單位: null, 契約單價: null });
    const 貳 = rows.find((r) => r.項次 === '貳');
    expect(貳.單位).toBe('式');
    expect(貳.契約單價).toBeGreaterThan(0);
  });

  // No 表的欄位分成兩段一模一樣的項次序列(當日 | 累計),中間夾一欄「累計」。
  // 兩段的項次/名稱/單價完全相同,錯位不會讓任何欄位變 null——晉林踩過同一個坑。
  test('當日與累計兩個平行區塊不可錯位', () => {
    const r = days[0].dailyRows.find((x) => x.項次 === '一.1');
    expect(r).toMatchObject({
      工程項目: '乙種安全圍籬與三角錐連桿警示燈(租用)',
      單位: '式', 契約單價: 60000, 契約數量: 1,
      本日完成數量: 1, 累計完成數量: 1,
    });
    // 沒做的項目本日是 null(沒填),累計是 0
    const r2 = days[0].dailyRows.find((x) => x.項次 === '二.1');
    expect(r2.本日完成數量).toBeNull();
    expect(r2.累計完成數量).toBe(0);
  });

  // 逐項的本日金額此格式不存在(No 表只有欄 1 的當日全表小計)。
  // 用「單價 × 本日數量」回推是推導不是來源值。
  test('沒有的金額欄留 null,不由單價回推', () => {
    for (const r of days[0].dailyRows) expect(r.本日完成金額).toBeNull();
    expect(days[0].header.本日累計金額).toBeNull();
  });
});

// 兩案的 PDF 都是 15~35MB 的掃描件,沒有文字層;SheetJS 對它回一份空活頁簿。
// 回空陣列會被上游當成「這份沒有資料」而靜靜略過。
test('讀不動的檔要明確失敗,不可回空陣列', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/基本資料/);
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const fs = require('fs');
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'shenglong.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('聖隆營造有限公司');
});
