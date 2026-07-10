/**
 * parser-jinda.test.js — 金大(sample-jinda)施工日誌 PDF 讀取器測試
 *
 * 對 tests/fixtures/jinda.pdf(金大竹崎第二聯估驗表,80 頁每頁 1 天)跑
 * parse / parseAll,斷言「來源事實」的具體數值。金額/數量若解析錯,
 * 這些斷言就會失敗(Rule 9:測試驗證意圖)。
 */
const path = require('path');
const jinda = require('../server/parsers/vendors/samples/jinda.pmisparser.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'jinda.pdf');

describe('sample-jinda 讀取器 meta / 結構驗證', () => {
  test('meta 完整:vendorKey / version / targetFields', () => {
    expect(jinda.meta.vendorKey).toBe('sample-jinda');
    expect(typeof jinda.meta.version).toBe('string');
    expect(Array.isArray(jinda.meta.targetFields)).toBe(true);
    expect(jinda.meta.targetFields).toEqual(
      expect.arrayContaining(['項次', '工程項目', '單位', '本日完成金額'])
    );
  });

  test('selfTest 回 truthy(內建小樣本自我驗證)', () => {
    expect(typeof jinda.selfTest).toBe('function');
    expect(jinda.selfTest()).toBeTruthy();
  });
});

describe('sample-jinda parse(第一天/第一頁)', () => {
  let out;
  beforeAll(async () => {
    out = await jinda.parse(FIXTURE);
  });

  test('header:工程名稱 / 填報日期(民國115→西元2026-04-08) / 星期', () => {
    expect(out.header.工程名稱).toBe('嘉義縣立竹崎高中教育部補助圍牆重建工程');
    expect(out.header.填報日期).toBe('2026-04-08');
    expect(out.header.星期).toBe('星期三');
  });

  test('header:金大第二聯無進度%/出工 → 留 null', () => {
    expect(out.header.預定進度).toBeNull();
    expect(out.header.實際進度).toBeNull();
    expect(out.header.出工總人數).toBeNull();
  });

  test('extras 為空物件(第二聯無出工/材料/機具明細)', () => {
    expect(out.extras).toEqual({});
  });

  test('項次1 工程告示牌(租用) 各欄數字精確', () => {
    const r1 = out.dailyRows.find(r => r.項次 === '1');
    expect(r1).toBeTruthy();
    expect(r1.工程項目).toBe('工程告示牌(租用)');
    expect(r1.單位).toBe('面');
    expect(r1.契約單價).toBe(2250);
    expect(r1.契約數量).toBe(1.0);
    expect(r1.本日完成數量).toBe(1.0);
    expect(r1.本日完成金額).toBe(2250.0);
    expect(r1.累計完成數量).toBe(1.0);
  });

  test('項次3 三角錐連桿:本日完成「-」→ null(無資料語意)', () => {
    const r3 = out.dailyRows.find(r => r.項次 === '3');
    expect(r3).toBeTruthy();
    expect(r3.工程項目).toBe('三角錐連桿(租用)');
    expect(r3.單位).toBe('M');
    expect(r3.契約單價).toBe(135);
    expect(r3.契約數量).toBe(72.0);
    // 「-」統一解析為 null(明確語意:無資料,非 0)
    expect(r3.本日完成數量).toBeNull();
    expect(r3.本日完成金額).toBeNull();
    expect(r3.累計完成數量).toBeNull();
  });

  test('中文大寫類別列(壹/貳…陸)可解析,伍(營造綜合保險費)金額正確', () => {
    // 壹 為純類別列(僅名稱,無數字)→ 仍收錄,數字欄為 null
    const rB = out.dailyRows.find(r => r.項次 === '壹');
    expect(rB).toBeTruthy();
    expect(rB.工程項目).toBe('直接工程費');
    expect(rB.本日完成金額).toBeNull();

    // 伍:營造綜合保險費 式 5,000 1.0 1.0 5000.0 1.0
    const rWu = out.dailyRows.find(r => r.項次 === '伍');
    expect(rWu).toBeTruthy();
    expect(rWu.工程項目).toBe('營造綜合保險費');
    expect(rWu.單位).toBe('式');
    expect(rWu.契約單價).toBe(5000);
    expect(rWu.本日完成金額).toBe(5000.0);
  });

  test('多行工程項目名稱正確重組(項次6:換行拆散的長名稱)', () => {
    const r6 = out.dailyRows.find(r => r.項次 === '6');
    expect(r6).toBeTruthy();
    expect(r6.單位).toBe('M');
    expect(r6.契約單價).toBe(450);
    expect(r6.契約數量).toBe(99.0);
    // 名稱是多行合併,至少包含首尾關鍵字
    expect(r6.工程項目).toContain('拆除搬運集中既有金屬');
    expect(r6.工程項目).toContain('指定位置');
  });

  test('當日累計(本日完成金額)= 10400.248', () => {
    expect(out.header.本日累計金額).toBe(10400.248);
  });
});

describe('sample-jinda parseAll(逐日彙總)', () => {
  let all;
  beforeAll(async () => {
    all = await jinda.parseAll(FIXTURE);
  });

  test('80 頁 → 80 天', () => {
    expect(all).toHaveLength(80);
  });

  test('第一天 = 2026-04-08,第二天 = 2026-04-09', () => {
    expect(all[0].header.填報日期).toBe('2026-04-08');
    expect(all[1].header.填報日期).toBe('2026-04-09');
  });

  test('第二天(04-09)項次3 有本日完成:數量72、金額9720', () => {
    const r3 = all[1].dailyRows.find(r => r.項次 === '3');
    expect(r3.本日完成數量).toBe(72.0);
    expect(r3.本日完成金額).toBe(9720.0);
  });

  test('每天工程名稱一致', () => {
    for (const day of all) {
      expect(day.header.工程名稱).toBe('嘉義縣立竹崎高中教育部補助圍牆重建工程');
    }
  });
});
