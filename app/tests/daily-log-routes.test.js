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
