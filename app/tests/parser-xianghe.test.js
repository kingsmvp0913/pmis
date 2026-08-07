/**
 * 祥賀營造(嘉興國小)施工日誌讀取器測試。
 * fixture 是同一批裡最小的一份(`嘉興國小-施工日誌-修.xls`,1 天),
 * 完整的 240 天版本 8.3MB 不進 repo——關卡 b/c 用外部樣本跑。
 */
const path = require('path');
const mod = require('../server/parsers/vendors/samples/xianghe.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'xianghe.xls');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest(filetypes)).toBe(true);
});

// vendorKey 的權威來源是**決標公告的得標廠商**,不是樣本檔、更不是命名慣例。
// 玉森就是靠慣例推定而猜錯,讀取器完全讀得動卻永遠叫不出來(org-match 逐字相等),
// 71 份日誌閒置了一整輪,而且沒有任何錯誤訊息。這裡兩邊一致:嘉興案的決標公告
// 得標廠商 = 日誌 r0+2 欄 13 載明的承攬廠商 = 祥賀營造有限公司。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('祥賀營造有限公司');
});

describe('parse(第一天)', () => {
  let out;
  beforeAll(async () => { out = await mod.parse(FIXTURE, ctx); });

  test('工程名稱與天氣', () => {
    expect(out.header.工程名稱).toBe('113年鋪面與排水改善工程');
    expect(out.header.天氣_上午).toBe('晴');
    expect(out.header.天氣_下午).toBe('晴');
  });

  // 日期在儲存格裡是 Excel 序號 45663,當字串 regex 會整份抓不到
  test('填報日期由序號轉出', () => {
    expect(out.header.填報日期).toBe('2025-01-06');
  });

  // r0+60 欄 24 的標籤寫「每日施工金額累計」但值其實是**當日**金額
  // (01-06=52677、01-07=15107 遞減,且兩者相加 = 第 2 天的各項累計總和)。
  // 當累計填進去的話 SP3 的 B4 會每天硬錯——實測 239 項。來源沒有累計就是 null,
  // 不自行累加。這條測試釘住「不要因為標籤看起來對就收下來」。
  test('本日累計金額為 null(來源只有當日金額,不推導)', () => {
    expect(out.header.本日累計金額).toBeNull();
  });

  test('此格式不提供星期與出工總人數,回 null 不硬湊', () => {
    expect(out.header.星期).toBeNull();
    expect(out.header.出工總人數).toBeNull();
  });

  // 明細是**左右兩組並排**的。只讀左組會少掉一半項目,而少掉的那些不會讓任何
  // 欄位變 null——完整性關卡完全看不到,只有斷言項目數與右組的具體值才抓得到。
  test('左右兩組都讀到', () => {
    expect(out.dailyRows.length).toBe(27);
    const 右組項目 = out.dailyRows.map((r) => r.工程項目);
    expect(右組項目).toContain('施工圍籬(租用)');       // 左組
    expect(右組項目).toContain('新設緣石');             // 右組
  });

  // 單價/金額在欄 20~26,位置看起來像「表格外的計算區」,取錯就整排是 null。
  // 這裡驗的是來源具體值 + 兩種算法交叉核對(單價×數量=複價、本日量×單價=本日金額)。
  test('契約單價與本日完成金額取自欄 20/22,且與數量自洽', () => {
    const r = out.dailyRows.find((x) => x.工程項目 === '施工圍籬(租用)');
    expect(r.單位).toBe('M');
    expect(r.契約單價).toBe(450);
    expect(r.契約數量).toBe(137);
    expect(r.本日完成數量).toBe(40);
    expect(r.本日完成金額).toBe(18000);        // 40 × 450
    expect(r.累計完成數量).toBe(40);
  });

  test('右組的單價與金額取自欄 24/26', () => {
    const r = out.dailyRows.find((x) => x.工程項目 === '新設RC地坪');
    expect(r.單位).toBe('M2');
    expect(r.契約單價).toBe(1600);
    expect(r.契約數量).toBe(499);
  });
});

describe('parseAll', () => {
  test('fixture 只有 1 天', async () => {
    const days = await mod.parseAll(FIXTURE, ctx);
    expect(days.length).toBe(1);
    expect(days[0].header.填報日期).toBe('2025-01-06');
  });
});

// 天區塊靠「報表編號」偵測,不寫死間距 83——間距是觀察值不是保證。
test('blockStarts 以「報表編號」定位,不靠固定間距', () => {
  const grid = [];
  grid[0] = [null, '報表編號'];
  grid[5] = [null, '別的'];
  grid[9] = [null, '報表編號'];
  expect(mod.blockStarts(grid)).toEqual([0, 9]);
});

// 無資料標記要變 null,不是 0——0 是「有填但為零」,語意不同。
test('「-」與空白轉 null,不當成 0', () => {
  const grid = [];
  const set = (r, c, v) => { (grid[r] = grid[r] || [])[c] = v; };
  set(0, 1, '報表編號');
  set(1, 13, 45663);
  set(14, 1, '1'); set(14, 2, '某項目'); set(14, 4, '式');
  set(14, 5, '-'); set(14, 7, ''); set(14, 20, '－');
  const day = mod.parseBlock(grid, 0, filetypes);
  expect(day.dailyRows[0].契約數量).toBeNull();
  expect(day.dailyRows[0].本日完成數量).toBeNull();
  expect(day.dailyRows[0].契約單價).toBeNull();
});
