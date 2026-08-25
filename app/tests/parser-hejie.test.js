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

test('表尾金額依日期倒退時視為本日金額，不拿去做 B4 累計比對', () => {
  const days = [
    { header: { 填報日期: '2026-07-21', 本日累計金額: 73671.89 } },
    { header: { 填報日期: '2026-07-22', 本日累計金額: 64757.02 } },
  ];
  expect(mod._internal.clearNonCumulativeHeaders(days)).toBe(true);
  expect(days.map((d) => d.header.本日累計金額)).toEqual([null, null]);
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

// ── 名稱折行(明禮 7/1-7/30 的真實座標)────────────────────────────
// 這家的長名稱會折成兩到三行,而項次與數值**不一定落在同一行**:
//   項次 3 —— 名稱首行在上,項次與數值在下一行
//   項次 4 —— 契約數量甚至自己單獨一行
//   項次 27 —— 項次與名稱首行在上,名稱續行與數值在下一行
// 一行當一列的話,每天會多出沒有項次的假列(A4 硬錯)、真列名稱只剩半截(E3 警告),
// 還會漏掉契約數量(A7 硬錯)。實測明禮 30 天 1050 列裡 30 個 A4、21 個 A7。
//
// ⚠️ 不可以用「行距小於某個值就併」:項次 3 的數量行離項次 4 的名稱首行只有 7.7,
// 而同一列各行的距離是 5.0~7.7 —— 照距離併會把 3 和 4 併成一列。
test('長名稱折行時,項次/名稱/數值要併回同一列', async () => {
  const it = (x, y, w, s) => ({ x, y, w, s });
  const detail = [
    it(236.9, 784.9, 106.7, '公共工程施工日誌'),
    it(48.2, 769.6, 16.0, '第二聯     '),
    it(110.8, 735.7, 46.1, '工 程 項 目'), it(295.3, 735.7, 33.5, '契約數量'),
    it(49.8, 735.7, 14.9, '項次'),
    it(346.0, 735.7, 150.4, '本日完成數量  本日完成金額   累計完成數量'),
    it(208.2, 735.7, 16.6, '單位    契約單價'), it(524.2, 735.7, 16.6, '備註'),
    // 項次 3:名稱首行單獨一行,項次與數值在 5.4 之下
    it(69.1, 673.3, 190.0, '施工動線開闢與損壞復原,既有設備管線遷移與復原;測'),
    it(56.0, 667.9, 4.1, '3'), it(69.1, 667.9, 30.0, '量與放樣'),
    it(212.4, 667.9, 9.1, '式'), it(246.8, 667.9, 33.0, '7,500.00'),
    it(295.6, 667.9, 20.0, '      '), it(313.4, 667.9, 16.0, '1.00'),
    // 項次 4:名稱首行帶著本日完成數量,契約數量「1」自己一行(離 3 只有 7.7)
    it(69.0, 656.8, 220.0, '既有牆面、地坪、磁磚、衛生設備、給排水設施、搗擺及天'),
    it(56.0, 651.6, 4.1, '4'), it(69.0, 651.6, 170.0, '花板等拆除(含切割)及運棄'),
    it(212.4, 651.6, 9.1, '式'), it(238.0, 651.6, 41.0, '373,931.00'),
    it(295.6, 651.6, 20.0, '      '), it(313.4, 651.6, 16.0, '1.00'),
    // 項次 27:項次與名稱首行在上,續行與數值在下
    it(53.8, 328.1, 8.4, '27'), it(69.0, 328.1, 215.0, '施做緊急求救按鈕(含閃光與蜂嗚警報器,各層'),
    it(69.0, 322.9, 165.0, '樓每間廁所皆有求救鈕,責任施工)'),
    it(212.4, 322.9, 9.1, '式'), it(242.4, 322.9, 37.0, '34,000.00'),
    it(295.6, 322.9, 20.0, '      '), it(313.4, 322.9, 16.0, '1.00'),
    it(355.0, 322.9, 30.0, '  0.010'),
    it(410.0, 322.9, 37.8, '   340.00'), it(478.0, 322.9, 37.8, '     0.010'),
  ];
  const fake = { filetypes: { extractItems: async () => [{ page: 1, items: detail }] } };
  const [d] = await mod.parseAll('x.pdf', fake);
  expect(d.dailyRows).toHaveLength(3);
  expect(d.dailyRows[0]).toMatchObject({
    項次: '3',
    工程項目: '施工動線開闢與損壞復原,既有設備管線遷移與復原;測量與放樣',
    單位: '式', 契約單價: 7500, 契約數量: 1,
  });
  expect(d.dailyRows[1]).toMatchObject({
    項次: '4',
    工程項目: '既有牆面、地坪、磁磚、衛生設備、給排水設施、搗擺及天花板等拆除(含切割)及運棄',
    契約數量: 1,
  });
  expect(d.dailyRows[2]).toMatchObject({
    項次: '27',
    工程項目: '施做緊急求救按鈕(含閃光與蜂嗚警報器,各層樓每間廁所皆有求救鈕,責任施工)',
    單位: '式', 契約單價: 34000, 契約數量: 1,
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
