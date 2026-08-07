/**
 * 經緯營造(龍井國小新建綜合球場)施工日誌讀取器測試。
 *
 * fixture 是 14 份累積式日報裡較小的一份(「龍井5月施工日報表.xls」,95 天)。
 * ⚠️ 這個工程從開工(2025-02-26)到 2025 年底**整段沒有實際施工**——
 * 14 份檔案裡最早出現「本日完成數量」的是 115 年 1 月份那份。
 * 所以 fixture 驗得到的是 header／明細骨架／累計欄;「本日完成數量必須從
 * 欄 10~12 往右掃」這條由 selfTest 以真實座標驗(見那裡的說明)。
 */
const path = require('path');
const mod = require('../server/parsers/vendors/samples/jingwei.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'jingwei.xls');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest(filetypes)).toBe(true);
});

// vendorKey 的權威來源是**決標公告的得標廠商**,不是樣本檔、更不是命名慣例
// (玉森靠慣例推定而猜錯,71 份日誌閒置了一整輪且沒有任何錯誤訊息)。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('經緯營造股份有限公司');
});

describe('parseAll(龍井球場)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 120000);

  test('一天一區塊,日期由民國年/月/日三個獨立的格組出來', () => {
    expect(days.length).toBe(95);
    expect(days[0].header.填報日期).toBe('2025-02-26');
    expect(days[days.length - 1].header.填報日期).toBe('2025-05-31');
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('新建綜合球場工程');
    expect(h.承包廠商).toBe('經緯營造股份有限公司');
    expect(h.開工日期).toBe('2025-02-26');
    // 天氣的標籤與值黏在同一格(「本日天氣：上午：晴」/「下午：晴」)
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    expect(h.預定進度).toBe(0.00391);
    expect(h.星期).toBeNull();
  });

  // 此格式沒有項次欄,以「排除大類後的出現序」補(位置事實,不是推導數值)。
  test('項次以出現序補,15 項', () => {
    const nos = days[0].dailyRows.map((r) => r.項次);
    expect(nos).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15']);
  });

  // 表頭的「契約數量」橫跨欄 7~9,但每一列的合併範圍不一樣——某些列欄 8 是單位
  // 字串跨進來的。只認合併起點欄會在那些列讀到字串、numOf 變 null,
  // 看起來就像廠商漏填。
  test('契約數量往右掃到第一個數字,不會因合併範圍不同而漏', () => {
    const rows = days[0].dailyRows;
    expect(rows[0]).toMatchObject({ 工程項目: '工程告示牌(租用)', 單位: '面', 契約數量: 1 });
    expect(rows[2]).toMatchObject({ 工程項目: '施工圍籬(租用)', 單位: 'M', 契約數量: 104 });
    expect(rows[5]).toMatchObject({ 工程項目: '挖除清運既有連鎖磚與襯墊砂', 單位: 'M2', 契約數量: 1056 });
    for (const r of rows) expect(r.契約數量).not.toBeNull();
  });

  test('此格式沒有單價與金額,一律 null 不由別處回推', () => {
    for (const r of days[0].dailyRows) {
      expect(r.契約單價).toBeNull();
      expect(r.本日完成金額).toBeNull();
    }
    expect(days[0].header.本日累計金額).toBeNull();
  });

  // 這不是讀取器讀不到,是這段期間真的沒動工:14 份檔案裡最早出現本日完成量的
  // 是 115 年 1 月份那份。釘住這件事,免得下次有人以為讀取器壞了。
  test('這 95 天來源本身就沒有任何本日完成量(工程停工)', () => {
    const 有施工 = days.filter((d) => d.dailyRows.some((r) => r.本日完成數量));
    expect(有施工.length).toBe(0);
    expect(days[0].dailyRows[0].累計完成數量).toBe(0);
  });
});

test('讀不動的檔要明確失敗,不可回空陣列', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'xianghe.xls'), ctx))
    .rejects.toThrow(/本日天氣/);
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const fs = require('fs');
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'jingwei.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('經緯營造股份有限公司');
});
