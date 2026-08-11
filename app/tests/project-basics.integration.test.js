/**
 * SP1 端對端整合測試 — 需 Excel COM + Windows PowerShell 5.1。
 * 無 Excel 的環境(如 CI)請以 SP0_SKIP_EXCEL=1 略過(沿用 SP0 的旗標)。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
// 必須在 require report-workbook **之前**設好,否則會寫進真的 data/reports/
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-sp1-'));
process.env.PMIS_DATA_DIR = TMP;

const XLSX = require('xlsx');
const { basicsToOperations } = require('../server/project-basics');
const { ensureWorkbook } = require('../server/report-workbook');
const { fillTemplate } = require('../server/template-engine');

// workbookPath 只收正整數(Task 9 的路徑逃逸防護),故測試用一個不會與真實
// projects.id 衝突的高位數字,而非字串代號。
const PROJECT_ID = 9001;

const d = process.env.SP0_SKIP_EXCEL ? describe.skip : describe;

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

d('工程基本資料寫入監造報表(Excel COM)', () => {
  test('9 值落地、B9 公式仍在並算出完工期限、巨集保留', async () => {
    const values = {
      工程名稱: '115年度宜梧國中老舊廁所整修工程',
      監造單位: '呂罡銘建築師事務所',
      主辦機關: '雲林縣立宜梧國民中學',
      設計單位: '呂罡銘建築師事務所',
      承包廠商: '玉森土木包工業',
      契約金額: 3057698,
      契約工期: 120,
      開工日期: '2026-06-19',
      工程編號: 'ywjh11504',
    };

    const dest = ensureWorkbook(PROJECT_ID);
    const tmp = dest.replace(/\.xlsm$/i, '.tmp.xlsm');
    await fillTemplate(dest, tmp, basicsToOperations(values));
    fs.renameSync(tmp, dest);

    const wb = XLSX.readFile(dest, { bookVBA: true });
    const bi = wb.Sheets['工程基本資料'];

    expect(bi.B1.v).toBe('115年度宜梧國中老舊廁所整修工程');
    expect(bi.B2.v).toBe('呂罡銘建築師事務所');
    expect(bi.B3.v).toBe('雲林縣立宜梧國民中學');
    expect(bi.B4.v).toBe('呂罡銘建築師事務所');
    expect(bi.B5.v).toBe('玉森土木包工業');
    expect(bi.B6.v).toBe(3057698);
    expect(bi.B7.v).toBe(120);
    expect(bi.B8.v).toBe(46192);          // 開工日期以序號落地
    expect(bi.B10.v).toBe('ywjh11504');

    // B9 是範本公式:值要重算正確,且公式本身不能被寫成死值
    // (公式外面包了「工期空或 0 就回空白」的守衛——決標公告讀不到契約工期時,
    //  B8+B7-1 會算出「開工日 − 1」,印在報表上就是完工早於開工。核心的
    //  B8+B7-1 必須還在,否則之後改了工期或開工日,完工期限不會跟著動。)
    expect(bi.B9.f).toContain('B8+B7-1');
    expect(bi.B9.f).toMatch(/^IF\(OR\(B7/);
    expect(bi.B9.v).toBe(46311);          // 2026-10-16,對照宜梧開工報告表的契約規定竣工日

    expect(!!wb.vbaraw).toBe(true);       // 巨集保留
  }, 180000);

  test('封面工程名稱由 INDEX/MATCH 自算,公式未被壓成死值', async () => {
    // 這是整條 pipeline 的核心假設:只填 9 值,其餘分頁由範本公式自算。
    // 值與公式要一起釘:只驗值的話,公式一旦被壓成死值這條仍會綠,
    // 但之後 SP2/SP3 改了工程基本資料,封面就不會跟著更新。
    const wb = XLSX.readFile(ensureWorkbook(PROJECT_ID));
    const cover = wb.Sheets['封面'];
    expect(cover.A4.v).toBe('115年度宜梧國中老舊廁所整修工程');
    expect(cover.A4.f).toContain('INDEX');
  }, 60000);
});
