/**
 * 力龍企業有限公司(四湖國小跳遠場地整修工程)施工日誌讀取器測試。
 *
 * fixture 是 7 月份 PDF(32 頁 = 封面 1 頁 + 31 天 × 1 頁)。
 *
 * 斷言集中在四個「錯了不會有任何欄位變 null」的地方:
 *   ① **表頭只有 6 個標籤,資料有 7 個數值欄** —— 契約單價/複價/累計金額都在
 *      「備註」標籤右邊,欄界推錯會把複價當成單價,而複價也是個合法數字
 *   ② 沒有「本日完成金額」欄 —— 拿累計金額頂替不會有任何欄位變 null
 *   ③ 廠商把 7/8 填成 7/9(fixture 有兩個 7/9、沒有 7/8)—— 去重或推算都會蓋掉這個錯
 *   ④ 單位的上標數字(M3 的 3)印在另一個 y 帶 —— 合不回來就變成裸的「M」
 */
const path = require('path');
const mod = require('../server/parsers/vendors/samples/lilong.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'lilong.pdf');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest()).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商(四湖跳遠決標公告),不是檔名推定
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('力龍企業有限公司');
});

describe('parseAll(四湖跳遠 7 月)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 180000);

  test('31 天(封面不算),每天 19 列', () => {
    expect(days.length).toBe(31);
    expect(days.every((d) => d.dailyRows.length === 19)).toBe(true);
  });

  // ③ 廠商把 7/8 那頁的日期填成 7/9。這是真的資料錯,要讓 SP3 的 D1 報出來,
  // 讀取器不去重也不由頁序推算——修正版(7月(1).pdf)存在與否是上層的事。
  test('照收廠商填錯的日期:有兩個 7/9、沒有 7/8', () => {
    const d = days.map((x) => x.header.填報日期);
    expect(d.filter((x) => x === '2026-07-09').length).toBe(2);
    expect(d).not.toContain('2026-07-08');
    expect(d[0]).toBe('2026-07-01');
    expect(d[d.length - 1]).toBe('2026-07-31');
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('四湖國小跳遠場地整修工程');
    expect(h.承包廠商).toBe('力龍企業有限公司');
    expect(h.開工日期).toBe('2026-06-12');
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('雨');
    // PDF 印百分數,照收不換算
    expect(h.預定進度).toBe(22.12);
    expect(h.實際進度).toBe(25.07);
    expect(h.本日累計金額).toBe(119932);
    // 版面上沒有星期欄,不由日期回推(那是系統代填,不是來源資料)
    expect(h.星期).toBeNull();
  });

  // ① 欄界訂對了,契約單價 × 契約數量 才會等於表上印的契約複價。
  // 單價欄若吃到隔壁的複價,這條會整排失敗(複價 20650 也是合法數字,不會變 null)。
  test('契約單價不是隔壁的契約複價', () => {
    const r = days[0].dailyRows;
    expect(r[0]).toMatchObject({ 項次: '1', 單位: '式', 契約數量: 1, 契約單價: 8000 });
    expect(r[3]).toMatchObject({ 項次: '4', 單位: 'M2', 契約數量: 59, 契約單價: 350 });
    expect(r[6]).toMatchObject({ 項次: '7', 單位: 'kg', 契約數量: 9940, 契約單價: 6 });
  });

  // ② 這家的 7 個數值欄裡沒有本日金額(x534 那欄是累計完成數量 × 單價)。
  test('本日完成金額整份都是 null,不拿累計金額頂替', () => {
    const rows = days.flatMap((d) => d.dailyRows);
    expect(rows.every((r) => r.本日完成金額 === null)).toBe(true);
  });

  // 「  -」是「沒填」,0.0 是「填了 0」——兩件事,不可混為一談
  test('本日完成數量的「-」是 null,不是 0', () => {
    const r = days[0].dailyRows;
    expect(r[0].本日完成數量).toBeNull();
    expect(r[5].本日完成數量).toBeNull();
    expect(r[0].累計完成數量).toBe(1);
    expect(r[5].累計完成數量).toBe(0);
  });

  test('單位/契約數量/契約單價整份零缺漏', () => {
    const rows = days.flatMap((d) => d.dailyRows);
    expect(rows.length).toBe(589);
    for (const k of ['單位', '契約數量', '契約單價', '累計完成數量']) {
      expect(rows.filter((r) => r[k] == null).length).toBe(0);
    }
  });

  // 費用項目的項次是中文大寫(含異體字「参」),名稱縮排到 x65
  test('費用項目照收,名稱縮排不影響歸欄', () => {
    const fee = days[0].dailyRows.filter((r) => !/^\d+$/.test(r.項次));
    expect(fee.map((r) => r.項次)).toEqual(['貳', '参', '肆', '伍', '陸']);
    expect(fee[0].工程項目).toBe('職業安全衛生管理費與施工環境保護與清潔');
    expect(fee[0].契約單價).toBe(8247);
  });

  // 名稱被 Excel 欄寬截掉(經費總表寫「…廢土方，整地，灑水壓實」),照收不補字
  test('名稱照收來源的截斷,不補字', () => {
    expect(days[0].dailyRows[3].工程項目).toBe('跳遠場預定地及既有砂坑開挖清運廢土方,整地,');
  });

  // ④ 上標的 3 印在比值高 3pt 的另一個 y 帶,合不回來單位就是裸的「M」
  test('材料單位把上標數字合回來(M3 不是 M)', () => {
    const d = days.find((x) => (x.extras.主要材料 || []).some((m2) => m2.名稱 === '級配' && m2.單位));
    expect(d).toBeDefined();
    expect(d.extras.主要材料.find((m2) => m2.名稱 === '級配')).toMatchObject({ 單位: 'M3', 數量: 7 });
    // 同一張表裡分成兩個 item 的那欄(數量「0.0」與單位「M」各自一個 item)也要合起來
    const 混 = days.flatMap((x) => x.extras.主要材料 || []).find((m2) => m2.名稱 === '混凝土' && m2.單位);
    expect(混.單位).toBe('M3');
  });

  test('出工與機具分開,出工總人數只算工別', () => {
    const d = days.find((x) => x.header.出工總人數);
    expect(d.extras.出工明細.map((x) => x.工別)).toEqual(['普通工', '水泥工', '鋼筋工', '板模工']);
    expect(d.extras.主要機具.map((x) => x.名稱)).toEqual(['貨車', '挖土機', '鏟裝機']);
    expect(d.header.出工總人數).toBe(d.extras.出工明細.reduce((n, x) => n + (x.人數 || 0), 0));
  });
});

// 「施 工 項 目」是工程會標準表單的共通錨點,至少 8 家都有。只回空陣列比讀不動更糟:
// 上游會把它當成「這份沒有資料」靜靜略過。
test('餵別家的日誌要 throw,不可回空陣列', async () => {
  const 別家 = path.join(__dirname, 'fixtures', 'yuanfang.pdf');
  await expect(mod.parseAll(別家, ctx)).rejects.toThrow(/讀不到任何施工日誌日期/);
}, 180000);

test('.doc/.docx 要明確拒收並指路', async () => {
  await expect(mod.parseAll('x.docx', ctx)).rejects.toThrow(/先把 \.doc\/\.docx 轉成 PDF/);
});
