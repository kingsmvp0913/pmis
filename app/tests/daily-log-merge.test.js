/**
 * 多檔合併。明德那家的兩聯分在兩個 PDF 檔,各有一半欄位;久木那種一案六份月檔
 * 也走這條路(單檔跑 SP3 必然大量 B3/F4 硬錯,合併後歸零)。
 */
const { mergeDays } = require('../server/daily-log-merge');

const 第一聯 = [{
  header: { 填報日期: '2026-07-06', 天氣_上午: '晴', 天氣_下午: '晴',
    預定進度: 0.63, 實際進度: 1.29, 承包廠商: '明德土木包工業', 開工日期: '2026-07-06',
    工程名稱: '東榮國中廁所' },
  dailyRows: [
    { 項次: '告示牌', 工程項目: '告示牌', 單位: '式', 契約單價: null, 契約數量: 1,
      本日完成數量: 1, 本日完成金額: null, 累計完成數量: 1 },
  ],
  extras: {},
}];

const 第二聯 = [{
  header: { 填報日期: '2026-07-06', 天氣_上午: null, 天氣_下午: null,
    預定進度: null, 實際進度: null, 承包廠商: null, 開工日期: null,
    工程名稱: '東榮國中廁所' },
  dailyRows: [
    { 項次: '1', 工程項目: '告示牌', 單位: '式', 契約單價: 11000, 契約數量: 1,
      本日完成數量: 1, 本日完成金額: 11000, 累計完成數量: 1 },
    { 項次: '2', 工程項目: '動線開闢', 單位: '式', 契約單價: 10000, 契約數量: 1,
      本日完成數量: 1, 本日完成金額: 10000, 累計完成數量: 1 },
  ],
  extras: {},
}];

test('兩聯合併:header 逐欄補、明細取完整的那份', () => {
  const { days, conflicts } = mergeDays([第一聯, 第二聯]);
  expect(days).toHaveLength(1);
  const h = days[0].header;
  expect(h.天氣_上午).toBe('晴');                     // 只有第一聯有
  expect(h.實際進度).toBe(1.29);                      // 只有第一聯有
  expect(h.承包廠商).toBe('明德土木包工業');
  // 明細取第二聯(有單價),不是列數多就贏——第一聯若剛好列多也不能蓋掉單價
  expect(days[0].dailyRows).toHaveLength(2);
  expect(days[0].dailyRows[0].契約單價).toBe(11000);
  expect(conflicts).toHaveLength(0);
});

// 檔案順序不可以影響結果:第一聯與第二聯的頁序不保證一致(賜利發實測是倒的)
test('顛倒上傳順序,結果相同', () => {
  const a = mergeDays([第一聯, 第二聯]).days[0];
  const b = mergeDays([第二聯, 第一聯]).days[0];
  expect(b.header.天氣_上午).toBe('晴');
  expect(b.dailyRows[0].契約單價).toBe(11000);
  expect(b.dailyRows).toHaveLength(a.dailyRows.length);
});

// 靜默挑一個會讓「這兩份檔其實不是同一案」永遠看不見
test('同一天同一欄兩個值不同 → 保留先出現的並報 conflict', () => {
  const 別案 = [{ ...第二聯[0], header: { ...第二聯[0].header, 工程名稱: '別的工程' } }];
  const { days, conflicts } = mergeDays([第一聯, 別案]);
  expect(days[0].header.工程名稱).toBe('東榮國中廁所');
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]).toMatchObject({ 日期: '2026-07-06', 欄位: '工程名稱' });
});

test('不同日期各自成一天,依日期排序', () => {
  const 第二天 = [{ ...第一聯[0], header: { ...第一聯[0].header, 填報日期: '2026-07-05' } }];
  const { days } = mergeDays([第一聯, 第二天]);
  expect(days.map((d) => d.header.填報日期)).toEqual(['2026-07-05', '2026-07-06']);
});

// 沒有日期就無從合併(把它併到任何一天都是猜)
test('沒有填報日期的天略過', () => {
  const 無日期 = [{ header: { 填報日期: null }, dailyRows: [], extras: {} }];
  expect(mergeDays([無日期]).days).toHaveLength(0);
});

test('單一檔案時行為不變', () => {
  const { days, conflicts } = mergeDays([第二聯]);
  expect(days).toHaveLength(1);
  expect(days[0].dailyRows).toHaveLength(2);
  expect(conflicts).toHaveLength(0);
});

test('空輸入不會爆', () => {
  expect(mergeDays([]).days).toHaveLength(0);
  expect(mergeDays(null).days).toHaveLength(0);
});
