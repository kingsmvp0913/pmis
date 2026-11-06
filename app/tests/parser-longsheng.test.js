/**
 * 隆昇土木包工業(永定國小,115 年度偏遠地區學校設施設備計畫)施工日誌讀取器測試。
 *
 * fixture 是同一案 10/10~10/31 的兩聯,**分成兩個 PDF 檔**(同明德那家):
 *   `longsheng-first.pdf`  第一聯 22 頁:天氣、進度、出工;明細只列當天施作的項目
 *   `longsheng-second.pdf` 第二聯 22 頁:每天完整清單,含項次、單價與金額
 * 上層依填報日期合併(daily-log-merge),所以最後一條測試把兩份合起來看。
 *
 * 斷言集中在「錯了不會有任何欄位變 null」的地方:
 *   ① 第二聯的值靠右對齊,用中心歸欄會把契約數量的「1」丟進別欄
 *   ② 跨行名稱要對稱分配:項次 7 的末行離自己 14.7pt、離「貳」15.2pt
 *   ③ 合計列的標籤每天不同(無/「發包工作費總計」/「計」),認不到就會被當成一列明細
 *   ④ 第一聯 10/20 起單位印小寫「m2」,認不到那一列整列消失
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// registry 於載入時依 PMIS_DATA_DIR 決定 PARSER_DIR;安裝路徑測試用暫存目錄,須在 require registry 前設定。
process.env.PMIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-longsheng-'));

const mod = require('../server/parsers/vendors/samples/longsheng.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');
const { mergeDays } = require('../server/daily-log-merge');

const F1 = path.join(__dirname, 'fixtures', 'longsheng-first.pdf');
const F2 = path.join(__dirname, 'fixtures', 'longsheng-second.pdf');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest()).toBe(true);
});

// 日誌第一聯「承攬廠商名稱」與承辦人下載檔名上的廠商名
test('vendorKey 是承攬廠商名', () => {
  expect(mod.meta.vendorKey).toBe('隆昇土木包工業');
});

describe('第二聯(完整明細)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(F2, ctx); }, 180000);

  test('22 天,10/10~10/31 依序不重複(日期是民國年)', () => {
    const d = days.map((x) => x.header.填報日期);
    expect(d).toHaveLength(22);
    expect(d[0]).toBe('2026-10-10');
    expect(d[21]).toBe('2026-10-31');
    expect(new Set(d).size).toBe(22);
  });

  test('每天 12 列:項次 1~7 + 費用貳~陸,大類「壹」不輸出,合計列不混進來', () => {
    for (const d of days) {
      expect(d.dailyRows.map((r) => r.項次))
        .toEqual(['1', '2', '3', '4', '5', '6', '7', '貳', '參', '肆', '伍', '陸']);
    }
    const rows = days.flatMap((d) => d.dailyRows);
    expect(rows.filter((r) => r.單位 == null || r.契約單價 == null || r.契約數量 == null)).toHaveLength(0);
  });

  // ① 契約數量的「1」中心 332、表頭「契約數量」中心 307,偏 25pt;用中心歸欄會落空
  test('明細逐欄(右緣對右緣歸欄)', () => {
    const r = days[0].dailyRows[0];
    expect(r.單位).toBe('式');
    expect(r.契約數量).toBe(1);
    expect(r.契約單價).toBe(24850);
    expect(r.本日完成數量).toBe(0.5);
    expect(r.本日完成金額).toBe(12425);
    expect(r.累計完成數量).toBe(0.5);
    const r4 = days[0].dailyRows[3];
    expect(r4.契約數量).toBe(1229);
    expect(r4.契約單價).toBe(120);
  });

  // ② 五行名稱(數值在第三行)、兩行名稱且數值帶沒有名稱(項次 3)、末行貼著「貳」(項次 7)
  test('跨行名稱完整且不串到隔壁', () => {
    const by = Object.fromEntries(days[0].dailyRows.map((r) => [r.項次, r.工程項目]));
    expect(by['1']).toBe('工程告示牌與職安衛告示牌(租用)、施工圍籬、警示帶、安全警示燈等安全措施(租用);'
      + '移動施工架(租用);廢棄物清運處理(含合法證明)與環境清潔');
    expect(by['2']).toBe('風雨走廊遮雨棚更換3mm塑鋁板(含原PC板拆除清運、天溝清淤與防水填縫)');
    expect(by['3']).toBe('安裝遮陽百葉(高0.8M以上),含固定五金');
    expect(by['7']).toBe('校舍教室與廁所室內天花板與牆面牆癌處理與清潔,刷水泥漆(1底2度,3~5色,由校方選定)');
    expect(by['貳']).toBe('職業安全衛生管理費(壹*1%)');
  });

  // ③ 合計列的累計金額當 header 本日累計金額;標籤三種寫法都要認得
  test('本日累計金額取合計列的累計完成金額', () => {
    const amt = (iso) => days.find((d) => d.header.填報日期 === iso).header.本日累計金額;
    expect(amt('2026-10-10')).toBe(29240);    // 合計列沒有標籤
    expect(amt('2026-10-11')).toBe(29240);    // 「發包工作費總計」
    expect(amt('2026-10-20')).toBe(69215);    // 只剩一個「計」
    expect(amt('2026-10-31')).toBe(109190);
  });

  // 來源缺陷照收:費用項的本日完成金額填的是數量;項次 7 的本日金額 76,050 = 195×390
  // (乘了契約數量不是單價)。讀取器不得回推「數量×單價」。
  test('廠商填錯的金額照收,不回推', () => {
    const d10 = days.find((d) => d.header.填報日期 === '2026-10-10');
    expect(d10.dailyRows.find((r) => r.項次 === '貳').本日完成金額).toBe(0.5);
    expect(d10.dailyRows.find((r) => r.項次 === '伍').本日完成金額).toBe(1);
    const d20 = days.find((d) => d.header.填報日期 === '2026-10-20');
    const r7 = d20.dailyRows.find((r) => r.項次 === '7');
    expect(r7.本日完成數量).toBe(195);
    expect(r7.本日完成金額).toBe(76050);
    expect(r7.累計完成數量).toBe(195);
    // 本日完成數量空白而本日金額印 0.00:數量照 null,金額照 0
    const r2 = d10.dailyRows.find((r) => r.項次 === '2');
    expect(r2.本日完成數量).toBeNull();
    expect(r2.本日完成金額).toBe(0);
  });

  test('第二聯沒有的欄位一律 null', () => {
    expect(days.filter((d) => d.header.天氣_上午 != null || d.header.實際進度 != null)).toHaveLength(0);
  });
});

describe('第一聯(header 與當天施作項目)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(F1, ctx); }, 180000);

  test('22 天,天氣、進度、開工日期、工程名稱與廠商', () => {
    expect(days).toHaveLength(22);
    const h = days[0].header;
    expect(h.填報日期).toBe('2026-10-10');
    expect(h.星期).toBe('六');
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    expect(h.預定進度).toBe(0.08);                  // 百分數,沒有 % 號,不換算
    expect(h.實際進度).toBe(1.94);
    expect(h.開工日期).toBe('2026-10-10');
    expect(h.工程名稱).toBe('115年度偏遠地區學校及非山非市學校設施設備計畫');
    expect(h.承包廠商).toBe('隆昇土木包工業');
    expect(days[21].header.預定進度).toBe(2.22);
    expect(days[21].header.實際進度).toBe(7.23);
  });

  test('出工只收本日人數(累計人數不是今天的人)', () => {
    expect(days[0].extras.出工明細).toEqual([{ 工別: '小工', 人數: 1 }]);
    expect(days[0].header.出工總人數).toBe(1);
    // 10/11 本日空白、累計 1
    expect(days[1].header.出工總人數).toBeNull();
    const d20 = days.find((d) => d.header.填報日期 === '2026-10-20');
    expect(d20.header.出工總人數).toBe(5);
  });

  // ④ 小寫「m2」認不到的話,10/20、10/21 那一列整列消失
  test('只列當天施作的項目;小寫單位照收', () => {
    expect(days[0].dailyRows).toHaveLength(4);
    const d20 = days.find((d) => d.header.填報日期 === '2026-10-20');
    expect(d20.dailyRows).toHaveLength(1);
    expect(d20.dailyRows[0].單位).toBe('m2');
    expect(d20.dailyRows[0].本日完成數量).toBe(195);
    expect(d20.dailyRows[0].工程項目).toBe('校舍教室與廁所室內天花板與牆面牆癌處理與清潔,刷水泥漆(1底2度,3~5色,由校方選定)');
    expect(days.flatMap((d) => d.dailyRows).filter((r) => r.契約單價 != null)).toHaveLength(0);
  });
});

// 承辦人一次上傳兩個檔,上層依填報日期合併:header 取第一聯、明細取第二聯
test('兩聯合併後 header 與明細都齊,且沒有衝突', async () => {
  const lists = [await mod.parseAll(F1, ctx), await mod.parseAll(F2, ctx)];
  const { days, conflicts } = mergeDays(lists);
  expect(conflicts).toEqual([]);
  expect(days).toHaveLength(22);
  const d = days[0];
  expect(d.header.天氣_上午).toBe('晴');
  expect(d.header.實際進度).toBe(1.94);
  expect(d.header.本日累計金額).toBe(29240);
  expect(d.dailyRows).toHaveLength(12);
  expect(d.dailyRows[0].契約單價).toBe(24850);
}, 180000);

test('不是隆昇的檔要 throw,不可回空陣列', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/隆昇/);
});

test('registry.install 走完整安裝路徑', () => {
  const registry = require('../server/parsers/registry');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'longsheng.pmisparser.js'));
  const r = registry.install(src, '隆昇土木包工業');
  expect(r.ok).toBe(true);
  expect(r.status && r.status.installed).toBe(true);
});

// 上傳時要靠這個判斷「兩聯是不是都傳了」(見 daily-log-merge 的 missingCopy)
test('meta 宣告兩聯分檔,每天標出來自哪一聯', async () => {
  expect(mod.meta.copies).toEqual(['第一聯', '第二聯']);
  const [a, b] = await Promise.all([mod.parseAll(F1, ctx), mod.parseAll(F2, ctx)]);
  expect(a.every((d) => d.聯別 === '第一聯')).toBe(true);
  expect(b.every((d) => d.聯別 === '第二聯')).toBe(true);
}, 180000);
