/**
 * 銘佑營造有限公司(龍井國小廁所)施工日誌讀取器測試。
 *
 * ── fixture 為什麼是 OCR 輸出而不是 PDF ──
 * 來源 `龍井國小七月份施工日誌.pdf` 是**無文字層的掃描件**,跑一次 OCR 要 38 秒。
 * 把它放進單元測試會讓整組測試慢到沒人願意跑,而且結果會隨模型版本漂移
 * ——那時測到的是「OCR 準不準」,不是「版面規則對不對」。
 * 故 fixture 存 `extractItemsOcr` 的輸出(`mingyou-ocr.json`,3 天 + 封面),
 * 版面規則全部照跑,`parseAll` 也用注入的假 filetypes 走完整條路。
 *
 * ── 斷言集中在三個「錯了不會有任何欄位變 null」的地方 ──
 *   ① 列錨用派工數量而不是單位 —— 7/30 那頁的「片」OCR 沒讀到,
 *      用單位當錨會少一列,**後面 16 項全部位移一格**且每格都還是合法數字
 *   ② 雙欄:右欄接在左欄之後,而且橫跨兩欄的 item 要切開
 *   ③ 費用項目用中文大寫、不佔出現序 —— 比對前要去掉 OCR 逐字插的空格
 */
const fs = require('fs');
const path = require('path');
const mod = require('../server/parsers/vendors/samples/mingyou.pmisparser.js');

const OCR = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mingyou-ocr.json'), 'utf8'));
// 注入假的檔型工具:讀取器只透過 ctx.filetypes 取檔型能力,這裡回快取的 OCR 輸出。
const ctx = { filetypes: { extractItemsOcr: async () => OCR } };

// 發包後經費總表(SP2)的 35 項。項次/單位/數量抄自
// `模板\發包後經費總表\龍井國小114-116年…_發包後經費總表.xlsm` 的「詳細價目表」。
const 契約 = [
  ['1', '式', 1], ['2', '式', 1], ['3', '式', 1], ['4', '式', 1], ['5', '式', 1],
  ['6', '式', 1], ['7', 'M2', 40], ['8', '式', 1], ['9', 'M2', 592], ['10', 'M2', 327],
  ['11', '組', 26], ['12', 'M2', 129], ['13', 'M2', 5], ['14', 'M2', 364], ['15', 'M', 138],
  ['16', 'M2', 2], ['17', 'M2', 331], ['18', 'M2', 129], ['19', '片', 4], ['20', '間', 22],
  ['21', '式', 1], ['22', '才', 23], ['23', '式', 1], ['24', '式', 1], ['25', '式', 1],
  ['26', '式', 1], ['27', '式', 1], ['28', '式', 1], ['29', '式', 1], ['30', '式', 1],
  ['貳', '式', 1], ['參', '式', 1], ['肆', '式', 1], ['伍', '式', 1], ['陸', '式', 1],
];

test('selfTest 以內建座標樣本通過,不需注入', () => {
  expect(mod.selfTest()).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商。⚠️ 同一所學校還有「龍井國小新建綜合球場」,
// 那一案是經緯營造,兩案的日誌別搞混。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('銘佑營造有限公司');
});

describe('parseAll(龍井國小廁所,掃描件)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll('(fixture)', ctx); });

  test('封面不算一天,3 天日期遞增', () => {
    expect(days).toHaveLength(3);
    expect(days.map((d) => d.header.填報日期)).toEqual(['2026-07-29', '2026-07-30', '2026-07-31']);
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('龍井國小114-116年公立國民中小學老舊廁所整修工程');
    expect(h.承包廠商).toBe('銘佑營造有限公司');
    expect(h.星期).toBe('星期三');
    expect(h.天氣_上午).toBe('晴天');
    expect(h.天氣_下午).toBe('晴天');
    expect(h.預定進度).toBe(0.35);
    expect(h.實際進度).toBe(2.42);
  });

  // ① 這是整支讀取器最重要的一條。7/30 那頁的「片」(項次19 的單位)OCR 沒讀到,
  //    若以單位當列錨就會少一列,而**後面 16 項全部位移一格**——每一格都還是
  //    合法數字,SP3 一條都不會叫。所以要斷言「每天都是 35 列且項次逐項對得上」。
  test('每天都是完整 35 列,項次與契約表逐項一致', () => {
    for (const d of days) {
      expect(d.dailyRows).toHaveLength(35);
      expect(d.dailyRows.map((r) => r.項次)).toEqual(契約.map((c) => c[0]));
    }
  });

  test('契約數量與契約表逐項一致(105/105)', () => {
    for (const d of days) {
      expect(d.dailyRows.map((r) => r.契約數量)).toEqual(契約.map((c) => c[2]));
    }
  });

  // 讀不到的單位留 null,不猜。補一個看起來合理的值會讓 SP3 的 E4 判成廠商寫錯,
  // 而真正的原因是 OCR 沒讀到那一格。
  test('單位除了 7/30 那個 OCR 沒讀到的以外全對,且不猜值', () => {
    const 缺 = [];
    days.forEach((d) => d.dailyRows.forEach((r, i) => {
      if (r.單位 !== 契約[i][1]) 缺.push(`${d.header.填報日期} ${r.項次} 讀=${r.單位}`);
    }));
    expect(缺).toEqual(['2026-07-30 19 讀=null']);
  });

  // ② 左欄 21 項、右欄 14 項,右欄**接在左欄之後**。右欄第一列的名稱與左欄最後一個
  //    數值被 OCR 讀成同一個 item(`"0.50貼深色石材 面（t=2cm，倒圆角）"`),
  //    不切開的話兩邊一起壞:左欄累計變 null、右欄名稱也變 null。
  test('橫跨兩欄的 item 要切開,兩邊都要拿到自己的值', () => {
    const d = days[0];
    expect(d.dailyRows[0].累計完成數量).toBe(0.5);          // 左欄第 1 列的累計
    expect(d.dailyRows[21]).toMatchObject({ 項次: '22', 單位: '才', 契約數量: 23 });
    expect(d.dailyRows[21].工程項目).toMatch(/^貼深色石材/); // 右欄第 1 列的名稱
  });

  // ③ OCR 會逐字插空格(同一個項目三天分別讀成「營業稅…」「營 業 稅…」「營 業 稅…」)。
  //    不清掉的話費用項目認不出來,項次會變成 31、32——而契約表裡沒有那兩個項次。
  test('費用項目用中文大寫,不受 OCR 插空格影響', () => {
    for (const d of days) {
      const 尾 = d.dailyRows.slice(-5);
      expect(尾.map((r) => r.項次)).toEqual(['貳', '參', '肆', '伍', '陸']);
      expect(尾[4].工程項目).toMatch(/^營業稅/);
      expect(尾[3].工程項目).toMatch(/保險費$/);
    }
  });

  // 此格式沒有單價欄與金額欄,一律 null 不回推(SP3 會把 B3/B4/C2 列入 skipped)。
  test('沒有的欄位留 null,不硬湊', () => {
    const rows = days.flatMap((d) => d.dailyRows);
    expect(rows.every((r) => r.契約單價 === null)).toBe(true);
    expect(rows.every((r) => r.本日完成金額 === null)).toBe(true);
  });
});

// 掃描件這條路一定要有 extractItemsOcr;沒有就明講,不可以回空陣列
// (上游會把空陣列當成「這份沒有資料」而靜靜略過)。
test('沒有注入 extractItemsOcr 要 throw', async () => {
  await expect(mod.parseAll('x.pdf', { filetypes: {} })).rejects.toThrow(/extractItemsOcr/);
});

test('讀不到任何一天要 throw,不可回空陣列', async () => {
  const 空 = { filetypes: { extractItemsOcr: async () => [{ items: [{ x: 1, y: 1, w: 1, s: '無關' }] }] } };
  await expect(mod.parseAll('x.pdf', 空)).rejects.toThrow(/讀不到任何一天/);
});
