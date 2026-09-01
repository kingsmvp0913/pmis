process.env.JWT_SECRET = 'test-secret';

const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-sp2-'));
// ⚠️ 必須在 require 之前:history-routes 與 report-workbook 在 module load 時
// 就把資料根算好,晚一步設定會把附件與報表寫進正式 data/。
process.env.PMIS_DATA_DIR = TMP;

const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const db = require('../server/db');

// 不真的讀 Excel 檔:fixture 是從實檔抽出的 JSON(見 scripts/make-budget-fixtures.js)。
jest.mock('../server/budget-sheet', () => {
  const actual = jest.requireActual('../server/budget-sheet');
  return { ...actual, readSheets: jest.fn() };
});
// 不真的開 Excel COM:寫入層由 SP0 的整合測負責
jest.mock('../server/template-engine', () => ({
  fillTemplate: jest.fn().mockResolvedValue({ ok: true, outPath: 'x' }),
}));

const { readSheets } = require('../server/budget-sheet');
const { fillTemplate } = require('../server/template-engine');
const { registerRoutes: registerAuthRoutes } = require('../server/auth');
const { registerRoutes: registerContractItemRoutes } = require('../server/contract-items-routes');

const fx = (key) => JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'budget', `${key}.json`), 'utf8')).sheets;

// 讓 readSheets 依「第幾次呼叫」回不同 fixture,對應多檔上傳的順序
const feed = (...keys) => {
  readSheets.mockReset();
  for (const k of keys) readSheets.mockReturnValueOnce(fx(k));
};

async function makeApp({ award = 1036370 } = {}) {
  const mem = newDb();
  db._setPoolForTesting(new (mem.adapters.createPg()).Pool());
  await db.migrate();
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  registerContractItemRoutes(app);
  const setup = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password1', display_name: '管理員' });
  const { rows } = await db.query(
    `INSERT INTO projects (name, award_amount) VALUES ('測試工程', $1) RETURNING id`, [award]);
  return { app, token: setup.body.token, id: rows[0].id };
}

const attach = (req, names) => {
  for (const n of names) req.attach('budget_sheets', Buffer.from('x'), n);
  return req;
};

// fillTemplate 的契約是「把結果寫到 tmp」,路由接著 renameSync 換掉本尊。
// mock 不產生那個檔的話,測到的會是 ENOENT 而不是被測的行為。
beforeEach(() => {
  jest.clearAllMocks();
  fillTemplate.mockImplementation(async (dest, tmp) => {
    fs.writeFileSync(tmp, 'xlsm');
    return { ok: true, outPath: tmp };
  });
});
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

// ── parse ──────────────────────────────────────────────────

test('未帶 token 回 401', async () => {
  const { app, id } = await makeApp();
  await request(app).post(`/api/projects/${id}/contract-items/parse`).expect(401);
});

test('沒帶檔案回 400', async () => {
  const { app, token, id } = await makeApp();
  const res = await request(app).post(`/api/projects/${id}/contract-items/parse`)
    .set('Authorization', `Bearer ${token}`).expect(400);
  expect(res.body.error).toMatch(/發包經費總表/);
});

// 決標金額是挑表的唯一客觀判準。沒有它就只能靠分頁名稱猜,而實測那樣會 100%
// 挑到舊底稿殘留的那張。
test('工程沒有決標金額時擋下並說明原因', async () => {
  const { app, token, id } = await makeApp({ award: null });
  feed('damei');
  const res = await attach(request(app).post(`/api/projects/${id}/contract-items/parse`)
    .set('Authorization', `Bearer ${token}`), ['a.xls']).expect(400);
  expect(res.body.error).toMatch(/決標金額/);
});

test('單張命中時直接回選定結果', async () => {
  const { app, token, id } = await makeApp({ award: 1036370 });
  feed('damei');
  const res = await attach(request(app).post(`/api/projects/${id}/contract-items/parse`)
    .set('Authorization', `Bearer ${token}`), ['大美.xlsm']).expect(200);
  expect(res.body.selected.合計).toBe(1036370);
  expect(res.body.selected.matched[0].file).toBe('大美.xlsm');
  expect(res.body.selected.items.length).toBe(30);
  // parse 純唯讀:有卡控問題時若已落庫,系統裡就會留下一份沒人確認過的價目表
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM contract_items');
  expect(rows[0].n).toBe(0);
});

test('跨兩檔相加命中時兩張都回傳', async () => {
  const { app, token, id } = await makeApp({ award: 1684045 });
  feed('chongxing-toilet', 'chongxing-sewage');
  const res = await attach(request(app).post(`/api/projects/${id}/contract-items/parse`)
    .set('Authorization', `Bearer ${token}`), ['廁所.xls', '汙水.xls']).expect(200);
  expect(res.body.selected.matched).toHaveLength(2);
  expect(res.body.selected.合計).toBe(1684045);
});

// 對不上時系統挑哪一張都可能是錯的,要把候選攤開讓承辦人自己看
test('對不上決標金額時回候選清單而非硬選一張', async () => {
  const { app, token, id } = await makeApp({ award: 999999 });
  feed('nanyang');
  const res = await attach(request(app).post(`/api/projects/${id}/contract-items/parse`)
    .set('Authorization', `Bearer ${token}`), ['南陽.xls']).expect(200);
  expect(res.body.selected).toBe(null);
  expect(res.body.candidates.map((c) => c.合計).sort((a, b) => a - b))
    .toEqual([1587660, 3122168]);
});

test('檔案沒有任何明細分頁時明確說明', async () => {
  const { app, token, id } = await makeApp();
  feed('taichung-nodetail');
  const res = await attach(request(app).post(`/api/projects/${id}/contract-items/parse`)
    .set('Authorization', `Bearer ${token}`), ['臺中.xlsm']).expect(400);
  expect(res.body.error).toMatch(/沒有.*明細|施工項目/);
});

// ── confirm ────────────────────────────────────────────────

const confirm = (app, token, id, files, picks) =>
  attach(request(app).post(`/api/projects/${id}/contract-items/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .field('picks', JSON.stringify(picks)), files);

// ⚠️ 逾時給 15 秒不是因為它慢得有問題:這是整個檔案裡第一支真的走到報表的測試,
// 要複製 694KB 的公版範本、再用 SheetJS 讀兩次(itemRowCounts + applyProtection),
// 單獨跑實測 2.7 秒。Jest 預設 5 秒只剩不到兩倍餘裕,全套並行時就會被 CPU 爭用
// 推過去,而症狀是「這支紅了」看起來像功能壞掉。
test('確認後寫入報表並落庫', async () => {
  const { app, token, id } = await makeApp({ award: 1036370 });
  feed('damei');
  const res = await confirm(app, token, id, ['大美.xlsm'], [{ file: '大美.xlsm', name: '詳細價目表' }])
    .expect(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.count).toBe(30);
  expect(fillTemplate).toHaveBeenCalledTimes(1);

  const { rows } = await db.query(
    'SELECT item_no, name, quantity, unit_price FROM contract_items WHERE project_id = $1 ORDER BY seq',
    [id]);
  expect(rows).toHaveLength(30);
  expect(rows[0].item_no).toBe('壹.1');
  expect(rows[rows.length - 1].item_no).toBe('陸'); // 費用項目排在最後
}, 15000);

// 前端只送「選了哪幾張分頁」,項目一律由後端重新解析。信任前端送來的項目等於
// 讓任何人繞過卡控直接寫進契約價目表。
test('確認時重新解析檔案,不吃前端送來的項目', async () => {
  const { app, token, id } = await makeApp({ award: 1036370 });
  feed('damei');
  await confirm(app, token, id, ['大美.xlsm'], [{ file: '大美.xlsm', name: '詳細價目表' }]).expect(200);
  expect(readSheets).toHaveBeenCalled();
});

// 重興是同一張決標的兩個標的(廁所 871,943 + 汙水 812,102),兩張表的項次都是
// 1、2、3…。合計剛好等於決標金額,所以合計那道卡控攔不住;攔下來的是項次重複。
// 訊息必須講出「這是兩個標的、報表要分開產生」——原本回的是一整排「項次 N 重複」,
// 承辦人看不出那代表什麼,只會以為檔案壞了。
test('兩個標的合併送出時,訊息要說出報表得分開產生', async () => {
  const { app, token, id } = await makeApp({ award: 1684045 });
  feed('chongxing-toilet', 'chongxing-sewage');
  // 分頁名沿用實檔:廁所那張尾端帶一個空白,汙水那張叫「詳細表」
  const res = await confirm(app, token, id, ['廁所.xls', '汙水.xls'], [
    { file: '廁所.xls', name: '詳細價目表 ' }, { file: '汙水.xls', name: '詳細表' },
  ]).expect(400);
  expect(res.body.error).toMatch(/兩個標的|分開/);
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM contract_items');
  expect(rows[0].n).toBe(0);
});

test('選定的組合合計對不上決標金額時擋下', async () => {
  const { app, token, id } = await makeApp({ award: 3122168 });
  feed('nanyang');
  const res = await confirm(app, token, id, ['南陽.xls'], [{ file: '南陽.xls', name: '詳細價目表' }])
    .expect(400);
  expect(res.body.error).toMatch(/決標金額/);
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM contract_items');
  expect(rows[0].n).toBe(0);
});

test('指定不存在的分頁時擋下', async () => {
  const { app, token, id } = await makeApp();
  feed('damei');
  const res = await confirm(app, token, id, ['大美.xlsm'], [{ file: '大美.xlsm', name: '不存在的分頁' }])
    .expect(400);
  expect(res.body.error).toMatch(/分頁/);
});

// 重傳時整張覆蓋,舊的項目紀錄不能留著——留著的話下次比差異會拿到兩個版本混在一起
test('重傳時覆蓋既有項目紀錄', async () => {
  const { app, token, id } = await makeApp({ award: 1036370 });
  feed('damei');
  await confirm(app, token, id, ['大美.xlsm'], [{ file: '大美.xlsm', name: '詳細價目表' }]).expect(200);
  feed('damei');
  await confirm(app, token, id, ['大美.xlsm'], [{ file: '大美.xlsm', name: '詳細價目表' }]).expect(200);
  const { rows } = await db.query(
    'SELECT COUNT(*)::int AS n FROM contract_items WHERE project_id = $1', [id]);
  expect(rows[0].n).toBe(30);
});

// 廠商會改舊項目,不是只會加新項目。覆蓋前要讓承辦人看到改了什麼。
test('已有價目表時 parse 回傳差異', async () => {
  const { app, token, id } = await makeApp({ award: 1036370 });
  feed('damei');
  await confirm(app, token, id, ['大美.xlsm'], [{ file: '大美.xlsm', name: '詳細價目表' }]).expect(200);
  // 第二次拿另一份(項目完全不同)來比
  await db.query('UPDATE contract_items SET unit_price = 1 WHERE seq = 1 AND project_id = $1', [id]);
  feed('damei');
  const res = await attach(request(app).post(`/api/projects/${id}/contract-items/parse`)
    .set('Authorization', `Bearer ${token}`), ['大美.xlsm']).expect(200);
  expect(res.body.diff.changed).toHaveLength(1);
});

test('第一次建立時差異為全新增', async () => {
  const { app, token, id } = await makeApp({ award: 1036370 });
  feed('damei');
  const res = await attach(request(app).post(`/api/projects/${id}/contract-items/parse`)
    .set('Authorization', `Bearer ${token}`), ['大美.xlsm']).expect(200);
  expect(res.body.diff.added).toHaveLength(30);
  expect(res.body.diff.removed).toHaveLength(0);
});

// Excel COM 失敗時不得留下一份「DB 說有、報表沒有」的價目表
test('寫入報表失敗時不落庫', async () => {
  const { app, token, id } = await makeApp({ award: 1036370 });
  feed('damei');
  fillTemplate.mockRejectedValueOnce(new Error('Excel 驅動重試 3 次仍失敗'));
  const res = await confirm(app, token, id, ['大美.xlsm'], [{ file: '大美.xlsm', name: '詳細價目表' }])
    .expect(500);
  expect(res.body.error).not.toMatch(/Excel 驅動/); // 內部細節不外洩
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM contract_items');
  expect(rows[0].n).toBe(0);
});

test('來源檔歸檔為 budget_sheet 且重傳只留最新', async () => {
  const { app, token, id } = await makeApp({ award: 1036370 });
  feed('damei');
  await confirm(app, token, id, ['大美.xlsm'], [{ file: '大美.xlsm', name: '詳細價目表' }]).expect(200);
  feed('damei');
  await confirm(app, token, id, ['大美修正.xlsm'], [{ file: '大美修正.xlsm', name: '詳細價目表' }]).expect(200);
  const { rows } = await db.query(
    `SELECT original_name FROM project_attachments WHERE project_id = $1 AND kind = 'budget_sheet'`,
    [id]);
  expect(rows.map((r) => r.original_name)).toEqual(['大美修正.xlsm']);
});

// ── 價目表寫入時一併寫「工程基本資料」 ──────────────────────
// 這兩件事在畫面上是兩顆獨立按鈕,承辦人做完價目表就以為報表好了。2026-08-14
// 對帳他手上那三份產出,工程基本資料 9 欄全空,正是這樣來的——而空白的後果
// 不只那一頁:封面整片印裸的 0、完工期限算成 -1、每日施工紀錄的日期軸變 0,1,2…。
describe('confirm 一併寫入工程基本資料', () => {
  const 基本資料ops = () => {
    const ops = fillTemplate.mock.calls[0][2];
    return ops.filter((o) => o.sheet === '工程基本資料');
  };

  test('主檔有值的欄位都寫進去,且與價目表同一次 Excel 呼叫', async () => {
    const { app, token, id } = await makeApp({ award: 1036370 });
    await db.query(
      `UPDATE projects SET project_no = 'A115', start_date = '2026-03-18',
              duration_days = 150, supervisor_firm = '呂罡銘建築師事務所',
              designer_firm = '大墩規劃設計顧問有限公司' WHERE id = $1`, [id]);
    feed('damei');
    await confirm(app, token, id, ['大美.xlsm'], [{ file: '大美.xlsm', name: '詳細價目表' }])
      .expect(200);
    // 開兩次 COM 是這條線上最慢也最容易失敗的一段,故必須併成同一批
    expect(fillTemplate).toHaveBeenCalledTimes(1);
    const ops = 基本資料ops();
    const byAddr = Object.fromEntries(ops.map((o) => [o.addr, o.value]));
    expect(byAddr.B1).toBe('測試工程');
    expect(byAddr.B2).toBe('呂罡銘建築師事務所');
    expect(byAddr.B4).toBe('大墩規劃設計顧問有限公司');
    expect(byAddr.B6).toBe(1036370);
    expect(byAddr.B7).toBe(150);          // 契約工期:開工報告表回寫來的
    expect(byAddr.B10).toBe('A115');
    // 開工日期要寫 Excel 序號,B9 的 =B8+B7-1 才算得出完工期限
    expect(typeof byAddr.B8).toBe('number');
  });

  // 缺的欄位**不產生指令**,不可寫 null 把已經填好的格清成空白——
  // basicsToOperations 對 undefined 就是跳過,這裡靠 put() 維持那個語意。
  test('主檔沒有的欄位不下指令,不會清空既有的格', async () => {
    const { app, token, id } = await makeApp({ award: 1036370 });
    feed('damei');
    const res = await confirm(app, token, id, ['大美.xlsm'],
      [{ file: '大美.xlsm', name: '詳細價目表' }]).expect(200);
    const addrs = 基本資料ops().map((o) => o.addr);
    expect(addrs).toContain('B1');        // 工程名稱:NOT NULL,一定有
    expect(addrs).toContain('B6');        // 契約金額:makeApp 給了
    expect(addrs).not.toContain('B7');    // 契約工期:沒設過
    expect(addrs).not.toContain('B8');    // 開工日期:沒設過
    expect(addrs).not.toContain('B10');   // 工程編號:沒設過
    // 回應要講清楚寫了幾欄、缺幾欄——不講的話承辦人無從得知那頁是不是滿的。
    // **缺的還要指名道姓**:只回一個數字,承辦人還是不知道要去補什麼,
    // 而空著的後果要到報表印出來才看得見。
    expect(res.body.基本資料.已寫入).toBe(addrs.length);
    expect(res.body.基本資料.缺).toBe(9 - addrs.length);
    expect(res.body.基本資料.缺欄位).toEqual(
      expect.arrayContaining(['契約工期', '開工日期', '工程編號']));
    expect(res.body.基本資料.缺欄位).toHaveLength(9 - addrs.length);
    expect(res.body.基本資料.缺欄位).not.toContain('工程名稱');
  });
});

// 「複製為另一標的」照抄的是決標**總額**,要承辦人自己改成該標的的金額。忘了改
// 就會撞到「合計與決標金額不符」——而那句話會把他導去查價目表,那份其實是對的。
test('合計對不上且同案號有兄弟標的時,直接講明是金額還沒拆', async () => {
  const { app, token, id } = await makeApp({ award: 1684045 });
  await db.query(`UPDATE projects SET project_no = 'CX-1', award_total = 1684045 WHERE id = $1`, [id]);
  await db.query(
    `INSERT INTO projects (name, project_no, award_amount, award_total)
     VALUES ('重興國小汙水', 'CX-1', 1684045, 1684045)`);
  feed('chongxing-toilet');
  const res = await confirm(app, token, id, ['廁所.xls'], [{ file: '廁所.xls', name: '詳細價目表' }])
    .expect(400);
  expect(res.body.error).toMatch(/2 個標的/);
  expect(res.body.error).toMatch(/總額/);
});

// 單一標的的案子不可以冒出這句話——那會把「選錯價目表」誤導成「金額沒拆」
test('只有一個標的時不加那句提示', async () => {
  const { app, token, id } = await makeApp({ award: 999999 });
  await db.query(`UPDATE projects SET project_no = 'SOLO-1' WHERE id = $1`, [id]);
  feed('chongxing-toilet');
  const res = await confirm(app, token, id, ['廁所.xls'], [{ file: '廁所.xls', name: '詳細價目表' }])
    .expect(400);
  expect(res.body.error).toMatch(/不符/);
  expect(res.body.error).not.toMatch(/個標的/);
});
