/**
 * 上傳既有監造報表後的「已填內容保護」。
 *
 * 使用者裁決(2026-08-10):**以上傳那一刻為界**——上傳當下已經有值的儲存格永遠
 * 不被覆蓋,上傳之後系統自己寫的,重送日誌時照樣更新。這一組測試釘的就是那條界線。
 */
const { filterOperations } = require('../server/report-protect');

const 保護 = { 每日施工紀錄: ['J2', 'K2', 'L3'], 工程基本資料: ['B1'] };

describe('filterOperations', () => {
  test('沒有保護清單時原樣放行', () => {
    const ops = [{ type: 'setCell', sheet: '工程基本資料', addr: 'B1', value: 'x' }];
    expect(filterOperations(ops, {})).toEqual(ops);
  });

  test('setCell 落在保護格就整道丟掉', () => {
    const ops = [
      { type: 'setCell', sheet: '工程基本資料', addr: 'B1', value: '新名稱' },
      { type: 'setCell', sheet: '工程基本資料', addr: 'B2', value: '監造單位' },
    ];
    const got = filterOperations(ops, 保護);
    expect(got).toHaveLength(1);
    expect(got[0].addr).toBe('B2');
  });

  // 別的分頁同名位址不該被誤擋
  test('保護只在該分頁生效', () => {
    const ops = [{ type: 'setCell', sheet: '契約詳細價目表', addr: 'B1', value: 'x' }];
    expect(filterOperations(ops, 保護)).toHaveLength(1);
  });

  // setRange 是整塊 Value2 寫入,沒有「這格不要動」的表示法,只能切段
  test('setRange 把保護格切掉,兩側各成一段', () => {
    // J2,K2,L2 三格,其中 J2、K2 受保護 → 只剩 L2
    const ops = [{ type: 'setRange', sheet: '每日施工紀錄', startAddr: 'J2', values: [[1, 2, 3]] }];
    const got = filterOperations(ops, 保護);
    expect(got).toHaveLength(1);
    expect(got[0].startAddr).toBe('L2');
    expect(got[0].values).toEqual([[3]]);
  });

  test('保護格在中間時切成前後兩段', () => {
    // J3,K3,L3;只有 L3 受保護 → 前段 J3-K3
    const ops = [{ type: 'setRange', sheet: '每日施工紀錄', startAddr: 'J3', values: [[1, 2, 3]] }];
    const got = filterOperations(ops, 保護);
    expect(got).toHaveLength(1);
    expect(got[0].startAddr).toBe('J3');
    expect(got[0].values).toEqual([[1, 2]]);
  });

  test('多列的 setRange 逐列處理,各列的段落互不影響', () => {
    const ops = [{
      type: 'setRange', sheet: '每日施工紀錄', startAddr: 'J2',
      values: [[1, 2, 3], [4, 5, 6]],   // 第一列 J2,K2,L2;第二列 J3,K3,L3
    }];
    const got = filterOperations(ops, 保護);
    // 第一列剩 L2、第二列剩 J3-K3
    expect(got.map((o) => o.startAddr)).toEqual(['L2', 'J3']);
    expect(got.map((o) => o.values)).toEqual([[[3]], [[4, 5]]]);
  });

  test('整列都被保護時不產生任何指令', () => {
    const ops = [{
      type: 'setRange', sheet: '每日施工紀錄', startAddr: 'J2', values: [[1, 2]],
    }];
    expect(filterOperations(ops, { 每日施工紀錄: ['J2', 'K2'] })).toEqual([]);
  });

  // 版面操作不是填值,擋掉它會讓後續的列位置全部錯開,比覆蓋更糟
  test('copyRowDown / insertRowsBelow 一律原樣保留', () => {
    const ops = [
      { type: 'copyRowDown', sheet: '每日施工紀錄', srcRow: 2, count: 5 },
      { type: 'insertRowsBelow', sheet: '監造報表', srcRow: 10, count: 3 },
    ];
    expect(filterOperations(ops, 保護)).toEqual(ops);
  });

  // 超過 Z 欄的位址換算錯了會保護到別欄,而且完全看不出來
  test('雙字母欄位的位址要算對', () => {
    const ops = [{ type: 'setRange', sheet: '每日施工紀錄', startAddr: 'Y2', values: [[1, 2, 3, 4]] }];
    // Y2,Z2,AA2,AB2 → 保護 AA2
    const got = filterOperations(ops, { 每日施工紀錄: ['AA2'] });
    expect(got.map((o) => o.startAddr)).toEqual(['Y2', 'AB2']);
    expect(got.map((o) => o.values)).toEqual([[[1, 2]], [[4]]]);
  });
});

describe('scanFilledCells', () => {
  const fs = require('fs');
  const path = require('path');
  const XLSX = require('xlsx');
  const { scanFilledCells } = require('../server/report-protect');
  const 範本 = path.join(__dirname, '..', 'templates', '監造報表_空白公版範本.xlsm');

  // ⚠️ 這一條是踩過才知道的:第一版把公式格也當成「已填」,掃公版範本掃出 6387 格
  // (光每日施工紀錄的公式就有 6074 個——第 1 列日期公式鋪到 ACH、合計列、
  // 第 33 列自己 506 個)。那會讓 SP3 之後**寫不進去而且完全看不出來**:
  // 承辦人看到「已寫入」的成功訊息,報表卻什麼都沒變。
  test('公式格不算已填,否則整個功能會靜默失效', () => {
    if (!fs.existsSync(範本)) return;
    const filled = scanFilledCells(範本);
    const 每日 = filled['每日施工紀錄'] || [];
    // 範本的每日施工紀錄公式極多,而承辦人「填過」的格應該屈指可數
    expect(每日.length).toBeLessThan(100);

    // 明確驗一個已知的公式格沒有被收進去
    const wb = XLSX.readFile(範本, { sheets: ['每日施工紀錄'] });
    const ws = wb.Sheets['每日施工紀錄'];
    const 某公式格 = Object.keys(ws).find((k) => !k.startsWith('!') && ws[k] && ws[k].f);
    expect(某公式格).toBeTruthy();
    expect(每日).not.toContain(某公式格);
  });

  // 掃描範圍必須**恰好**等於系統會寫入的分頁集合,兩邊都會出事:
  // 少一個 → 那個分頁完全沒保護,承辦人上傳的既有內容被直接蓋掉而且沒有徵兆;
  // 多一個 → 清單變大、比對變慢,而且保護了根本不會被寫的東西。
  // 「監造內容」是 2026-08-11 才進來的(SP3 把施工日誌的天氣寫進它的 C/D 欄)。
  test('掃描範圍恰好等於系統會寫入的分頁', () => {
    if (!fs.existsSync(範本)) return;
    const 會寫入的分頁 = ['工程基本資料', '契約詳細價目表', '監造報表', '每日施工紀錄', '監造內容'];
    expect(Object.keys(scanFilledCells(範本)).sort()).toEqual(會寫入的分頁.sort());
  });
});
