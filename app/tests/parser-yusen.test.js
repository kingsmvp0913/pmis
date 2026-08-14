/**
 * 玉森讀取器測試(兩聯兩種載體)。
 *   第二聯 .xls  tests/fixtures/yusen.xls(2 分頁:進度 / 施工日誌(第二聯)-全 (修),91 天)
 *   第一聯 .docx tests/fixtures/yusen-first.docx(鹿場國小,11 天)
 *                + tests/fixtures/yusen-first-second.xls(同案第二聯,拿來驗合併)
 */
const path = require('path');
const mod = require('../server/parsers/vendors/samples/yusen.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');
const { mergeDays } = require('../server/daily-log-merge');

const FIXTURE = path.join(__dirname, 'fixtures', 'yusen.xls');
const FIRST = path.join(__dirname, 'fixtures', 'yusen-first.docx');
const SECOND = path.join(__dirname, 'fixtures', 'yusen-first-second.xls');
const ctx = { filetypes };

test('selfTest 以內建 grid 通過,不需注入', () => {
  expect(mod.selfTest()).toBe(true);
});

// vendorKey 曾被推定成「玉森營造有限公司」(樣本檔沒有廠商全名),而 5 個舊案的
// 決標公告一致是「玉森土木包工業」。org-match.findByName 是逐字相等,名字錯了
// 讀取器就永遠叫不出來——**而且沒有任何錯誤訊息**,看起來像這家還沒有讀取器。
// 71 份日誌因此閒置了一整輪。釘住它,不要再靠人記得去核對。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('玉森土木包工業');
});

describe('yusen parse(第一天)', () => {
  let out;
  beforeAll(async () => { out = await mod.parse(FIXTURE, ctx); });

  test('工程名稱去掉「工程名稱：」標籤', () => {
    expect(out.header.工程名稱).not.toMatch(/^工程名稱/);
    expect(out.header.工程名稱).toMatch(/大有國民小學/);
  });

  // 日期在儲存格裡是 Excel 序號 46113,當字串 regex 會整份抓不到
  test('填報日期由序號轉出', () => {
    expect(out.header.填報日期).toBe('2026-04-01');
  });

  // 預定進度不在第二聯,要從「進度」分頁依日期對照補進來
  test('預定進度取自進度分頁', () => {
    expect(out.header.預定進度).toBe(0.38);
  });

  // ⚠️ 上面那條驗不出取錯欄:進度分頁的「每日預計進度」(欄2)與累計(欄3)在**第一天
  // 剛好相等**(0.38/0.38)。要驗就得看第二天——欄2 還是 0.38、欄3 已經是 0.76。
  // 監造報表的「預定進度(%)」要的是累計,原本取欄 2 是錯的,接上第一聯才現形
  // (第一聯印的「累計預定進度」與欄 3 逐格吻合)。
  test('預定進度取的是累計那一欄,不是每日增量', async () => {
    const days = await mod.parseAll(FIXTURE, ctx);
    expect(days[1].header.預定進度).toBe(0.76);
    expect(days[2].header.預定進度).toBeCloseTo(1.14, 6);
  });

  test.each([['天氣_上午'], ['天氣_下午'], ['星期'], ['實際進度'], ['出工總人數']])(
    '%s 此格式不提供,回 null', (k) => {
      expect(out.header[k]).toBeNull();
    });

  test('明細八欄俱全', () => {
    const r1 = out.dailyRows.find((r) => r.項次 === '1');
    expect(r1).toMatchObject({
      單位: '式', 契約單價: 5000, 契約數量: 1,
      本日完成數量: 0.2, 本日完成金額: 1000, 累計完成數量: 0.2,
    });
  });

  // 明細區後面接著「累計(本日完成金額)」與簽名欄,不停就會吃成假項目
  test('明細讀到非項次列即停,不吃到累計列與簽名欄', () => {
    const 非項次 = out.dailyRows.filter((r) => !/^(\d+|[壹貳參参肆伍陸柒捌玖拾])$/.test(r.項次));
    expect(非項次).toEqual([]);
  });

  // 沒施工的日子:金額 0 是真的 0,數量空白才是 null——兩者語意不同
  test('空白轉 null 而 0 保持 0', () => {
    const 有零金額 = out.dailyRows.filter((r) => r.本日完成金額 === 0);
    expect(有零金額.length).toBeGreaterThan(0);
    const 有空數量 = out.dailyRows.filter((r) => r.本日完成數量 === null);
    expect(有空數量.length).toBeGreaterThan(0);
  });

  test('每一列都解析得出單位與契約數量單價', () => {
    const 缺 = out.dailyRows
      .filter((r) => r.單位 == null || r.契約數量 == null || r.契約單價 == null)
      .map((r) => `${r.項次} ${r.工程項目}`);
    expect(缺).toEqual([]);
  });
});

describe('yusen parseAll', () => {
  let all;
  beforeAll(async () => { all = await mod.parseAll(FIXTURE, ctx); });

  test('91 天,日期遞增', () => {
    expect(all).toHaveLength(91);
    const dates = all.map((d) => d.header.填報日期);
    expect([...dates].sort()).toEqual(dates);
  });

  // 施工項目的累計會累加(項次4:0.1 → 0.2),費用項目的累計欄則各家語意不一,
  // 這裡只釘住施工項目——那是 SP3 B2/F1 判硬錯的依據
  test('施工項目的累計逐日累加', () => {
    const seq = all.slice(0, 5).map((d) => (d.dailyRows.find((r) => r.項次 === '4') || {}).累計完成數量);
    expect(seq[0]).toBe(0.1);
    expect(seq[1]).toBe(0.2);
  });
});

// ── 第一聯(.docx)與兩聯合併 ──────────────────────────────────
// 兩聯分成兩個檔:第二聯有完整明細與單價、**沒有天氣星期進度出工**;第一聯反過來。
// 只讀一個檔不會有任何欄位「看起來」有問題——SP3 只會說「此格式不提供」然後放行,
// 天氣欄就一路空到監造報表。
describe('yusen 第一聯(.docx)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIRST, ctx); }, 60000);

  test('11 天,日期取自表格前面的段落', () => {
    expect(days.length).toBe(11);
    expect(days[0].header.填報日期).toBe('2026-07-21');
    expect(days[10].header.填報日期).toBe('2026-07-31');
  });

  test('補的正是第二聯缺的那幾欄', () => {
    const h = days[0].header;
    expect(h.星期).toBe('星期二');
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    expect(h.實際進度).toBe(0.96);
    expect(h.出工總人數).toBe(2);
    expect(h.承包廠商).toBe('玉森土木包工業');
    expect(h.開工日期).toBe('2026-07-21');
  });

  // 百分號去掉就好,不可以再除以 100:第二聯的進度分頁給的是同一個數字(0.28),
  // 換算了會讓同一家兩種載體差 100 倍,合併時每天都變 conflict。
  test('進度只去百分號不換算,與第二聯同一個尺度', async () => {
    expect(days[0].header.預定進度).toBe(0.28);
    const 二 = await mod.parseAll(SECOND, ctx);
    expect(二[0].header.預定進度).toBe(0.28);
  }, 60000);

  // 第一聯的「四、營造專業工程特定施工項目」是技術士用的,不是契約項目明細。
  // 收成 dailyRows 會讓合併層誤判完整度,把第二聯真正的明細換掉。
  test('沒有工程項目明細,dailyRows 留空', () => {
    expect(days.every((d) => d.dailyRows.length === 0)).toBe(true);
  });

  test('出工與機具分開,人數只算工別', () => {
    const e = days[0].extras;
    expect(e.出工明細.map((x) => x.工別)).toContain('體力工');
    expect(e.出工明細.find((x) => x.工別 === '體力工').人數).toBe(2);
    expect(e.主要機具.map((x) => x.名稱)).toContain('挖土機');
    // 沒填的欄位是 null 不是 0:沒來人與來 0 人是同一件事,但「沒填」不是
    expect(e.出工明細.find((x) => x.工別 === '泥水工').人數).toBeNull();
  });

  test('餵第二聯的 .xls 進來仍走 Excel 那條路,不會被 docx 分流吃掉', async () => {
    const 二 = await mod.parseAll(SECOND, ctx);
    expect(二[0].dailyRows.length).toBeGreaterThan(0);
    expect(二[0].header.天氣_上午).toBeNull();
  }, 60000);
});

describe('兩聯合併(daily-log-merge)', () => {
  let merged;
  beforeAll(async () => {
    const a = await mod.parseAll(FIRST, ctx);
    const b = await mod.parseAll(SECOND, ctx);
    merged = mergeDays([a, b]);
  }, 120000);

  test('11 天,每天同時有天氣與明細', () => {
    expect(merged.days.length).toBe(11);
    expect(merged.days.every((d) => d.header.天氣_上午)).toBe(true);
    expect(merged.days.every((d) => d.dailyRows.length > 0)).toBe(true);
    expect(merged.days.every((d) => d.header.實際進度 != null)).toBe(true);
  });

  // 第一聯的 0.84 與第二聯累加出來的 0.8400000000000001 是同一個值。
  // 字串比對之下 11 天會噴 10 個假衝突,真正該看的衝突就被淹掉了。
  test('浮點累加誤差不算衝突', () => {
    expect(merged.conflicts).toEqual([]);
  });
});
