/**
 * OCR → items 的座標換算與修補層,以及掃描件的涵蓋範圍偵測。
 *
 * 這裡**不真的跑 OCR**:Windows OCR 的結果隨機器語言包而異,而且一頁要好幾秒。
 * `extractItemsOcr` 收的是注入的 `ocr`,所以餵一份「真實形狀」的假 OCR 輸出就能
 * 把換算邏輯釘死——那些數字取自鎮西 `0601A-0630A.pdf` 第 1 頁的實際 OCR 輸出。
 */
const {
  extractItemsOcr, _ocrRepair, _snapRows, ROW_SNAP_TOLERANCE,
} = require('../server/parsers/filetypes/pdf');
const { pageHeader, scanCoverage } = require('../server/daily-log-scan');

// 鎮西 0601A 第 1 頁的真實 OCR 片段(2200 → 點陣圖實際 2750px;A4 793.6×1122.24 DIP)
const FAKE_PAGE = {
  page: 1,
  width: 2200,
  bw: 2750,
  bh: 3889,
  pw: 793.6,
  ph: 1122.24,
  lines: [],
  boxes: [],
  words: [
    // 標題:逐字一個框,字距小 → 要併成一個 item
    { t: '公', line: 0, x: 1080, y: 205, w: 66, h: 60 },
    { t: '共', line: 0, x: 1155, y: 203, w: 63, h: 65 },
    { t: '工', line: 0, x: 1227, y: 215, w: 66, h: 41 },
    { t: '程', line: 0, x: 1301, y: 208, w: 68, h: 60 },
    // 「一」只有一橫,框高只有 7px:門檻若用單字字高會把它拆開
    { t: '第', line: 1, x: 175, y: 292, w: 32, h: 42 },
    { t: '一', line: 1, x: 219, y: 309, w: 36, h: 7 },
    { t: '聯', line: 1, x: 264, y: 294, w: 38, h: 39 },
    // 同一行的兩個欄位:字距上百 px → 不可併
    { t: '晴', line: 2, x: 637, y: 365, w: 40, h: 40 },
    { t: '下', line: 2, x: 753, y: 365, w: 40, h: 40 },
    { t: '午', line: 2, x: 799, y: 365, w: 40, h: 40 },
  ],
};

const fakeOcr = { ocrPdf: async () => ({ pages: [FAKE_PAGE], failedPages: [] }) };

test('像素換算回 PDF 點座標(比例尺用點陣圖的真實寬度)', async () => {
  const pages = await extractItemsOcr('x.pdf', { ocr: fakeOcr, width: 2200 });
  const items = pages[0].items;
  const title = items.find((i) => i.s.startsWith('公共'));
  // 文字層的同一個標題在 x=232.4 / y=786.0;換算誤差要在 2 點以內
  expect(Math.abs(title.x - 232.4)).toBeLessThan(2);
  expect(Math.abs(title.y - 786.0)).toBeLessThan(2.5);
});

// 要求 2200 但這台機器顯示縮放 125%,實際點陣圖是 2750px。
// 拿要求值當比例尺,所有 x 會偏移到 1.25 倍(實測),整份都對不上欄位。
test('比例尺不可用 DestinationWidth,要用 driver 回報的實際像素寬', async () => {
  const wrong = { ocrPdf: async () => ({ pages: [{ ...FAKE_PAGE, bw: null }], failedPages: [] }) };
  const a = (await extractItemsOcr('x.pdf', { ocr: fakeOcr }))[0].items[0];
  const b = (await extractItemsOcr('x.pdf', { ocr: wrong }))[0].items[0];
  expect(Math.abs(a.x - b.x)).toBeLessThan(0.01);        // 後備推算(×1.25)要與真實值一致
});

test('字距小的相鄰字要併成一個 item,跨欄的不可併', async () => {
  const items = (await extractItemsOcr('x.pdf', { ocr: fakeOcr }))[0].items;
  expect(items.map((i) => i.s)).toContain('公共工程');
  // 「一」的框高只有 7px:門檻改用整行字高的中位數才併得起來
  expect(items.map((i) => i.s)).toContain('第一聯');
  expect(items.map((i) => i.s)).toContain('晴');
  expect(items.map((i) => i.s)).toContain('下午');
});

test('同一行共用一個 y(逐字的框底差好幾點,會把一列拆成兩三列)', async () => {
  const items = (await extractItemsOcr('x.pdf', { ocr: fakeOcr }))[0].items;
  const line2 = items.filter((i) => i.s === '晴' || i.s === '下午');
  expect(line2).toHaveLength(2);
  expect(line2[0].y).toBe(line2[1].y);
});

describe('跨 line 的表格列對齊', () => {
  // 密集表格裡 OCR 常把一列切成多個 line(欄與欄的空白大),各 line 的框底中位數
  // 差 2~3 點。讀取器的 y 分帶容差只有 2 點上下,不對齊的話項次與數值會落在不同帶,
  // 整列讀不到值——而 item 層完全看不出來(框對、字也對)。
  //
  // 座標取自實際換算:A4 793.6×1122.24 DIP、點陣圖 2750px → 1 點 ≈ 4.62px。
  const 列 = (bottomPx, x, s) => ({ t: s, line: `${bottomPx}-${x}`, x, y: bottomPx - 40, w: 40, h: 40 });
  const page = (words) => ({
    page: 1, width: 2200, bw: 2750, bh: 3889, pw: 793.6, ph: 1122.24, lines: [], boxes: [], words,
  });

  test('同一列被切成多個 line 時要對齊回同一個 y', async () => {
    // 項次與數值差 14px ≈ 3.0 點:小於容差,是同一列
    const ocr = { ocrPdf: async () => ({ pages: [page([列(1040, 350, '1'), 列(1054, 2000, '5')])], failedPages: [] }) };
    const items = (await extractItemsOcr('x.pdf', { ocr }))[0].items;
    expect(items).toHaveLength(2);
    expect(items[0].y).toBe(items[1].y);
  });

  test('相鄰列不可被併(併了是把別列的數值讀成本列的,那是錯不是漏)', async () => {
    // 1040 與 1077 差 37px ≈ 8.0 點:這些表單的列距,必須分開
    const ocr = { ocrPdf: async () => ({ pages: [page([列(1040, 350, '1'), 列(1077, 350, '2')])], failedPages: [] }) };
    const items = (await extractItemsOcr('x.pdf', { ocr }))[0].items;
    expect(items).toHaveLength(2);
    expect(items[0].y).not.toBe(items[1].y);
  });

  test('群的錨點固定用最上面那一個,不隨新成員位移', () => {
    // 三個各差 4 點的 item:逐一比「與前一個的距離」會把它們全併成一列(跨距 8 點),
    // 而 8 點正是列距——那等於把三列壓成一列。錨點固定才會在第三個切開。
    const got = _snapRows([{ y: 100 }, { y: 96 }, { y: 92 }], ROW_SNAP_TOLERANCE);
    const ys = got.map((i) => i.y).sort((a, b) => b - a);
    expect(ys).toEqual([100, 100, 92]);
  });

  test('容差 0 等於不對齊(留給量測基座做 A/B)', () => {
    const src = [{ y: 100 }, { y: 97 }];
    expect(_snapRows(src, 0)).toBe(src);
  });
});

describe('OCR 修補層', () => {
  test('小數點被讀成中點要修回來(0·65 → 0.65)', () => {
    expect(_ocrRepair.repairOcrText('0·65')).toBe('0.65');
    expect(_ocrRepair.repairOcrText('2600·00')).toBe('2600.00');
  });

  test('只修「整個 token 就是數字」的,不碰項目名稱', () => {
    expect(_ocrRepair.repairOcrText('刨除與清運既有PU跑道面層')).toBe('刨除與清運既有PU跑道面層');
    expect(_ocrRepair.repairOcrText('13mm MDI 全密式PU')).toBe('13mm MDI 全密式PU');
  });

  test('表頭標籤認錯一兩個字要吸附回字彙', () => {
    expect(_ocrRepair.snapLabel('累計完成數暈')).toBe('累計完成數量');
    expect(_ocrRepair.snapLabel('工程項曰')).toBe('工程項目');
  });

  test('差太多就不吸附(寧可留著錯字讓完整性關卡看得見)', () => {
    expect(_ocrRepair.snapLabel('…計元')).toBe('…計元');
    expect(_ocrRepair.snapLabel('刨除清運')).toBe('刨除清運');
  });
});

describe('掃描件涵蓋範圍', () => {
  // 表頭那一行 OCR 實測 100% 正確(鎮西 60 頁);明細數量最好也只救得回一半、
  // 還有 0.6% 會讀成另一個合法數字,所以只做涵蓋範圍,不做明細。
  test('抽得出填報日期與天氣', () => {
    const items = [
      { x: 46, y: 758, w: 30, s: '第一聯' },
      { x: 59, y: 744, w: 57, s: '本日天氣:' },
      { x: 116, y: 744, w: 48, s: '上午:晴' },
      { x: 164, y: 744, w: 48, s: '下午:陰' },
      { x: 399, y: 746, w: 140, s: '填表日期:113年2月16日(星期五)' },
    ];
    expect(pageHeader(items)).toEqual({
      填報日期: '2024-02-16', 星期: '星期五', 天氣_上午: '晴', 天氣_下午: '陰',
    });
  });

  test('讀不到日期的頁要列出來,不可靜默略過', async () => {
    const pages = [
      { page: 1, items: [{ x: 0, y: 0, w: 1, s: '封面' }] },
      { page: 2, items: [{ x: 0, y: 0, w: 1, s: '填表日期:113年2月16日(星期五)' }] },
      { page: 3, items: [{ x: 0, y: 0, w: 1, s: '填表日期:113年2月17日(星期六)' }] },
    ];
    const got = await scanCoverage('x.pdf', { extractItemsOcr: async () => pages });
    expect(got.days).toBe(2);
    expect(got.日期).toEqual(['2024-02-16', '2024-02-17']);
    expect(got.缺日期頁).toEqual([1]);
  });
});
