/**
 * 禾吉土木包工業(長福國小老舊廁所整修)施工日誌讀取器測試。
 *
 * fixture 是 `1151022-1151031-施工日誌-長福國小….pdf`(20 頁 = 10 天 × 2 頁)。
 * 施工項目表左右兩組並排、名稱跨行且數值印在名稱塊垂直中央、10/29 那兩頁的
 * 日期數字被字型抽成控制字元——三個形狀都在這份檔裡。
 */
const fs = require('fs');
const path = require('path');
const mod = require('../server/parsers/vendors/samples/heji.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'heji.pdf');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest()).toBe(true);
});

// 名字對不上 vendors 表的話,讀取器讀得動也永遠不會被叫到,而且沒有任何錯誤訊息。
// 禾吉 ≠ 禾結(hejie),只差一個字。
test('vendorKey 是日誌上的承攬廠商名', () => {
  expect(mod.meta.vendorKey).toBe('禾吉土木包工業');
});

describe('parseAll(長福 10/22-10/31)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 120000);

  test('一天兩頁併成一天,10 天連續', () => {
    expect(days.map((d) => d.header.填報日期)).toEqual([
      '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26',
      '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31',
    ]);
  });

  // 第 15、16 頁的「115年10月2?日」在文字層裡就是控制字元。日期讀不到的那天
  // 在上游等於整天不存在;反過來,硬猜一個數字又可能把兩天疊成一天(D1)。
  // 只有「萬用比對 × 星期 × 開工日+已過工期」交集唯一時才採用。
  test('字型缺字的那天由三個來源欄位交集還原成 10/29', () => {
    const d = days[7];
    expect(d.header.填報日期).toBe('2026-10-29');
    expect(d.header.星期).toBe('星期四');
    expect(d.dailyRows).toHaveLength(31);
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h).toMatchObject({
      工程名稱: '長福國小114年老舊廁所整修工程',
      承包廠商: '禾吉土木包工業',
      星期: '星期四',
      開工日期: '2026-10-22',
      天氣_上午: '晴天',
      天氣_下午: '晴天',
      預定進度: 0.35,       // PDF 印百分數,照收不換算
      實際進度: 0.8,
      出工總人數: 3,        // 工程師 1 + 體力工 2(第二頁)
    });
    expect(days[9].header.預定進度).toBe(3.5);
    expect(days[9].header.實際進度).toBe(4.58);
  });

  // 每天印完整清單:左 16 列 + 右 15 列。項次用出現序,兩組的順序不能顛倒,
  // 也不能有一組整組沒收到(那樣項次會整批位移,而每一列看起來都還是合法的)。
  // 費用項改用中文大寫貳~陸:編成 27~31 的話,契約表沒有這些項次,名稱又因
  // 「職業安全衛生管理費)」「營業稅」與契約全名不同而對不上 → 四項 E1 硬錯 × 每天(長福 20261106-0001)。
  test('左右兩組依序合成 31 列,施工項次為出現序、費用項為貳~陸', () => {
    const want = [...Array.from({ length: 26 }, (_, i) => String(i + 1)), '貳', '參', '肆', '伍', '陸'];
    for (const d of days) {
      expect(d.dailyRows).toHaveLength(31);
      expect(d.dailyRows.map((r) => r.項次)).toEqual(want);
    }
    const rows = days[0].dailyRows;
    expect(rows[0].工程項目).toBe('乙種施工圍籬、警示帶、安全警示燈等安全措施(租用)');
    expect(rows[15].工程項目).toBe('安裝13mm熱固性樹脂板隔間含門片(頂面H=200cm以上)');
    expect(rows[16].工程項目).toBe('廁間安裝不鏽鋼掛鈎與置物板');
    expect(rows[30].工程項目).toBe('營業稅');
  });

  // 名稱跨三~五行、數值印在中央。用「離最近的數值列」分配,右欄求救按鈕那列的
  // 第一行只差 1.6pt 就會被分到上一列——兩列名稱都錯,且沒有任何欄位變 null。
  test('跨行名稱對稱分配,不會黏到相鄰列', () => {
    const rows = days[0].dailyRows;
    expect(rows[3].工程項目).toBe('既有地坪、台階、磁磚、衛生設備、給排水設施、搗擺及天花板等拆除(含切割)及運棄(含合法證明);環境保護與清潔');
    expect(rows[22].工程項目).toBe('給排水系統配管與安裝(連工帶料)');
    expect(rows[23].工程項目).toBe('施做緊急求救按鈕(含閃光與蜂嗚警報器、線材、五金配件, 各層樓每間廁所皆有求救鈕,連工帶料,責任施工)');
    expect(rows[24].工程項目).toBe('安裝廁所指標系統、拖把夾(連工帶料,責任施工)');
  });

  test('數值依表頭欄界歸欄;空白是 null 不是 0', () => {
    const rows = days[0].dailyRows;
    expect(rows[1]).toEqual({
      項次: '2', 工程項目: '工程告示牌與職安衛告示牌(租用)', 單位: '式',
      契約單價: null, 契約數量: 1, 本日完成數量: 1, 本日完成金額: null, 累計完成數量: 1,
    });
    expect(rows[6]).toMatchObject({ 單位: 'M2', 契約數量: 302, 本日完成數量: null, 累計完成數量: null });
    // 右組:本日與累計欄不可互換(10/22 本日 1.000、累計 1.00)
    expect(rows[29]).toMatchObject({ 工程項目: '營造綜合保險費', 本日完成數量: 1, 累計完成數量: 1 });
    // 10/31 項次 4 本日 0.25;費用項本日 0.03、累計由 0.02 → 0.05
    const last = days[9].dailyRows;
    expect(last[3]).toMatchObject({ 本日完成數量: 0.25, 累計完成數量: 0.25 });
    expect(last[26]).toMatchObject({ 本日完成數量: 0.03, 累計完成數量: 0.05 });
  });

  // 來源值照收:多一個右括號是廠商印的,不替它修
  test('來源的多餘括號照收', () => {
    expect(days[0].dailyRows[26].工程項目).toBe('職業安全衛生管理費)');
  });

  test('累計 = 前一日累計 + 本日(整份)', () => {
    for (let i = 1; i < days.length; i += 1) {
      days[i].dailyRows.forEach((r, k) => {
        const prev = days[i - 1].dailyRows[k].累計完成數量 || 0;
        if (r.累計完成數量 == null) return;
        expect(r.累計完成數量).toBeCloseTo(prev + (r.本日完成數量 || 0), 6);
      });
    }
  });

  test('第二頁的人員機具併進同一天;本日空白的天不收', () => {
    expect(days[3].extras.出工明細).toEqual([
      { 工別: '工程師', 人數: 1 }, { 工別: '普通工', 人數: 2 }, { 工別: '體力工', 人數: 2 },
    ]);
    expect(days[3].header.出工總人數).toBe(5);
    expect(days[1].extras).toEqual({});
    expect(days[1].header.出工總人數).toBeNull();
  });
});

// 「公共工程施工日誌」「填報日期」是工程會標準表單的共通錨點,別家的檔也有。
// 別家的檔要嘛 throw,要嘛讀出 0 列明細;絕不可回「有日期、有 31 列明細」的假陽性。
test('別家的檔不會被當成禾吉日誌讀出明細', async () => {
  for (const other of ['hejie.pdf', 'jinda.pdf', 'mingde.pdf']) {
    const f = path.join(__dirname, 'fixtures', other);
    if (!fs.existsSync(f)) continue;
    let days = [];
    try { days = await mod.parseAll(f, ctx); } catch (e) { days = []; }
    expect(days.filter((d) => d.dailyRows.length > 0)).toEqual([]);
  }
}, 120000);

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'heji.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('禾吉土木包工業');
});
