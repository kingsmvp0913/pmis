/**
 * parser-jinlin.test.js — 晉林土木包工業(南陽國小)監造施工日報表 Excel 讀取器測試
 *
 * 對 tests/fixtures/jinlin.xls(晉林南陽國小監造施工日報表,11 sheet、so 235 欄矩陣、
 * 監工/施工日報 snapshot 含 #REF!/#VALUE!)跑 parse / parseAll,斷言「來源事實」的具體數值。
 *
 * 逐日資料來自零 error 的 `so` 矩陣;金額/數量/單位/日期若解析錯,以下斷言即失敗(Rule 9)。
 * 斷言的每個值都是人可回檔核對的真值(工程名稱、某日日期、某項目數量×單價=金額)。
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
// registry 於載入時依 PMIS_DATA_DIR 決定 PARSER_DIR;安裝路徑測試用暫存目錄,須在 require registry 前設定。
process.env.PMIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-jinlin-'));
const registry = require('../server/parsers/registry');
const jinlin = require('../server/parsers/vendors/samples/jinlin.pmisparser.js');

const filetypes = require('../server/parsers/filetypes');
const ctx = { filetypes };

const FIXTURE = path.join(__dirname, 'fixtures', 'jinlin.xls');

describe('晉林 讀取器 meta / selfTest', () => {
  test('meta 完整:vendorKey / version / targetFields', () => {
    expect(jinlin.meta.vendorKey).toBe('晉林土木包工業');
    expect(typeof jinlin.meta.version).toBe('string');
    expect(Array.isArray(jinlin.meta.targetFields)).toBe(true);
    expect(jinlin.meta.targetFields).toEqual(
      expect.arrayContaining([
        '工程名稱', '填報日期', '項次', '工程項目', '單位',
        '契約單價', '契約數量', '本日完成數量', '本日完成金額', '累計完成數量',
      ])
    );
  });

  test('selfTest 回 truthy(內建小樣本 so + 監造表頭 grid 自檢)', () => {
    expect(typeof jinlin.selfTest).toBe('function');
    expect(jinlin.selfTest(filetypes)).toBeTruthy();
  });
});

describe('晉林 parse(第一實日 = 2026-03-18 開工日)', () => {
  let out;
  beforeAll(async () => {
    out = await jinlin.parse(FIXTURE, ctx);
  });

  test('header:工程名稱(取自監造表頭,去「工程名稱:」前綴)', () => {
    expect(out.header.工程名稱).toBe('114年南陽國小北棟教室廁所整修工程');
  });

  test('header:填報日期(so A 欄 Excel 序號 46099 → 西元 2026-03-18)、星期三', () => {
    expect(out.header.填報日期).toBe('2026-03-18');
    // so B 欄星期 code 4 → 週三(2026-03-18 確為星期三)
    expect(out.header.星期).toBe('三');
  });

  test('header:天氣(上/下午)、預定/實際進度(so 逐日,非 snapshot 髒值)', () => {
    expect(out.header.天氣_上午).toBe('晴');
    expect(out.header.天氣_下午).toBe('晴');
    // 本日百分比(H)=實際進度 0.73;預定百分比(I)=0.75(保留原值,不硬乘 100)
    expect(out.header.實際進度).toBeCloseTo(0.73, 5);
    expect(out.header.預定進度).toBeCloseTo(0.75, 5);
  });

  test('header:出工總人數 → null(so 分工別、無單一總數格,不加總編造)', () => {
    expect(out.header.出工總人數).toBeNull();
  });

  test('header:本日累計金額 = 金額合計(IA)累計列 = 22766.24(開工首日)', () => {
    expect(out.header.本日累計金額).toBeCloseTo(22766.24, 2);
  });

  test('dailyRows = 37(大項「壹 直接工程費」+ 36 細項/管理費/稅)', () => {
    expect(out.dailyRows).toHaveLength(37);
  });

  test('大項表頭「壹 直接工程費」:僅名稱,各數值欄 null(不編造)', () => {
    const r壹 = out.dailyRows.find((r) => r.項次 === '壹');
    expect(r壹).toBeTruthy();
    expect(r壹.工程項目).toBe('直接工程費');
    expect(r壹.單位).toBeNull();
    expect(r壹.契約單價).toBeNull();
    expect(r壹.契約數量).toBeNull();
    expect(r壹.本日完成金額).toBeNull();
    expect(r壹.累計完成數量).toBeNull();
  });

  test('項次1(乙種施工圍籬):契約單價5000/數量1;本日完成 數量1/金額5000', () => {
    const r1 = out.dailyRows.find((r) => r.項次 === '1');
    expect(r1).toBeTruthy();
    expect(r1.工程項目).toContain('乙種施工圍籬');
    expect(r1.單位).toBe('式');
    expect(r1.契約單價).toBe(5000);
    expect(r1.契約數量).toBe(1);
    // 開工首日圍籬完成:block1 數量1、block2 金額5000
    expect(r1.本日完成數量).toBe(1);
    expect(r1.本日完成金額).toBe(5000);
    expect(r1.累計完成數量).toBe(1);
  });

  test('項次7(砌1/2B磚牆):單位M2、契約數量38、單價1500(so 表頭 = 預算標單)', () => {
    const r7 = out.dailyRows.find((r) => r.項次 === '7');
    expect(r7).toBeTruthy();
    expect(r7.工程項目).toContain('砌1/2B磚牆');
    expect(r7.單位).toBe('M2');
    expect(r7.契約數量).toBe(38);
    expect(r7.契約單價).toBe(1500);
  });

  test('extras:出工明細(開工日一般工 2 人)', () => {
    expect(out.extras.出工明細).toEqual([{ 工別: '一般工', 人數: 2 }]);
  });
});

describe('晉林 parseAll(逐日彙總,只回實日;排除範本預生成空白日)', () => {
  let all;
  beforeAll(async () => {
    all = await jinlin.parseAll(FIXTURE, ctx);
  });

  test('105 個實日(有天氣);2026-03-18 開工 ~ 2026-06-30;之後空白佔位日被排除', () => {
    expect(all).toHaveLength(105);
    expect(all[0].header.填報日期).toBe('2026-03-18');
    expect(all[all.length - 1].header.填報日期).toBe('2026-06-30');
  });

  test('每實日工程名稱一致、dailyRows 皆 37 列、首列皆大項「壹」', () => {
    for (const day of all) {
      expect(day.header.工程名稱).toBe('114年南陽國小北棟教室廁所整修工程');
      expect(day.dailyRows).toHaveLength(37);
      expect(day.dailyRows[0].項次).toBe('壹');
    }
  });

  test('矩陣展開正確:2026-06-16 牆面貼石英磚 本日35/金額59500(=35×1700)/累計55', () => {
    const day = all.find((d) => d.header.填報日期 === '2026-06-16');
    expect(day).toBeTruthy();
    const wall = day.dailyRows.find((r) => r.工程項目.startsWith('牆面貼石英磚'));
    expect(wall).toBeTruthy();
    expect(wall.單位).toBe('M2');
    expect(wall.契約單價).toBe(1700);
    // 本日完成:block1 數量 35、block2 金額 59500(數量×單價自洽)
    expect(wall.本日完成數量).toBe(35);
    expect(wall.本日完成金額).toBe(59500);
    expect(wall.本日完成數量 * wall.契約單價).toBe(wall.本日完成金額);
    // 累計:前一實日(06-15)本日 20 + 本日 35 = 累計 55
    expect(wall.累計完成數量).toBe(55);
  });

  test('本日累計金額(金額合計 IA)逐日遞增(6/16 > 6/15)', () => {
    const d15 = all.find((d) => d.header.填報日期 === '2026-06-15');
    const d16 = all.find((d) => d.header.填報日期 === '2026-06-16');
    expect(d16.header.本日累計金額).toBeGreaterThan(d15.header.本日累計金額);
    expect(d16.header.本日累計金額).toBeCloseTo(1548739.557, 2);
  });
});

describe('晉林 registry 安裝路徑(回歸:selfTest 不得依賴 data/ 目錄的 node_modules)', () => {
  test('registry.install 走完整安裝路徑 → ok:true(過去因 selfTest require xlsx 而失敗)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'jinlin.pmisparser.js')
    );
    const r = registry.install(src, '晉林土木包工業');
    expect(r.ok).toBe(true);
    expect(r.status && r.status.installed).toBe(true);
  });
});
