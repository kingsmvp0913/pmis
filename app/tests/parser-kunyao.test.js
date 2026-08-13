/**
 * 坤曜土木工程有限公司(台西國中西側廁所整修)施工日誌讀取器測試。
 *
 * fixture 是 `台西廁所施工日誌(1).XLSX`(同資料夾的 `台西施工日誌(1).XLSX` 內容相同)。
 * 這份檔有四個 `日報表(7)~(10)` 分頁,但**只有 (7) 填了資料**,另外三個是還沒填的
 * 月份範本、日期卻照樣印著 7 月。
 *
 * 斷言集中在三個「錯了不會有任何欄位變 null」的地方:
 *   ① 填報日期那格沒有標籤,同一列右邊有頁碼 —— 撈到頁碼會變成 1900-01-01
 *   ② 空白月份範本的明細列數與有資料的那份**相同**,去重只比列數會丟掉真資料
 *   ③ 「本日完成金額」在這家真的是本日金額(同族的有謙那家是累計金額)
 */
const fs = require('fs');
const path = require('path');
const mod = require('../server/parsers/vendors/samples/kunyao.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'kunyao.xlsx');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest(filetypes)).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商(台西國中西側廁所整修工程_決標公告.pdf,
// C1150415)。⚠️ 是「土木工程有限公司」不是「營造」——寫錯就永遠不會被叫到。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('坤曜土木工程有限公司');
});

describe('parseAll(台西國中廁所)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 120000);

  // ② 四個分頁 × 31 天 = 124 個區塊,日期全是 7 月。去重後要剩 31 天,
  // 而且留下的必須是**有資料的** `日報表(7)`。
  test('四個分頁的區塊去重成 31 天,留下有資料的那一份', () => {
    expect(days.length).toBe(31);
    expect(days[0].header.填報日期).toBe('2026-07-01');
    expect(days[30].header.填報日期).toBe('2026-07-31');
    expect(days.filter((d) => d.header.實際進度 != null)).toHaveLength(31);
    expect(days[30].header.實際進度).toBeCloseTo(0.1295445, 6);
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('台西國中教學大樓西側廁所整修工程');
    expect(h.承包廠商).toBe('坤曜土木工程有限公司');
    expect(h.開工日期).toBe('2026-07-01');
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    // 進度是分數(0.535%),保留原值不換算
    expect(h.預定進度).toBeCloseTo(0.00398008, 7);
    expect(h.實際進度).toBeCloseTo(0.00535241, 7);
    expect(h.出工總人數).toBe(1);                      // 大工只有累計 0,不可算進來
    expect(h.星期).toBeNull();                         // 此格式不提供
  });

  // ① 天氣列長這樣:欄0 標籤、欄1~3 天氣整句、欄4~6 日期序號、欄9 頁碼。
  // 取「第一個數字」會撈到頁碼 1 → 1900-01-01(振典的讀取器對這份檔就是這樣壞的)。
  test('填報日期取的是日期序號不是頁碼', () => {
    expect(days.map((d) => d.header.填報日期)).not.toContain('1900-01-01');
    const dates = days.map((d) => d.header.填報日期);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
  });

  test('每天 34 項,項次照收(含中文大寫的費用項)', () => {
    const 列數 = days.map((d) => d.dailyRows.length);
    expect(new Set(列數)).toEqual(new Set([34]));
    const nos = days[0].dailyRows.map((r) => r.項次);
    expect(nos.slice(0, 3)).toEqual(['1', '2', '3']);
    expect(nos.slice(-5)).toEqual(['貳', '參', '肆', '伍', '陸']);
  });

  test('大類列「壹 直接工程費」不會變成明細', () => {
    const names = days[0].dailyRows.map((r) => r.工程項目);
    expect(names).not.toContain('直接工程費');
  });

  test('明細逐欄', () => {
    const r = days[0].dailyRows[0];
    expect(r.工程項目).toContain('工程告示牌與職安衛告示牌');
    expect(r.單位).toBe('式');
    expect(r.契約數量).toBe(1);
    expect(r.契約單價).toBe(10508);
    // 砌 1/2B 磚牆:日誌寫 11.55 M2,而發包後經費總表寫 12 —— 照讀不修,
    // 讓 SP3 的 E5 報出兩份文件不一致(那是承辦人要去確認的事,不是讀取器該補的)
    const r6 = days[0].dailyRows.find((x) => x.項次 === '6');
    expect(r6.單位).toBe('M2');
    expect(r6.契約數量).toBe(11.55);
  });

  // ③ 4216 列裡 4216 列符合「= 本日 × 單價」,只有 3536 列同時符合「= 累計 × 單價」。
  // 同族的有謙那家標籤寫「實做金額」、值卻是累計金額 —— 標籤不是證據。
  test('本日完成金額 = 本日完成數量 × 單價', () => {
    const rows = days.flatMap((d) => d.dailyRows)
      .filter((r) => r.本日完成金額 != null && r.契約單價 != null);
    expect(rows.length).toBeGreaterThan(1000);
    const 不符 = rows.filter((r) => Math.abs(r.本日完成金額 - (r.本日完成數量 || 0) * r.契約單價) >= 0.5);
    expect(不符).toHaveLength(0);
  });

  // 「本日完成總金額」是當日本日金額的合計,不是累計金額。填進去會讓 SP3 的 B4
  // 拿本日合計去比各項累計總和,天天不符。
  test('本日累計金額整份 null —— 此格式沒有累計金額', () => {
    expect(days.filter((d) => d.header.本日累計金額 != null)).toHaveLength(0);
  });

  test('必要欄位零缺漏', () => {
    const rows = days.flatMap((d) => d.dailyRows);
    expect(rows).toHaveLength(1054);
    expect(rows.filter((r) => r.單位 == null)).toHaveLength(0);
    expect(rows.filter((r) => r.契約數量 == null)).toHaveLength(0);
    expect(rows.filter((r) => r.契約單價 == null)).toHaveLength(0);
    expect(rows.filter((r) => r.項次 == null)).toHaveLength(0);
  });
});

// 「表報編號：」是至少 8 家共用的錨點。光靠錨點會假陽性:讀得出一堆天、卻每天都是空的。
test('錨點對上但版面不同的檔要明確失敗,不可回一堆空白天', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'qiquan.xlsx'), ctx))
    .rejects.toThrow(/讀不到填報日期|表報編號|明細表頭/);
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'kunyao.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('坤曜土木工程有限公司');
});
