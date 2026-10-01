/**
 * daily-log-scan 的注入契約。
 *
 * 這一層唯一的工作是「把 OCR 的字框換算成與文字層同形的 items,再餵給該廠商既有的
 * 讀取器」。注入少一個鍵,那個讀取器就整份 throw——而錯誤訊息長得像讀取器壞掉
 * (「缺少注入的 filetypes.extractItemsOcr」),沒人會想到是這裡漏接的。
 */
const { scanDays, scanDaysWithItems, scanAll } = require('../server/daily-log-scan');

const PAGES = [{ page: 1, items: [{ x: 1, y: 2, w: 3, s: 'A' }] }];
const deps = (parser) => ({
  ocr: { ocrPdf: async () => ({ pages: [] }) },
  extractItemsOcr: async () => PAGES,
  filetypes: { readWorkbook: () => 'wb' },
  parser,
});

test('OCR 的 items 換掉 extractItems 餵給讀取器', async () => {
  let got = null;
  await scanDays('x.pdf', deps({
    parseAll: async (p, ctx) => { got = await ctx.filetypes.extractItems(p); return []; },
  }));
  expect(got).toBe(PAGES);
});

// 整包換掉的話,讀取器裡任何一支非 PDF 分支都會炸
test('其餘檔型工具原樣保留', async () => {
  let got = null;
  await scanDays('x.pdf', deps({
    parseAll: async (p, ctx) => { got = ctx.filetypes.readWorkbook(); return []; },
  }));
  expect(got).toBe('wb');
});

// 掃描件專用的讀取器(銘佑)自己呼叫 ctx.filetypes.extractItemsOcr——那是它唯一的
// 入口,這個格式沒有文字層。原本這個鍵沒被注入,於是「辨識掃描件」對這家永遠
// 回「缺少注入的 filetypes.extractItemsOcr」,明細一列都預填不出來(龍井實測)。
// 回的是**這裡剛算好的那份**,不是再跑一次 OCR:同一份檔 OCR 一次要數十秒。
test('掃描件讀取器要的 extractItemsOcr 也要注入,且不重跑 OCR', async () => {
  let 次數 = 0;
  const d = deps({
    parseAll: async (p, ctx) => { await ctx.filetypes.extractItemsOcr(p, { width: 2200 }); return []; },
  });
  const 原本 = d.extractItemsOcr;
  d.extractItemsOcr = async (...a) => { 次數++; return 原本(...a); };
  await scanDays('x.pdf', d);
  expect(次數).toBe(1);
});

test('掃描件讀取器拿到的是同一份 items', async () => {
  let got = null;
  await scanDays('x.pdf', deps({
    parseAll: async (p, ctx) => { got = await ctx.filetypes.extractItemsOcr(p); return []; },
  }));
  expect(got).toBe(PAGES);
});

test('標註流程可沿用同一次 OCR 的 days 與座標', async () => {
  const days = [{ header: { 填報日期: '2026-07-15' }, dailyRows: [] }];
  const result = await scanDaysWithItems('x.pdf', deps({ parseAll: async () => days }));
  expect(result).toEqual({ days, pages: PAGES });
});

// 「辨識掃描件」原本 scanCoverage 與 scanDays 各自 OCR 一次,同一個解析度、同一份檔
// 跑兩遍:60 頁的掃描件等待時間直接加倍(土庫/明禮/橋美 9 月實測)。
describe('scanAll:一次 OCR 同時給涵蓋範圍與明細', () => {
  const HEADER = [{ page: 1, items: [{ x: 1, y: 2, w: 3, s: '填表日期:115年9月1日' }] }];
  const withCount = (parser) => {
    let n = 0;
    return {
      calls: () => n,
      deps: { ...deps(parser), extractItemsOcr: async () => { n += 1; return HEADER; } },
    };
  };

  test('OCR 只跑一次,涵蓋範圍與讀取器吃同一份 items', async () => {
    let got = null;
    const c = withCount({ parseAll: async (p, ctx) => { got = await ctx.filetypes.extractItems(p); return [{ header: {}, dailyRows: [] }]; } });
    const out = await scanAll('x.pdf', c.deps);
    expect(c.calls()).toBe(1);
    expect(got).toBe(HEADER);
    expect(out.coverage.日期).toEqual(['2026-09-01']);
    expect(out.days).toHaveLength(1);
    expect(out.讀取器錯誤).toBeNull();
  });

  // 讀取器整份 throw 時,涵蓋範圍是唯一答得出來的東西,不可跟著一起丟
  test('讀取器 throw 時仍回涵蓋範圍,錯誤訊息另外帶出', async () => {
    const c = withCount({ parseAll: async () => { throw new Error('表頭找不到'); } });
    const out = await scanAll('x.pdf', c.deps);
    expect(c.calls()).toBe(1);
    expect(out.coverage.days).toBe(1);
    expect(out.days).toBeNull();
    expect(out.讀取器錯誤).toBe('表頭找不到');
  });
});
