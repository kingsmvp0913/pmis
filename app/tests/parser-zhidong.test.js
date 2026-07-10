/**
 * parser-zhidong.test.js — 摯東(sample-zhidong)施工日誌 Excel 讀取器測試
 *
 * 對 tests/fixtures/zhidong.xls(摯東大勇國小 115.06,32 sheet:簽章表 + (1)…(31))跑
 * parse / parseAll,斷言「來源事實」的具體數值。金額/數量/單位若解析錯,這些斷言就會
 * 失敗(Rule 9:測試驗證意圖)。
 */
const path = require('path');
const zhidong = require('../server/parsers/vendors/samples/zhidong.pmisparser.js');

// 檔型工具注入:讀取器不自己 require 檔型檔,由呼叫端(此處測試 / 正式為 registry)
// 以 ctx.filetypes 注入。parse/parseAll 帶 ctx;Excel selfTest 需檔型工具建 grid,直接帶 filetypes。
const filetypes = require('../server/parsers/filetypes');
const ctx = { filetypes };

const FIXTURE = path.join(__dirname, 'fixtures', 'zhidong.xls');

describe('sample-zhidong 讀取器 meta / 結構驗證', () => {
  test('meta 完整:vendorKey / version / targetFields', () => {
    expect(zhidong.meta.vendorKey).toBe('摯東營造有限公司');
    expect(typeof zhidong.meta.version).toBe('string');
    expect(Array.isArray(zhidong.meta.targetFields)).toBe(true);
    expect(zhidong.meta.targetFields).toEqual(
      expect.arrayContaining(['項次', '工程項目', '單位', '契約數量', '本日完成數量'])
    );
  });

  test('selfTest 回 truthy(內建小樣本 grid 自我驗證)', () => {
    expect(typeof zhidong.selfTest).toBe('function');
    expect(zhidong.selfTest(filetypes)).toBeTruthy();
  });
});

describe('sample-zhidong parse(第一天 = sheet (1))', () => {
  let out;
  beforeAll(async () => {
    out = await zhidong.parse(FIXTURE, ctx);
  });

  test('header:工程名稱 / 填報日期(Excel 序號→西元 2026-06-01)', () => {
    expect(out.header.工程名稱).toBe('114學年度南棟教室西側廁所整修工程');
    expect(out.header.填報日期).toBe('2026-06-01');
  });

  test('header:天氣上午/下午、預定/實際進度(小數)', () => {
    expect(out.header.天氣_上午).toBe('晴');
    expect(out.header.天氣_下午).toBe('晴');
    // F7/Q7 為小數(0.477 = 47.7%);保留原數值,不硬乘 100。
    expect(out.header.預定進度).toBeCloseTo(0.477, 5);
    expect(out.header.實際進度).toBeCloseTo(0.4771, 5);
  });

  test('header:摯東無星期欄 / 無單一當日累計金額格 → null(不編造)', () => {
    expect(out.header.星期).toBeNull();
    expect(out.header.本日累計金額).toBeNull();
    expect(out.header.出工總人數).toBeNull();
  });

  test('估驗列數 = 34(大項壹 + 細項1–28 + 貳參肆伍陸)', () => {
    expect(out.dailyRows).toHaveLength(34);
  });

  test('大項「壹 直接工程費」:僅名稱,無單位/數字 → 各數值欄 null', () => {
    const r壹 = out.dailyRows.find((r) => r.項次 === '壹');
    expect(r壹).toBeTruthy();
    expect(r壹.工程項目).toBe('直接工程費');
    expect(r壹.單位).toBeNull();
    expect(r壹.契約數量).toBeNull();
    expect(r壹.本日完成金額).toBeNull();
  });

  test('項次1:契約單價/契約數量精確;本日完成(N 空)→ null', () => {
    const r1 = out.dailyRows.find((r) => r.項次 === '1');
    expect(r1).toBeTruthy();
    expect(r1.工程項目).toContain('工程告示牌');
    expect(r1.單位).toBe('式');
    expect(r1.契約單價).toBe(14381);
    expect(r1.契約數量).toBe(1);
    // 本日完成數量 N 欄空 → null(語意:今日該項無進度,非 0)
    expect(r1.本日完成數量).toBeNull();
    // 摯東估驗表無「本日完成金額」欄 → 一律 null(找不到不編造)
    expect(r1.本日完成金額).toBeNull();
    expect(r1.累計完成數量).toBe(1);
  });

  test('項次12(牆面貼石英磚):本日完成 5 / 累計 75 / 單價 1378(合併格取值正確)', () => {
    const r12 = out.dailyRows.find((r) => r.項次 === '12');
    expect(r12).toBeTruthy();
    expect(r12.工程項目).toContain('牆面貼石英磚');
    expect(r12.單位).toBe('M2');
    expect(r12.契約數量).toBe(599);
    expect(r12.本日完成數量).toBe(5);   // N 欄(合併 N:P),真值 5
    expect(r12.累計完成數量).toBe(75);  // Q 欄(合併 Q:S),真值 75
    expect(r12.契約單價).toBe(1378);    // Y 欄
    expect(r12.本日完成金額).toBeNull(); // 無此欄
  });

  test('中文大寫管理費列「陸 營業稅」單價/累計正確', () => {
    const r陸 = out.dailyRows.find((r) => r.項次 === '陸');
    expect(r陸).toBeTruthy();
    expect(r陸.工程項目).toContain('營業稅');
    expect(r陸.單位).toBe('式');
    expect(r陸.契約單價).toBe(300905);
    expect(r陸.累計完成數量).toBeCloseTo(0.37, 5);
  });

  test('估驗於「營造業專業工程特定施工項目」錨點前結束(最後一列為 陸)', () => {
    const last = out.dailyRows[out.dailyRows.length - 1];
    expect(last.項次).toBe('陸');
    // 錨點列與其後段落標題不得混入資料
    expect(out.dailyRows.some((r) => r.工程項目 === '營造業專業工程特定施工項目')).toBe(false);
  });

  test('extras:出工明細(大工本日4/小工1/監工1)、機具三台', () => {
    expect(out.extras.出工明細).toEqual([
      { 工別: '大工', 人數: 4 },
      { 工別: '小工', 人數: 1 },
      { 工別: '監工', 人數: 1 },
    ]);
    expect(out.extras.主要機具.map((m) => m.名稱)).toEqual(['挖土機', '卡車', '吊車']);
  });
});

describe('sample-zhidong parseAll(逐日彙總)', () => {
  let all;
  beforeAll(async () => {
    all = await zhidong.parseAll(FIXTURE, ctx);
  });

  test('31 個日 sheet → 31 天(簽章表被排除)', () => {
    expect(all).toHaveLength(31);
  });

  test('依序:第 1 天=2026-06-01,第 31 天=2026-07-01(跨月末日)', () => {
    expect(all[0].header.填報日期).toBe('2026-06-01');
    expect(all[30].header.填報日期).toBe('2026-07-01');
  });

  test('每天工程名稱一致', () => {
    for (const day of all) {
      expect(day.header.工程名稱).toBe('114學年度南棟教室西側廁所整修工程');
    }
  });

  test('每天估驗列首列皆為大項「壹」,且有 34 列', () => {
    for (const day of all) {
      expect(day.dailyRows[0].項次).toBe('壹');
      expect(day.dailyRows).toHaveLength(34);
    }
  });
});
