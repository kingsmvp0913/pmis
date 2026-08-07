/**
 * 禾結土木包工業(元長國小污水處理設施)施工日誌讀取器測試。
 *
 * fixture 是 `6.1-6.20.pdf`(20 天,一天兩頁)。這家的形狀問題最多:三個欄位的表頭
 * 擠在同一個 item、資料也會兩欄擠在同一個 item、長名稱印在自己的基線上。
 * 6/1 那天同時帶著這三種形狀,所以斷言集中在它。
 */
const fs = require('fs');
const path = require('path');
const mod = require('../server/parsers/vendors/samples/hejie.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'hejie.pdf');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest()).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商;名字對不上 vendors 表的話,
// 讀取器讀得動也永遠不會被叫到,而且不會有任何錯誤訊息。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('禾結土木包工業');
});

describe('parseAll(元長 6/1-6/20)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 180000);

  test('一天兩頁(第一聯+第二聯)合成一天', () => {
    expect(days.length).toBe(20);
    expect(days[0].header.填報日期).toBe('2025-06-01');
    expect(days[days.length - 1].header.填報日期).toBe('2025-06-20');
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toContain('元長國小辦理');
    expect(h.承包廠商).toBe('禾結土木包工業');
    expect(h.填報日期).toBe('2025-06-01');
    expect(h.星期).toBe('星期日');
    expect(h.開工日期).toBe('2025-04-30');
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    // 表頭同時有「本日」與「累計」兩組進度,取累計那一組(SP3 的 F3/H1 驗累計語意)
    expect(h.預定進度).toBe(36);
    expect(h.實際進度).toBe(90.08);
    // 明細之後那一列「累計(本日完成金額)」
    expect(h.本日累計金額).toBe(20105.23);
  });

  // 有些天的「本 日 氣 候」與「上午:」印在同一個 item 裡。用完全相等比對找不到那一帶,
  // 天氣會整天變 null,SP3 的 A2 就會生出一片假的「天氣未填」。
  test('天氣標籤與值黏在同一個 item 時也要讀得到', () => {
    for (const d of days) {
      expect(d.header.天氣_上午).not.toBeNull();
      expect(d.header.天氣_下午).not.toBeNull();
    }
  });

  test('大類(天干/中文大寫)是大類,不是明細', () => {
    const rows = days[0].dailyRows;
    expect(rows[0]).toMatchObject({ 項次: '甲', 工程項目: '發包工程費', 單位: null, 契約數量: null });
    expect(rows[1]).toMatchObject({ 項次: '壹', 工程項目: '直接工程費', 單位: null });
  });

  // 「  17,500.00         7.00」是一個 item,同時裝著本日金額與累計數量。
  // 不切 token 就會把兩個數字當成一個,而且不會有任何欄位變 null。
  test('兩欄擠在同一個 item 要切得開,且金額 = 數量 × 單價', () => {
    const r7 = days[0].dailyRows.find((r) => r.項次 === '7');
    expect(r7).toEqual({
      項次: '7', 工程項目: '安裝5吋不鏽鋼清潔口與PVC管', 單位: '組',
      契約單價: 2500, 契約數量: 7, 本日完成數量: 7, 本日完成金額: 17500, 累計完成數量: 7,
    });
    for (const d of days) {
      for (const r of d.dailyRows) {
        if (r.本日完成金額 && r.本日完成數量 && r.契約單價) {
          expect(r.本日完成金額).toBeCloseTo(r.本日完成數量 * r.契約單價, 1);
        }
      }
    }
  });

  // 長名稱印在自己的基線上(名稱 y=635.0、契約數量 y=631.8,差 3.2)。分帶容差取 2
  // 會把一列拆成「只有名稱」與「只有數值」兩列,每天多出十幾列殘骸。
  test('長名稱與數值同屬一列', () => {
    const r5 = days[0].dailyRows.find((r) => r.項次 === '5');
    expect(r5.工程項目).toBe('拆除清運廁所既有汙水處理設施頂板,抽水肥,清淤見結構體,結構體破損處修補整平');
    expect(r5.契約單價).toBe(122800);
    expect(r5.契約數量).toBe(1);
    for (const d of days) for (const r of d.dailyRows) expect(r.工程項目).not.toBeNull();
  });

  // 範本印好的空白列每一格都是「-」,左半的項次與名稱會被串成「--」。
  test('整列都是「-」的空白列不收', () => {
    for (const d of days) {
      expect(d.dailyRows.length).toBe(21);              // 大類 2 + 細項 14 + 費用項 5
      expect(d.dailyRows.some((r) => /^-+$/.test(String(r.工程項目)))).toBe(false);
    }
  });

  test('費用項是明細不是大類', () => {
    const last = days[0].dailyRows[days[0].dailyRows.length - 1];
    expect(last).toMatchObject({ 項次: '陸', 單位: '式', 契約單價: 38571, 契約數量: 1 });
  });
});

test('parse 回第一天', async () => {
  const one = await mod.parse(FIXTURE, ctx);
  expect(one.header.填報日期).toBe('2025-06-01');
}, 180000);

test('別家格式的 PDF 要明確失敗', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/第一聯|第二聯/);
}, 180000);

test('沒有文字層的 PDF 要 throw', () => {
  const fake = { filetypes: { extractItems: async () => [{ page: 1, items: [] }] } };
  return expect(mod.parseAll('x.pdf', fake)).rejects.toThrow(/文字層/);
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'hejie.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('禾結土木包工業');
});
