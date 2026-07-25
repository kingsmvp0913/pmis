/**
 * SP0 fillTemplate 端對端整合測試 — 需 Excel COM + Windows PowerShell 5.1。
 * 無 Excel 的環境(如 CI)請以 SP0_SKIP_EXCEL=1 略過。
 */
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { fillTemplate } = require('../server/template-engine');

const FIX = path.join(__dirname, 'fixtures', 'sp0-template.xlsm');
const OUT = path.join(__dirname, 'fixtures', '_sp0-out.xlsm');

const d = process.env.SP0_SKIP_EXCEL ? describe.skip : describe;

d('fillTemplate 端對端(Excel COM)', () => {
  afterAll(() => { try { fs.unlinkSync(OUT); } catch { /* ignore */ } });

  test('setCell 寫入值後相依公式重算,且巨集/公式保留', async () => {
    await fillTemplate(FIX, OUT, [
      { type: 'setCell', sheet: '工程基本資料', addr: 'B7', value: 150 },   // 契約工期
      { type: 'setCell', sheet: '工程基本資料', addr: 'B8', value: 46099 }, // 開工日期(序列值)
      { type: 'setCell', sheet: '契約詳細價目表', addr: 'D2', value: 2 },   // 契約數量
      { type: 'setCell', sheet: '契約詳細價目表', addr: 'E2', value: 1000 },// 契約單價
    ]);

    const wb = XLSX.readFile(OUT, { bookVBA: true });
    const bi = wb.Sheets['工程基本資料'];
    const ct = wb.Sheets['契約詳細價目表'];

    expect(bi.B9.v).toBe(46248);        // 完工期限 = B8+B7-1 已重算
    expect(bi.B9.f).toBe('B8+B7-1');    // 公式本身仍在
    expect(ct.F2.v).toBe(2000);         // 複價 = ROUND(E2*D2,0) 已重算
    expect(!!wb.vbaraw).toBe(true);     // 巨集保留
  }, 180000);

  test('copyRowDown 把公式列擴到新列,相對參照自動調整', async () => {
    // 範本每日施工紀錄公式列僅到第 37 列;擴增後第 42 列應出現調整過的 SUM 公式。
    const before = XLSX.readFile(FIX).Sheets['每日施工紀錄'].G42;
    expect(before).toBeUndefined();     // 擴增前第 42 列無公式

    await fillTemplate(FIX, OUT, [
      { type: 'copyRowDown', sheet: '每日施工紀錄', srcRow: 2, count: 40 },
    ]);
    const g42 = XLSX.readFile(OUT).Sheets['每日施工紀錄'].G42;
    expect(g42.f).toBe('SUM($J42:$ACH42)'); // 相對列號由 2 調整到 42
  }, 180000);

  test('setRange 寫入二維區塊,含公式欄同步重算', async () => {
    await fillTemplate(FIX, OUT, [
      {
        type: 'setRange', sheet: '契約詳細價目表', startAddr: 'A2',
        values: [['甲.1', '測試項一', '式', 3, 200], ['甲.2', '測試項二', 'M', 2, 150]],
      },
    ]);
    const ct = XLSX.readFile(OUT).Sheets['契約詳細價目表'];
    expect(ct.A2.v).toBe('甲.1');
    expect(ct.F2.v).toBe(600);   // ROUND(200*3,0)
    expect(ct.F3.v).toBe(300);   // ROUND(150*2,0)
  }, 180000);
});
