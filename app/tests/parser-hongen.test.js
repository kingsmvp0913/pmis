/**
 * 宏恩工程有限公司(永隆國小桌球室地坪整修)施工日誌讀取器測試。
 *
 * ⚠️ fixture 是**轉檔產物**:來源 `施工日誌(更).doc` 是 Word 97-2003 二進位檔,
 * 純 JS 讀不到表格結構,故先用 Word COM 另存 PDF(wdFormatPDF=17)再讀。
 * 轉出來的 PDF 有完整文字層與座標,讀取器就是對著它寫的;讀取器收到 .doc 會 throw
 * 並在訊息裡講要先轉 PDF。
 */
const fs = require('fs');
const path = require('path');
const mod = require('../server/parsers/vendors/samples/hongen.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'hongen.pdf');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest()).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商;名字對不上 vendors 表的話,
// 讀取器讀得動也永遠不會被叫到,而且不會有任何錯誤訊息。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('宏恩工程有限公司');
});

// .doc 進來要明確說「請先轉 PDF」,不可回空陣列讓上游當成「這份沒有資料」略過。
test('直接餵 .doc 要 throw 並講清楚怎麼辦', async () => {
  await expect(mod.parseAll('C:/x/施工日誌(更).doc', ctx)).rejects.toThrow(/另存 PDF/);
});

describe('parseAll(轉出的 PDF,15 天)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 180000);

  test('一天一頁', () => {
    expect(days.length).toBe(15);
    expect(days[0].header.填報日期).toBe('2026-01-28');
    expect(days[days.length - 1].header.填報日期).toBe('2026-02-11');
  });

  // Word 轉 PDF 會把數字切碎:「115年1月28日」是 11+5+年+1+月+28+日 七個 item。
  // 逐 item 比對抓不到日期,要整帶接起來再 regex。
  test('被切碎的日期要接得回來', () => {
    for (const d of days) expect(d.header.填報日期).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(days[0].header.星期).toBe('星期三');
    expect(days[0].header.開工日期).toBe('2026-01-28');       // 來源寫「115/1/28」
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('114年永隆國小地下桌球室地坪整修工程採購案');
    expect(h.承包廠商).toBe('宏恩工程有限公司');
    expect(h.天氣_上午).toBe('晴');
    expect(h.天氣_下午).toBe('晴');
    // 進度的標籤佔三行、值印在中間那一行,與標籤不同帶
    expect(h.預定進度).toBe(3.5);
    expect(h.實際進度).toBe(2);
  });

  // 名稱第一行與數值同一帶(y 差 2.7)、續行印在下面自成一帶
  test('跨行名稱要接回同一列', () => {
    const d = days[0];
    expect(d.dailyRows.map((r) => r.工程項目)).toEqual([
      '本日申報開工',
      '施工區管制措施與防護(租用);既有家具設備遷移復原',
    ]);
    expect(d.dailyRows[1]).toMatchObject({ 單位: '式', 契約數量: 1, 本日完成數量: 0.2, 累計完成數量: 0.2 });
  });

  // 「營造業專業工程特定施工項目」那行有時與最後一列只差 2.7 而被併進同一帶,
  // 只用帶的 y 過濾擋不掉,名稱尾巴會多一串標題(而且不會有任何欄位變 null)。
  test('段落標題不可黏進名稱', () => {
    for (const d of days) for (const r of d.dailyRows) {
      expect(r.工程項目).not.toMatch(/營造業專業工程特定施工項目/);
    }
  });

  test('此格式沒有單價與金額,一律 null 不回推', () => {
    for (const d of days) {
      expect(d.header.本日累計金額).toBeNull();
      for (const r of d.dailyRows) {
        expect(r.契約單價).toBeNull();
        expect(r.本日完成金額).toBeNull();
        expect(r.項次).toBe(r.工程項目);                     // 此格式沒有項次欄
      }
    }
  });
});

test('parse 回第一天', async () => {
  const one = await mod.parse(FIXTURE, ctx);
  expect(one.header.填報日期).toBe('2026-01-28');
}, 180000);

test('別家格式的 PDF 要明確失敗', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/表報編號/);
}, 180000);

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'hongen.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('宏恩工程有限公司');
});
