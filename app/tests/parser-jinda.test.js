/**
 * parser-jinda.test.js — 金大(sample-jinda)施工日誌 PDF 讀取器測試
 *
 * 對 tests/fixtures/jinda.pdf(金大竹崎第二聯估驗表,80 頁每頁 1 天)跑
 * parse / parseAll,斷言「來源事實」的具體數值。金額/數量若解析錯,
 * 這些斷言就會失敗(Rule 9:測試驗證意圖)。
 */
const path = require('path');
const jinda = require('../server/parsers/vendors/samples/jinda.pmisparser.js');

// 檔型工具注入:讀取器不自己 require 檔型檔,由呼叫端(此處測試 / 正式為 registry)
// 以 ctx.filetypes 注入。此測試直接帶入 filetypes 的 exports。
const ctx = { filetypes: require('../server/parsers/filetypes') };

const FIXTURE = path.join(__dirname, 'fixtures', 'jinda.pdf');

describe('sample-jinda 讀取器 meta / 結構驗證', () => {
  test('meta 完整:vendorKey / version / targetFields', () => {
    expect(jinda.meta.vendorKey).toBe('金大營造有限公司');
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
    out = await jinda.parse(FIXTURE, ctx);
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
  // 項目名稱裡的工程縮寫被當成單位:`7 整地,新設 RC 基礎板 M 1,049 124.0` 的 RC
  // 命中了舊的樣式判定 /^[A-Z]+\d*$/,於是名稱被截成「整地,新設」、單位變 RC、
  // 真正的 M 1,049 124.0 全部錯位成 null——而且沒有任何錯誤訊息。
  // 17 列裡有 2 列如此,舊測試因為只抽驗特定項次而全綠。
  test('項次7 名稱含 RC 縮寫時,單位與數字欄仍正確', () => {
    const r7 = out.dailyRows.find((r) => r.項次 === '7');
    // 名稱 token 一律以空字串接合(讀取器既有行為,其他項目的斷言也依此)。
  // 與契約表比對時兩邊都會去空白(kickoff/E3 的 squash),故不影響下游。
  expect(r7.工程項目).toBe('整地,新設RC基礎板');
    expect(r7.單位).toBe('M');
    expect(r7.契約單價).toBe(1049);
    expect(r7.契約數量).toBe(124);
  });

  test('項次8 同樣的形態', () => {
    const r8 = out.dailyRows.find((r) => r.項次 === '8');
    expect(r8.工程項目).toBe('新建圍網RC矮牆基座');
    expect(r8.單位).toBe('M');
    expect(r8.契約單價).toBe(3280);
    expect(r8.契約數量).toBe(124);
  });

  // 沒有這條,任何一列解析失敗都只會靜默變 null。抽驗特定項次擋不住這種缺陷。
  test('每一個非大類列都解析得出單位與契約數量單價', () => {
    const 缺 = out.dailyRows
      .filter((r) => !(r.單位 == null && r.契約數量 == null && r.契約單價 == null))
      .filter((r) => r.單位 == null || r.契約數量 == null || r.契約單價 == null)
      .map((r) => `${r.項次} ${r.工程項目}`);
    expect(缺).toEqual([]);
  });
});

// 廠商只填一欄、其餘欄連「-」都沒印時,靠 token 順序推欄位會把值掛到第一個數值欄。
// 2026-06-04 項次8 實測:該列只印了一個 62.0,座標落在累計完成數量欄(464.1–518.1),
// 本日完成數量欄(344.3–398.3)整格是空的——但舊解析把它讀成本日完成數量,再由
// SP3 的 A8 生出「本日有施工但金額讀不到」這個假硬錯,看起來像廠商漏填金額。
// 判準是右端對齊:該列的數值 item 右端 525.8 與同頁所有正常列一致,62.0 的字元位置
// 與正常列的累計值(如項次7 的 124.0)重疊。
describe('sample-jinda 只填一欄的列必須依座標歸位', () => {
  let day;
  beforeAll(async () => {
    const all = await jinda.parseAll(FIXTURE, ctx);
    day = all.find((d) => d.header.填報日期 === '2026-06-04');
  });

  test('2026-06-04 存在於樣本中', () => {
    expect(day).toBeTruthy();
  });

  test('項次8:62.0 是累計完成數量,不是本日完成數量', () => {
    const r8 = day.dailyRows.find((r) => r.項次 === '8');
    expect(r8).toBeTruthy();
    expect(r8.累計完成數量).toBe(62.0);
    expect(r8.本日完成數量).toBeNull();
    expect(r8.本日完成金額).toBeNull();
  });

  test('同頁正常列(項次7)不受影響:本日兩欄為 null、累計 124', () => {
    const r7 = day.dailyRows.find((r) => r.項次 === '7');
    expect(r7.本日完成數量).toBeNull();
    expect(r7.本日完成金額).toBeNull();
    expect(r7.累計完成數量).toBe(124.0);
  });
});

describe('sample-jinda parseAll(逐日彙總)', () => {
  let all;
  beforeAll(async () => {
    all = await jinda.parseAll(FIXTURE, ctx);
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
