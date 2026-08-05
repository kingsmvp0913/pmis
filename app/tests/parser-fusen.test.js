/**
 * 富森土木包工業(四湖國小)讀取器測試。
 * 對 tests/fixtures/fusen.pdf(244 頁 = 前 6 頁基本資料/附表 + 238 個日誌頁 = 119 天)跑。
 */
const path = require('path');
const mod = require('../server/parsers/vendors/samples/fusen.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'fusen.pdf');
const ctx = { filetypes };

test('selfTest 以內建座標樣本通過,不需注入', () => {
  expect(mod.selfTest()).toBe(true);
});

describe('fusen 名稱片段歸屬(純函式)', () => {
  const { collectRows } = mod._internal;
  const mk = (y, arr) => ({ y, items: arr.map(([x, s]) => ({ x, y, s })) });

  // 名稱過長時,片段可能在項次列的上一列**與**下一列。歸屬看的是「這一列自己的
  // 名稱欄有沒有值」:空的代表名稱被擠到上一列。只往一邊接會拼出別人的名稱。
  test('名稱欄為空時,上一列的片段屬於本列', () => {
    const out = collectRows([
      mk(290, [[60, '壹'], [81, '直接工程費']]),
      mk(280, [[81, '乙種施工圍籬、警示帶']]),
      mk(270, [[62, '1'], [243, '式'], [294, '1.00']]),
      mk(260, [[81, '安全措施(租用)']]),
      mk(250, [[62, '2'], [81, '工程告示牌'], [243, '式']]),
    ]);
    expect(out.find((r) => r.項次 === '壹').工程項目).toBe('直接工程費');
    expect(out.find((r) => r.項次 === '1').工程項目).toBe('乙種施工圍籬、警示帶安全措施(租用)');
    expect(out.find((r) => r.項次 === '2').工程項目).toBe('工程告示牌');
  });

  // 此格式的明細只有 6 欄,沒有契約單價與本日完成金額——留 null 不硬湊,
  // SP3 會據此把 B3/B4/C2 列入 skipped 並說明,而不是靜默當作通過
  test('契約單價與本日完成金額此格式不提供', () => {
    const out = collectRows([mk(270, [[62, '1'], [81, 'A'], [243, '式'], [294, '1.00']])]);
    expect(out[0].契約單價).toBeNull();
    expect(out[0].本日完成金額).toBeNull();
  });
});

describe('fusen parseAll', () => {
  let all;
  beforeAll(async () => { all = await mod.parseAll(FIXTURE, ctx); });

  // 一天的明細放不下會續到下一頁,兩頁的填報日期相同。不合併的話每天都被當成
  // 兩天(D1「同一天出現兩次」119 次),而且每頁各自只有一半的項目。
  test('238 個日誌頁合併成 119 天', () => {
    expect(all).toHaveLength(119);
  });

  test('前 6 頁的基本資料與附表不算日誌頁', () => {
    expect(all.every((d) => d.header.填報日期 != null)).toBe(true);
  });

  test('header 取自日誌頁頂端', () => {
    expect(all[0].header).toMatchObject({
      工程名稱: '四湖國小永慶教學大樓廁所整修工程',
      承包廠商: '富森土木包工業',
      星期: '星期四', 天氣_上午: '晴', 天氣_下午: '晴',
      開工日期: '2025-04-23',
    });
  });

  // 首日文件上印的是「2026年4月23日」而開工日是 2025/4/23——年份是廠商打錯。
  // 讀取器如實照抄,由 SP3 的 D3(日期落在工期外)抓出來,不在讀取器裡猜著修。
  test('日期照文件原樣解析,不自行修正廠商打錯的年份', () => {
    expect(all[0].header.填報日期).toBe('2026-04-23');
  });

  // 廠商只列有施工的項目並逐天重新編號:同一個「砌1/2B磚牆」在 4/23 是項次 7、
  // 在 8/12 是項次 6。這是廠商的填表方式,讀取器照實反映,由 E4/E5 抓出來。
  test('項次編號各天不同時照實反映,不自行對齊', () => {
    const d1 = all.find((d) => d.header.填報日期 === '2026-04-23');
    const d2 = all.find((d) => d.header.填報日期 === '2025-08-12');
    expect(d1.dailyRows.find((r) => r.項次 === '7').工程項目).toMatch(/^砌1\/2B磚牆/);
    expect(d2.dailyRows.find((r) => r.項次 === '6').工程項目).toMatch(/^砌1\/2B磚牆/);
  });

  test('每一個非大類列都解析得出單位與契約數量', () => {
    const 缺 = [];
    for (const d of all) {
      for (const r of d.dailyRows) {
        if (r.單位 == null && r.契約數量 == null) continue;   // 大類列
        if (r.單位 == null || r.契約數量 == null) 缺.push(`${d.header.填報日期} ${r.項次}`);
      }
    }
    expect(缺).toEqual([]);
  });
});
