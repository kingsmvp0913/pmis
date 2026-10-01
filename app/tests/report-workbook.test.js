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

  // 路由層是 const dest = ensureWorkbook(req.params.id),req.params.id 未經 DB 查驗就直接進來。
  // Express 會對路徑參數做 percent-decoding,惡意使用者能送 '../../etc' 這類值,
  // 若 workbookPath 不擋,就能把常駐檔複製到 DATA_DIR 之外的任意可寫位置(任意檔案寫入)。
  describe('projectId 路徑逃逸防護 — 未擋就是任意檔案寫入', () => {
    test.each([
      ['../../etc'],
      ['..\\..\\windows'],
      ['a/b'],
    ])('逃逸輸入 %s 必須被擋,不能拼出 DATA_DIR 之外的路徑', (bad) => {
      expect(() => workbookPath(bad)).toThrow();
    });

    test.each([
      [''],
      [null],
      [undefined],
      ['abc'],
      ['-1'],
      ['1.5'],
    ])('非正整數 %s 必須被擋 — projects.id 是 SERIAL,本來就只會是正整數', (bad) => {
      expect(() => workbookPath(bad)).toThrow();
    });

    test('合法輸入(數字或數字字串)仍正常放行 — 路由拿到的 req.params.id 是字串', () => {
      expect(() => workbookPath(7)).not.toThrow();
      expect(() => workbookPath('7')).not.toThrow();
      expect(workbookPath('7')).toBe(workbookPath(7));
    });
  });
});

// 8/11 以前的公版範本,每日施工紀錄的進度區塊少了 A 欄標籤與預定進度那一列公式;
// 監造報表 B7/F7 靠 MATCH("預定進度"/"實際進度", A:A) 找列,找不到就整份 PDF 進度空白。
// 專案報表是常駐檔,範本修好了舊專案也不會跟著變,只能在寫入時補。
describe('progressBlock — 量出每日施工紀錄的進度區塊缺了什麼', () => {
  const XLSX = require('xlsx');
  const { progressBlock } = require('../server/report-workbook');
  const build = (rows) => {
    const ws = {};
    let maxR = 0;
    for (const [addr, cell] of Object.entries(rows)) {
      ws[addr] = cell;
      maxR = Math.max(maxR, Number(addr.replace(/[A-Z]+/, '')));
    }
    ws['!ref'] = `A1:L${maxR}`;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '每日施工紀錄');
    const p = path.join(TMP, `pb-${Math.random().toString(36).slice(2)}.xlsx`);
    XLSX.writeFile(wb, p);
    return p;
  };
  // 合計列的位置會因刪項目列而上移,只能用 F 欄的 ROUND(SUM(F2:…)) 公式認
  const 合計 = (r) => ({
    [`F${r}`]: { t: 'n', v: 0, f: `ROUND(SUM(F2:F${r - 1}),0)` },
    [`J${r}`]: { t: 'n', v: 0, f: 'ROUND(SUM(SUMPRODUCT($E$2:$E$37,J$2:J$37)),0)' },
    [`L${r}`]: { t: 'n', v: 0, f: 'ROUND(SUM(SUMPRODUCT($E$2:$E$37,L$2:L$37)),0)' },
  });

  test('舊範本:標籤與預定進度列都缺', () => {
    const got = progressBlock(build({ ...合計(283) }));
    expect(got).toEqual({ 合計列: 283, 末欄: 'L', 缺標籤列: [283, 284, 285, 286, 287, 288], 預定列空: true });
  });

  test('新範本:什麼都不缺', () => {
    const got = progressBlock(build({
      ...合計(284), B284: { t: 's', v: '(合計)' },
      A285: { t: 's', v: '每日實際進度(%)' }, A286: { t: 's', v: '實際進度' }, A287: { t: 's', v: '總實際進度(%)' },
      A288: { t: 's', v: '每日預定進度(%)' }, A289: { t: 's', v: '預定進度' },
      J290: { t: 'n', v: 0, f: 'IF(1,0,0)' },
    }));
    expect(got).toEqual({ 合計列: 284, 末欄: 'L', 缺標籤列: [], 預定列空: false });
  });

  // 承辦人上傳的人工報表,預定進度列是他照廠商日誌手打的數字,不可以被直線公式蓋掉
  test('預定進度列有手填值就不算空', () => {
    const got = progressBlock(build({ ...合計(284), K290: { t: 'n', v: 0.0038 } }));
    expect(got.預定列空).toBe(false);
  });

  test('找不到合計列回 null', () => {
    expect(progressBlock(build({ A1: { t: 's', v: '項次' } }))).toBeNull();
  });
});
