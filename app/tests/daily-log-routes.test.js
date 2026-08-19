process.env.JWT_SECRET = 'test-secret';

const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-sp3-'));
process.env.PMIS_DATA_DIR = TMP;

const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const db = require('../server/db');

// 讀取器與 Excel COM 都不在本檔的測試範圍:前者由 parser-*.test.js 涵蓋,
// 後者由 SP0 整合測涵蓋。這裡驗的是路由的把關與落庫。
jest.mock('../server/parsers/registry', () => ({ getParser: jest.fn() }));
jest.mock('../server/template-engine', () => ({ fillTemplate: jest.fn() }));
// OCR 同理:真跑一頁要好幾秒,而且結果隨模型/機器而異。這裡驗的是路由怎麼處理
// 「OCR 讀得出來」與「讀取器整份 throw」這兩種結局,不是 OCR 本身準不準。
jest.mock('../server/daily-log-scan', () => ({
  scanDays: jest.fn(),
  scanCoverage: jest.fn(async () => ({ pages: [], days: 0, 日期: [], 缺日期頁: [] })),
}));

const registry = require('../server/parsers/registry');
const { fillTemplate } = require('../server/template-engine');
const { scanDays, scanCoverage } = require('../server/daily-log-scan');
const { TEMPLATE_PATH, workbookPath } = require('../server/report-workbook');
const { registerRoutes: registerAuthRoutes } = require('../server/auth');
const { registerRoutes: registerDailyLogRoutes } = require('../server/daily-log-routes');

const day = (填報日期, rows) => ({
  header: {
    工程名稱: '測試工程', 填報日期, 星期: null, 天氣_上午: '晴', 天氣_下午: '晴',
    預定進度: 10, 實際進度: 10, 本日累計金額: null,
  },
  dailyRows: rows,
});
const r = (項次, 本日完成數量, extra = {}) => ({
  項次, 工程項目: `項目${項次}`, 單位: '式', 契約單價: 100, 契約數量: 10,
  本日完成數量, 本日完成金額: 本日完成數量 == null ? null : 本日完成數量 * 100,
  累計完成數量: 本日完成數量, ...extra,
});

// DATE 欄位轉 'YYYY-MM-DD'(理由同 daily-log-routes.js 的 toISODate)
const iso = (v) => (typeof v === 'string' ? v.slice(0, 10)
  : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`);

const feed = (days) => registry.getParser.mockReturnValue({ parseAll: async () => days });

async function makeApp({ withContract = true, withVendor = true, start = '2026-04-08' } = {}) {
  const mem = newDb();
  db._setPoolForTesting(new (mem.adapters.createPg()).Pool());
  await db.migrate();
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  registerDailyLogRoutes(app);
  const setup = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password1', display_name: '管理員' });

  let vendorId = null;
  if (withVendor) {
    const { rows } = await db.query(`INSERT INTO vendors (name) VALUES ('某某營造') RETURNING id`);
    vendorId = rows[0].id;
  }
  const { rows: p } = await db.query(
    `INSERT INTO projects (name, vendor_id, start_date, award_amount, contract_completion_date)
     VALUES ('測試工程', $1, $2, 100000, '2026-12-31') RETURNING id`, [vendorId, start]);
  const id = p[0].id;
  if (withContract) {
    await db.query(
      `INSERT INTO contract_items (project_id, seq, item_no, name, unit, quantity, unit_price)
       VALUES ($1, 1, '1', '項目1', '式', 10, 100)`, [id]);
  }
  return { app, token: setup.body.token, id };
}

const post = (app, token, id, route) => request(app)
  .post(`/api/projects/${id}/daily-logs/${route}`)
  .set('Authorization', `Bearer ${token}`)
  .attach('daily_log', Buffer.from('%PDF-1.4'), '施工日誌.pdf');

beforeEach(() => {
  jest.clearAllMocks();
  fillTemplate.mockImplementation(async (dest, tmp) => {
    fs.writeFileSync(tmp, 'xlsm');
    return { ok: true, outPath: tmp };
  });
});
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

test('未帶 token 回 401', async () => {
  const { app, id } = await makeApp();
  await request(app).post(`/api/projects/${id}/daily-logs/parse`).expect(401);
});

// 缺哪一份基準就明講缺哪一份——回籠統的「無法處理」會讓承辦人不知道要去補什麼
test('尚未建立契約詳細價目表時擋下並指出要先做什麼', async () => {
  const { app, token, id } = await makeApp({ withContract: false });
  feed([day('2026-04-08', [r('1', 1)])]);
  const res = await post(app, token, id, 'parse').expect(400);
  expect(res.body.error).toMatch(/契約詳細價目表/);
  expect(res.body.error).toMatch(/發包經費總表/);
});

test('沒有對應廠商讀取器時擋下', async () => {
  const { app, token, id } = await makeApp();
  registry.getParser.mockReturnValue(null);
  const res = await post(app, token, id, 'parse').expect(400);
  expect(res.body.error).toMatch(/讀取器/);
});

test('尚未填開工日期時擋下(沒有它就決定不了要寫哪一欄)', async () => {
  const { app, token, id } = await makeApp({ start: null });
  feed([day('2026-04-08', [r('1', 1)])]);
  const res = await post(app, token, id, 'parse').expect(400);
  expect(res.body.error).toMatch(/開工日期/);
});

test('parse 回驗證結果與差異,且不落庫', async () => {
  const { app, token, id } = await makeApp();
  feed([day('2026-04-08', [r('1', 3)]), day('2026-04-09', [r('1', 2, { 累計完成數量: 5 })])]);
  const res = await post(app, token, id, 'parse').expect(200);
  expect(res.body.天數).toBe(2);
  expect(res.body.errors).toEqual([]);
  expect(res.body.diff.added).toHaveLength(2);
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM daily_records');
  expect(rows[0].n).toBe(0);
});

// 硬錯整份擋下(2026-08-05 裁決):只跳過有問題的那幾天,報表會停在「進度不完整」
// 的狀態,而累計金額與完成百分比都是公式自算——數字會是錯的,但看起來完全正常。
test('有硬錯時整份不寫入', async () => {
  const { app, token, id } = await makeApp();
  feed([day('2026-04-08', [r('1', 3, { 契約數量: null })])]); // A7
  const res = await post(app, token, id, 'confirm').expect(400);
  expect(res.body.errors.map((e) => e.code)).toContain('A7');
  expect(fillTemplate).not.toHaveBeenCalled();
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM daily_records');
  expect(rows[0].n).toBe(0);
});

test('無硬錯時寫入報表並落庫', async () => {
  const { app, token, id } = await makeApp();
  feed([day('2026-04-08', [r('1', 3)]), day('2026-04-09', [r('1', 2, { 累計完成數量: 5 })])]);
  const res = await post(app, token, id, 'confirm').expect(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.天數).toBe(2);
  expect(fillTemplate).toHaveBeenCalledTimes(1);
  const { rows } = await db.query(
    `SELECT log_date, item_no, qty FROM daily_records
      WHERE project_id = $1 ORDER BY log_date`, [id]);
  expect(rows.map((x) => iso(x.log_date))).toEqual(['2026-04-08', '2026-04-09']);
});

// 刪列是 2026-08-11 才加進 SP2 的,在那之前建好的常駐報表還留著範本自己的五列
// 費用公式(`ROUND(SUM($F$2:$F$32)*7%,0)`)。那些列沒有項次/名稱/單位卻算得出單價,
// 「每日施工紀錄」照拉就是一整排 #N/A 配一個看起來合理的金額,合計與完成百分比
// 跟著爆(實測 9092.78%、189054.83%)。承辦人日常只上傳日誌不會重跑 SP2——
// 所以寫日誌時也要把列數對齊,否則舊報表永遠是壞的。
test('寫日誌時順手把多出來的範本殘留列刪掉', async () => {
  const { app, token, id } = await makeApp();
  // ⚠️ 本檔共用同一個 PMIS_DATA_DIR,而 pg-mem 每支測試重新發 id ——前面測試的
  // fillTemplate mock 已經把 project_1 的報表寫成純文字了。列數要量得出來,
  // 這裡得先還原成真的公版範本(量不到列數就只擴不刪,測不到要測的東西)。
  fs.mkdirSync(path.dirname(workbookPath(id)), { recursive: true });
  fs.copyFileSync(TEMPLATE_PATH, workbookPath(id));
  feed([day('2026-04-08', [r('1', 3)])]);
  await post(app, token, id, 'confirm').expect(200);
  const ops = fillTemplate.mock.calls[0][2];
  const 刪 = ops.filter((o) => o.type === 'deleteRows');
  // 契約只有 1 項,而公版範本三個分頁分別預留 31/36/36 列
  expect(刪.map((o) => `${o.sheet}:${o.startRow}+${o.count}`).sort()).toEqual([
    '契約詳細價目表:3+35', '每日施工紀錄:3+35', '監造報表:11+30',
  ]);
});

// 「後面才發現前面錯了」是真實流程:同一天重送修正版要能蓋掉舊值
test('重送同一天時覆蓋舊紀錄', async () => {
  const { app, token, id } = await makeApp();
  feed([day('2026-04-08', [r('1', 3)])]);
  await post(app, token, id, 'confirm').expect(200);
  feed([day('2026-04-08', [r('1', 8)])]);
  await post(app, token, id, 'confirm').expect(200);
  const { rows } = await db.query(
    'SELECT qty FROM daily_records WHERE project_id = $1', [id]);
  expect(rows).toHaveLength(1);
  expect(Number(rows[0].qty)).toBe(8);
});

// 分批提交是常態:第二批不含第一批的日期,不能把已寫入的進度清掉
test('送新的一批不會清掉先前批次的日期', async () => {
  const { app, token, id } = await makeApp();
  feed([day('2026-04-08', [r('1', 3)])]);
  await post(app, token, id, 'confirm').expect(200);
  feed([day('2026-05-06', [r('1', 2, { 累計完成數量: 5 })])]);
  await post(app, token, id, 'confirm').expect(200);
  const { rows } = await db.query(
    `SELECT log_date FROM daily_records
      WHERE project_id = $1 ORDER BY log_date`, [id]);
  expect(rows.map((x) => iso(x.log_date))).toEqual(['2026-04-08', '2026-05-06']);
});

// 第二次上傳時要看得到「哪一天的哪一項從多少改成多少」,不能只說「已更新」
test('parse 對已寫入的日期回報逐項變更', async () => {
  const { app, token, id } = await makeApp();
  feed([day('2026-04-08', [r('1', 3)])]);
  await post(app, token, id, 'confirm').expect(200);
  feed([day('2026-04-08', [r('1', 9)])]);
  const res = await post(app, token, id, 'parse').expect(200);
  expect(res.body.diff.changed).toEqual([
    { 日期: '2026-04-08', 項次: '1', 舊: 3, 新: 9 },
  ]);
});

// 讀取器讀不動這份檔,跟「伺服器壞掉」是兩回事。原本兩者都回
// 「施工日誌解析失敗,請稍後重試;若持續失敗請聯絡系統管理員」——而讀取器的錯
// **重試一萬次也不會成功**,承辦人只能一直重試然後打電話。讀取器自己丟的訊息
// (「PDF 沒有文字層(掃描件)」「找不到第一聯/第二聯」)才是他要看的。
test('讀取器讀不動時回 400 並轉述讀取器的原因與檔名', async () => {
  const { app, token, id } = await makeApp();
  registry.getParser.mockReturnValue({
    parseAll: async () => { throw new Error('PDF 沒有文字層(掃描件),無法解析'); },
  });
  const res = await post(app, token, id, 'parse').expect(400);
  expect(res.body.error).toMatch(/施工日誌\.pdf/);
  expect(res.body.error).toMatch(/沒有文字層/);
  expect(res.body.error).not.toMatch(/稍後重試/);
});

// 掃描件另有一條路(辨識掃描件),但錯誤訊息不講的話承辦人不會知道要去按它。
test('讀不到文字層時指路到「辨識掃描件」', async () => {
  const { app, token, id } = await makeApp();
  registry.getParser.mockReturnValue({
    parseAll: async () => { throw new Error('PDF 沒有文字層(掃描件),無法解析'); },
  });
  const res = await post(app, token, id, 'parse').expect(400);
  expect(res.body.error).toMatch(/辨識掃描件/);
});

// 真的是伺服器壞掉時仍要 500,不能被上面那條吃掉
test('非讀取器的錯仍回 500', async () => {
  const { app, token, id } = await makeApp();
  feed([day('2026-04-08', [r('1', 3)])]);
  fillTemplate.mockRejectedValueOnce(new Error('Excel 驅動重試 3 次仍失敗'));
  await post(app, token, id, 'confirm').expect(500);
});

// Excel COM 失敗時不得留下「DB 說有、報表沒有」的紀錄
test('寫入報表失敗時不落庫', async () => {
  const { app, token, id } = await makeApp();
  feed([day('2026-04-08', [r('1', 3)])]);
  fillTemplate.mockRejectedValueOnce(new Error('Excel 驅動重試 3 次仍失敗'));
  const res = await post(app, token, id, 'confirm').expect(500);
  expect(res.body.error).not.toMatch(/Excel 驅動/);
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM daily_records');
  expect(rows[0].n).toBe(0);
});

test('來源日誌歸檔為 daily_log', async () => {
  const { app, token, id } = await makeApp();
  feed([day('2026-04-08', [r('1', 3)])]);
  await post(app, token, id, 'confirm').expect(200);
  const { rows } = await db.query(
    `SELECT original_name FROM project_attachments WHERE project_id = $1 AND kind = 'daily_log'`,
    [id]);
  expect(rows).toHaveLength(1);
});

// 施工日誌是分批累積的,每一批都留著才有完整的來源憑據——不可比照開工報告表覆蓋
test('第二批日誌不覆蓋第一批的附件', async () => {
  const { app, token, id } = await makeApp();
  feed([day('2026-04-08', [r('1', 3)])]);
  await post(app, token, id, 'confirm').expect(200);
  feed([day('2026-05-06', [r('1', 2, { 累計完成數量: 5 })])]);
  await post(app, token, id, 'confirm').expect(200);
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM project_attachments WHERE project_id = $1 AND kind = 'daily_log'`,
    [id]);
  expect(rows[0].n).toBe(2);
});

test('走讀取器寫入的紀錄標記 source=parser', async () => {
  const { app, token, id } = await makeApp();
  feed([day('2026-04-08', [r('1', 3)])]);
  await post(app, token, id, 'confirm').expect(200);
  const { rows } = await db.query('SELECT source FROM daily_records WHERE project_id = $1', [id]);
  expect(rows[0].source).toBe('parser');
});

describe('掃描件(OCR 預填 → 逐格確認)', () => {
  const scanned = (app, token, id, body) => {
    const req = request(app)
      .post(`/api/projects/${id}/daily-logs/confirm-scanned`)
      .set('Authorization', `Bearer ${token}`)
      .attach('daily_log', Buffer.from('%PDF-1.4'), '掃描件.pdf');
    for (const [k, v] of Object.entries(body)) req.field(k, v);
    return req;
  };

  test('OCR 讀得出明細時回草稿與契約項目', async () => {
    const { app, token, id } = await makeApp();
    feed([]);                                   // 文字層讀不到東西才會走到這條路
    scanDays.mockResolvedValueOnce([day('2026-04-08', [r('1', 3)])]);
    const res = await post(app, token, id, 'scan').expect(200);
    expect(res.body.可預填).toBe(true);
    expect(res.body.days).toHaveLength(1);
    expect(res.body.契約項目).toHaveLength(1);
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM daily_records');
    expect(rows[0].n).toBe(0);                  // scan 唯讀
  });

  // 橋美那份**有文字層**,禾結讀取器 11 天 374 列零缺漏,承辦人卻按了「辨識掃描件」:
  // OCR 跑了好幾分鐘,結果 0 天 0 格,再按確認就得到「沒有收到要寫入的日誌內容」。
  // 這條路只該給沒有文字層的檔——讀取器讀得動就直接說,別讓他等。
  test('有文字層而且讀取器讀得動時,不跑 OCR,直接指路到「驗證施工日誌」', async () => {
    const { app, token, id } = await makeApp();
    feed([day('2026-04-08', [r('1', 3)])]);
    const res = await request(app)
      .post(`/api/projects/${id}/daily-logs/scan`)
      .set('Authorization', `Bearer ${token}`)
      .attach('daily_log', Buffer.from('%PDF-1.4'), '施工日誌.pdf')
      .expect(400);
    expect(res.body.error).toMatch(/驗證施工日誌/);
    expect(scanCoverage).not.toHaveBeenCalled();
    expect(scanDays).not.toHaveBeenCalled();
  });

  // 實測 8 份裡有 2 份會這樣(表頭錨點 OCR 認錯)。這時仍要答得出涵蓋範圍,
  // 讓承辦人知道這份涵蓋幾天要人工補,而不是丟一個 500 給他。
  test('讀取器整份 throw 時仍回涵蓋範圍,不是 500', async () => {
    const { app, token, id } = await makeApp();
    feed([]);
    scanDays.mockRejectedValueOnce(new Error('第二聯表頭欄位找不到(非某某格式?)'));
    scanCoverage.mockResolvedValueOnce({
      pages: [], days: 2, 日期: ['2026-04-08', '2026-04-09'], 缺日期頁: [3],
    });
    const res = await post(app, token, id, 'scan').expect(200);
    expect(res.body.可預填).toBe(false);
    expect(res.body.涵蓋範圍.日期).toEqual(['2026-04-08', '2026-04-09']);
    expect(res.body.讀取器錯誤).toMatch(/表頭/);
  });

  // ⚠️ 讀取器讀出**空陣列**時原本會走「可預填」那條:畫面出現逐格核對的表格與
  // 「確認並寫入」按鈕,但一列都沒有(僑美實測「共 0 天,已有數字 0 格」)。
  // 承辦人勾了確認、按下去,才收到「沒有收到要寫入的日誌內容」。0 天等於認不出來。
  test('讀取器回 0 天時當成認不出來,不要給一個按了會失敗的按鈕', async () => {
    const { app, token, id } = await makeApp();
    feed([]);
    registry.getParser.mockReturnValue({ parseAll: async () => { throw new Error('無文字層'); } });
    scanDays.mockResolvedValueOnce([]);
    scanCoverage.mockResolvedValueOnce({
      pages: [], days: 3, 日期: ['2026-04-08'], 缺日期頁: [],
    });
    const res = await post(app, token, id, 'scan').expect(200);
    expect(res.body.可預填).toBe(false);
    expect(res.body.涵蓋範圍.days).toBe(3);
  });

  // 少了這一關,這條路就只是個「繞過驗證直接寫 DB」的 API
  test('沒有明確表態逐格確認過就不寫', async () => {
    const { app, token, id } = await makeApp();
    const res = await scanned(app, token, id, {
      days: JSON.stringify([day('2026-04-08', [r('1', 3)])]),
    }).expect(400);
    expect(res.body.error).toMatch(/逐格確認/);
    expect(fillTemplate).not.toHaveBeenCalled();
  });

  test('送來的內容形狀不合法時回 400 並指出問題,不是 500', async () => {
    const { app, token, id } = await makeApp();
    const 壞日期 = [day('113/04/08', [r('1', 3)])];
    const res = await scanned(app, token, id, {
      confirmed: 'true', days: JSON.stringify(壞日期),
    }).expect(400);
    expect(res.body.error).toMatch(/填報日期/);
  });

  // 「人確認過」不等於放行:OCR 漏掉的格子承辦人也可能漏補
  test('確認後仍有硬錯時整份擋下', async () => {
    const { app, token, id } = await makeApp();
    const days = [day('2026-04-08', [r('1', 3, { 契約數量: null })])];   // A7
    const res = await scanned(app, token, id, {
      confirmed: 'true', days: JSON.stringify(days),
    }).expect(400);
    expect(res.body.errors.map((e) => e.code)).toContain('A7');
    expect(fillTemplate).not.toHaveBeenCalled();
  });

  // 事後查帳只剩這個欄位能指出「這個數字是 OCR 讀的,該回頭看紙本」
  test('確認後寫入,並標記 source=ocr_confirmed', async () => {
    const { app, token, id } = await makeApp();
    const days = [day('2026-04-08', [r('1', 3)])];
    const res = await scanned(app, token, id, {
      confirmed: 'true', days: JSON.stringify(days),
    }).expect(200);
    expect(res.body.來源).toBe('ocr_confirmed');
    expect(fillTemplate).toHaveBeenCalledTimes(1);
    const { rows } = await db.query(
      'SELECT qty, source FROM daily_records WHERE project_id = $1', [id]);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].qty)).toBe(3);
    expect(rows[0].source).toBe('ocr_confirmed');
  });

  // 承辦人改的值必須真的被寫進去——這條路存在的唯一理由就是收他改的值
  test('寫進去的是承辦人改過的值,不是 OCR 原本讀到的', async () => {
    const { app, token, id } = await makeApp();
    scanDays.mockResolvedValueOnce([day('2026-04-08', [r('1', 3)])]);
    await post(app, token, id, 'scan').expect(200);
    const 改過 = [day('2026-04-08', [r('1', 7)])];
    await scanned(app, token, id, { confirmed: 'true', days: JSON.stringify(改過) }).expect(200);
    const { rows } = await db.query('SELECT qty FROM daily_records WHERE project_id = $1', [id]);
    expect(Number(rows[0].qty)).toBe(7);
  });

  // 數量欄前端一定是字串送過來的(FormData + JSON),不轉型的話 Number 比較會全錯
  test('數量欄收字串也要當成數字', async () => {
    const { app, token, id } = await makeApp();
    const days = [day('2026-04-08', [r('1', 3)])];
    days[0].dailyRows[0].本日完成數量 = '3';
    days[0].dailyRows[0].累計完成數量 = '3';
    await scanned(app, token, id, { confirmed: 'true', days: JSON.stringify(days) }).expect(200);
    const { rows } = await db.query('SELECT qty FROM daily_records WHERE project_id = $1', [id]);
    expect(Number(rows[0].qty)).toBe(3);
  });
});

// ── 多檔上傳:兩聯分成兩個檔(明德)、一案多份月檔(久木 6 份)────────────
//
// 只送一個檔不是少了天氣與進度,就是少了單價與金額——而**兩者都不會讓任何欄位
// 看起來有問題**,SP3 只會說「此格式不提供」然後放行。少東西不會有人發現。
describe('多檔上傳', () => {
  const 第一聯 = [{
    header: {
      填報日期: '2026-04-08', 天氣_上午: '晴', 天氣_下午: '晴',
      預定進度: 0.63, 實際進度: 1.29, 承包廠商: '明德土木包工業', 工程名稱: '測試工程',
    },
    dailyRows: [{
      項次: '1', 工程項目: '項目1', 單位: '式', 契約單價: null, 契約數量: 10,
      本日完成數量: 1, 本日完成金額: null, 累計完成數量: 1,
    }],
  }];
  const 第二聯 = [{
    header: { 填報日期: '2026-04-08', 天氣_上午: null, 天氣_下午: null, 工程名稱: '測試工程' },
    dailyRows: [{
      項次: '1', 工程項目: '項目1', 單位: '式', 契約單價: 100, 契約數量: 10,
      本日完成數量: 1, 本日完成金額: 100, 累計完成數量: 1,
    }],
  }];

  // 讀取器一次吃一個檔,依呼叫序回不同的結果(模擬兩個不同的檔)
  const feedPerFile = (lists) => {
    let i = 0;
    registry.getParser.mockReturnValue({ parseAll: async () => lists[i++] || [] });
  };

  const postTwo = (app, token, id, route) => request(app)
    .post(`/api/projects/${id}/daily-logs/${route}`)
    .set('Authorization', `Bearer ${token}`)
    .attach('daily_log', Buffer.from('%PDF-1.4'), '第一聯.pdf')
    .attach('daily_log', Buffer.from('%PDF-1.4'), '第二聯.pdf');

  test('兩個檔合併成一天,兩邊的欄位都在', async () => {
    const { app, token, id } = await makeApp();
    feedPerFile([第一聯, 第二聯]);
    const res = await postTwo(app, token, id, 'parse').expect(200);
    expect(res.body.天數).toBe(1);
    expect(res.body.檔數).toBe(2);
    expect(res.body.衝突).toEqual([]);
    // 第一聯才有天氣 → A2 不該報「天氣未填」;第二聯才有單價 → E6 有得比
    expect(res.body.errors.map((e) => e.code)).not.toContain('A2');
  });

  test('兩個檔的同一欄不同 → 回衝突,不靜默挑一個', async () => {
    const { app, token, id } = await makeApp();
    const 別案 = [{ ...第二聯[0], header: { ...第二聯[0].header, 工程名稱: '別的工程' } }];
    feedPerFile([第一聯, 別案]);
    const res = await postTwo(app, token, id, 'parse').expect(200);
    expect(res.body.衝突).toHaveLength(1);
    expect(res.body.衝突[0].欄位).toBe('工程名稱');
  });

  // 附件是憑據。只留其中一個,另一個從此查不到——明德那家少任何一聯都還原不出
  // 當初驗過的資料。
  test('confirm 時每一個檔都要歸檔', async () => {
    const { app, token, id } = await makeApp();
    feedPerFile([第一聯, 第二聯]);
    await postTwo(app, token, id, 'confirm').expect(200);
    const { rows } = await db.query(
      `SELECT original_name FROM project_attachments WHERE project_id = $1 AND kind = 'daily_log' ORDER BY id`,
      [id]
    );
    expect(rows.map((r) => r.original_name)).toEqual(['第一聯.pdf', '第二聯.pdf']);
  });

  // 單檔的行為完全不變(合併在只有一個檔時是恆等的)
  test('單檔仍然可用', async () => {
    const { app, token, id } = await makeApp();
    feed(第二聯);
    const res = await post(app, token, id, 'parse').expect(200);
    expect(res.body.天數).toBe(1);
    expect(res.body.檔數).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  期初累計(承辦人 2026-08-15 裁決)
//
//  久木那家一個月一個檔。只拿到 6 月那一份時,第一天的累計就已經是前幾個月做的量,
//  系統從 0 起算 → 每天都報 B3「金額對不起來」,實測 155 筆假硬錯、整份被擋,
//  而原因不是廠商也不是讀取器。這一組驗的是「填了期初之後那些假硬錯會消失」。
// ══════════════════════════════════════════════════════════════════
describe('期初累計', () => {
  const openings = (app, token, id) => request(app)
    .get(`/api/projects/${id}/daily-logs/openings`).set('Authorization', `Bearer ${token}`);
  const setOpenings = (app, token, id, items) => request(app)
    .put(`/api/projects/${id}/daily-logs/openings`).set('Authorization', `Bearer ${token}`).send({ items });

  test('未帶 token 回 401', async () => {
    const { app, id } = await makeApp();
    await request(app).get(`/api/projects/${id}/daily-logs/openings`).expect(401);
  });

  // 只回「已存的那幾筆」會讓還沒填的項目在畫面上隱形,承辦人以為填完了。
  test('以契約表為骨架逐項列出,沒填的回 null', async () => {
    const { app, token, id } = await makeApp();
    const res = await openings(app, token, id).expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ 項次: '1', 項目: '項目1', 契約數量: 10, 期初累計: null });
  });

  test('存了讀得回來', async () => {
    const { app, token, id } = await makeApp();
    await setOpenings(app, token, id, [{ 項次: '1', 期初累計: 3 }]).expect(200);
    const res = await openings(app, token, id).expect(200);
    expect(res.body.items[0].期初累計).toBe(3);
  });

  // 逐筆 upsert 的話,清空某一項時那筆會留在庫裡:畫面看起來清掉了、驗證仍用舊值,
  // 而且不會有任何錯誤訊息。所以是整批覆蓋。
  test('再存一次會整批覆蓋,清空的項目要真的消失', async () => {
    const { app, token, id } = await makeApp();
    await setOpenings(app, token, id, [{ 項次: '1', 期初累計: 3 }]).expect(200);
    const res2 = await setOpenings(app, token, id, [{ 項次: '1', 期初累計: 0 }]).expect(200);
    expect(res2.body.筆數).toBe(0);
    const res = await openings(app, token, id).expect(200);
    expect(res.body.items[0].期初累計).toBeNull();
  });

  test('不在契約表裡的項次不收,負數擋下', async () => {
    const { app, token, id } = await makeApp();
    const ok = await setOpenings(app, token, id, [{ 項次: '999', 期初累計: 5 }]).expect(200);
    expect(ok.body.筆數).toBe(0);
    await setOpenings(app, token, id, [{ 項次: '1', 期初累計: -1 }]).expect(400);
  });

  // 這條是整組的重點:同一份日誌,填期初之前被擋、填了之後就過。
  // 情境同久木:前期已做 3,這批的第一天做 2、累計欄印 5。系統看不到那 3 的話,
  // 累計 5 對不上「0 + 2」,也對不上金額 5×100——B3(金額)與 F4(期末累計)一起噴。
  const 久木情境 = () => day('2026-04-08', [r('1', 2, { 累計完成數量: 5 })]);

  test('填了期初累計之後,累計對不起來的假硬錯會消失', async () => {
    const { app, token, id } = await makeApp();
    feed([久木情境()]);
    const 前 = await post(app, token, id, 'parse').expect(200);
    expect(前.body.errors.map((e) => e.code)).toEqual(expect.arrayContaining(['B3', 'F4']));

    await setOpenings(app, token, id, [{ 項次: '1', 期初累計: 3 }]).expect(200);
    feed([久木情境()]);
    const 後 = await post(app, token, id, 'parse').expect(200);
    expect(後.body.errors).toEqual([]);
  });
});
