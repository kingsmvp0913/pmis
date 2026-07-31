const fs = require('fs');
const os = require('os');
const path = require('path');

// 必須在 require 之前設,module 載入時就會定出 DATA_DIR
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-rw-'));
process.env.PMIS_DATA_DIR = TMP;

const { workbookPath, ensureWorkbook, TEMPLATE_PATH } = require('../server/report-workbook');

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('report-workbook — 專案監造報表常駐檔', () => {
  test('路徑落在 PMIS_DATA_DIR 之下,不寫死絕對路徑', () => {
    expect(workbookPath(7).startsWith(path.resolve(TMP))).toBe(true);
    expect(workbookPath(7)).toMatch(/project_7/);
  });

  test('第一次呼叫由公版範本建檔', () => {
    const p = ensureWorkbook(1);
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBe(fs.statSync(TEMPLATE_PATH).size);
  });

  test('已存在則原樣沿用,絕不覆蓋', () => {
    // 覆蓋會把 SP2 已填的契約詳細價目表與 SP3 的每日施工紀錄整份洗掉
    const p = ensureWorkbook(2);
    fs.writeFileSync(p, 'SP2/SP3 已經寫過的內容');
    expect(ensureWorkbook(2)).toBe(p);
    expect(fs.readFileSync(p, 'utf8')).toBe('SP2/SP3 已經寫過的內容');
  });

  test('不同專案各自一份,互不干擾', () => {
    expect(ensureWorkbook(3)).not.toBe(ensureWorkbook(4));
  });
});
