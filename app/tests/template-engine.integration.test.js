/**
 * SP0 fillTemplate 端對端整合測試 — 需 Excel COM + Windows PowerShell 5.1。
 * 無 Excel 的環境(如 CI)請以 SP0_SKIP_EXCEL=1 略過。
 */
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { fillTemplate } = require('../server/template-engine');

const FIX = path.join(__dirname, '..', 'templates', '監造報表_空白公版範本.xlsm');
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

  // copyRowDown 是 FillDown,會**覆蓋**下方既有內容。監造報表的項目區正下方就是
  // 報表正文(二、監督…/三、查核…/簽章),覆蓋掉之後看起來只是「報表少了幾段」,
  // 不會有任何錯誤——SP2 實作時就是這樣靜默毀掉正文的。insertRowsBelow 先把下方
  // 推開再填,是那個分頁唯一能用的擴列方式。
  test('insertRowsBelow 擴列時把下方內容往下推,不覆蓋', async () => {
    const before = XLSX.readFile(FIX).Sheets['監造報表'];
    expect(String(before.A41.v)).toMatch(/^二、監督/); // 項目區下方緊接正文

    await fillTemplate(FIX, OUT, [
      { type: 'insertRowsBelow', sheet: '監造報表', srcRow: 40, count: 3 },
    ]);
    const after = XLSX.readFile(OUT).Sheets['監造報表'];
    expect(after.A41.f).toMatch(/契約詳細價目表!A33/); // 新列是複製來的公式,列號跟著位移
    expect(after.A43.f).toMatch(/契約詳細價目表!A35/);
    expect(String(after.A44.v)).toMatch(/^二、監督/);     // 正文被推到第 44 列,沒被吃掉
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

  // 範本原本用 MATCH 把項目名稱「自己查自己」再取回同一欄,而 MATCH(...,0) 對文字
  // 會啟用萬用字元、`~` 是跳脫字元 → 名稱含 `~` 的項目查不到自己,名稱欄整格 #N/A
  // (報表上就是一列沒有名稱的項目,數量卻照印)。49 案的舊資料裡有 57 對這種名稱。
  test('名稱含萬用字元(~ * ?)的項目,名稱與當日數量都不會掉', async () => {
    const 名稱 = '施做抿石子(1~2分AK石,抿石子專用泥)';
    const 開工日 = 46099;                 // Excel 序列值
    await fillTemplate(FIX, OUT, [
      { type: 'setCell', sheet: '工程基本資料', addr: 'B7', value: 150 },
      { type: 'setCell', sheet: '工程基本資料', addr: 'B8', value: 開工日 },
      { type: 'setCell', sheet: '契約詳細價目表', addr: 'A2', value: '1' },
      { type: 'setCell', sheet: '契約詳細價目表', addr: 'B2', value: 名稱 },
      { type: 'setCell', sheet: '契約詳細價目表', addr: 'C2', value: '式' },
      { type: 'setCell', sheet: '契約詳細價目表', addr: 'D2', value: 10 },
      { type: 'setCell', sheet: '契約詳細價目表', addr: 'E2', value: 1000 },
      { type: 'setCell', sheet: '每日施工紀錄', addr: 'J2', value: 3 }, // 開工日做了 3
      { type: 'setCell', sheet: '監造報表', addr: 'N8', value: 開工日 }, // 報表要印的日期
    ]);
    const wb = XLSX.readFile(OUT);
    const day = wb.Sheets['每日施工紀錄'];
    const rep = wb.Sheets['監造報表'];

    expect(day.B2.v).toBe(名稱);
    expect(rep.B10.v).toBe(名稱);
    // 監造報表的「當日數量」是唯一一條真的跨表查找(拿名稱去每日施工紀錄找列),
    // 名稱欄修好了它仍可能獨立失效,所以分開斷言。
    expect(rep.I10.v).toBe(3);

    // 沒用到的列要是**空白**——不是 0(會印出一排零),也不是 #N/A。
    //
    // 2026-08-10 規格變更:原本範本用 NA() 讓空列顯示 #N/A,而真實案子的項目數
    // (20~40)遠少於範本預留的 283 列,於是每份產出的報表都帶著上千個 #N/A
    // (饒平案實測 3038 個),與承辦人的人工報表「完全不一樣」——人工報表是把
    // 用不到的列整個清空的。改成回空字串。
    expect(day.B20.t).not.toBe('e');
    expect(day.B20.v).toBe('');
    expect(rep.B20.t).not.toBe('e');
    expect(rep.B20.v).toBe('');
  }, 180000);

  // 一份經費總表可以含兩個子工程(古坑:A 棒球場圍籬 / B 車棚),兩邊會有**同名**
  // 項目而金額不同。監造報表的「當日數量」若拿名稱查列,只會抓到第一列 —— 第二個
  // 子工程那列會靜默顯示別人的數量,報表看起來完全正常。項次才是唯一鍵。
  test('同名項目各自抓到自己的當日數量(用項次定位,不是名稱)', async () => {
    const 名稱 = '工程告示牌、職業安全衛生告示牌與管制措施(租用)';
    const 開工日 = 46099;
    await fillTemplate(FIX, OUT, [
      { type: 'setCell', sheet: '工程基本資料', addr: 'B7', value: 150 },
      { type: 'setCell', sheet: '工程基本資料', addr: 'B8', value: 開工日 },
      { type: 'setCell', sheet: '契約詳細價目表', addr: 'A2', value: 'A.壹.1' },
      { type: 'setCell', sheet: '契約詳細價目表', addr: 'B2', value: 名稱 },
      { type: 'setCell', sheet: '契約詳細價目表', addr: 'D2', value: 1 },
      { type: 'setCell', sheet: '契約詳細價目表', addr: 'E2', value: 2837 },
      { type: 'setCell', sheet: '契約詳細價目表', addr: 'A3', value: 'B.壹.1' },
      { type: 'setCell', sheet: '契約詳細價目表', addr: 'B3', value: 名稱 }, // 同名,不同子工程
      { type: 'setCell', sheet: '契約詳細價目表', addr: 'D3', value: 1 },
      { type: 'setCell', sheet: '契約詳細價目表', addr: 'E3', value: 5543 },
      { type: 'setCell', sheet: '每日施工紀錄', addr: 'J2', value: 3 },
      { type: 'setCell', sheet: '每日施工紀錄', addr: 'J3', value: 7 },
      { type: 'setCell', sheet: '監造報表', addr: 'N8', value: 開工日 },
    ]);
    const rep = XLSX.readFile(OUT).Sheets['監造報表'];
    expect(rep.I10.v).toBe(3);
    expect(rep.I11.v).toBe(7); // 用名稱查的話這裡會是 3
  }, 180000);

  // 項次寫進儲存格後多半是數值型(Excel 把 "1" 解析成 1)。若查找值被 SUBSTITUTE
  // 之類的文字函式包過,回傳一定是文字,文字 "1" 配不到數值 1,整條查找回 #N/A。
  // 這與 B 欄名稱需要跳脫的情況完全相反,所以單獨釘住。
  test('純數字項次(數值型)也查得到當日數量', async () => {
    const 開工日 = 46099;
    await fillTemplate(FIX, OUT, [
      { type: 'setCell', sheet: '工程基本資料', addr: 'B7', value: 150 },
      { type: 'setCell', sheet: '工程基本資料', addr: 'B8', value: 開工日 },
      { type: 'setCell', sheet: '契約詳細價目表', addr: 'A2', value: '1' },
      { type: 'setCell', sheet: '契約詳細價目表', addr: 'B2', value: '施工圍籬' },
      { type: 'setCell', sheet: '契約詳細價目表', addr: 'D2', value: 58 },
      { type: 'setCell', sheet: '契約詳細價目表', addr: 'E2', value: 247 },
      { type: 'setCell', sheet: '每日施工紀錄', addr: 'J2', value: 12 },
      { type: 'setCell', sheet: '監造報表', addr: 'N8', value: 開工日 },
    ]);
    const rep = XLSX.readFile(OUT).Sheets['監造報表'];
    expect(rep.I10.v).toBe(12);
  }, 180000);
});
