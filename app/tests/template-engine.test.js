const { buildJob, fillTemplate } = require('../server/template-engine');

describe('buildJob 操作驗證(純函式,不碰 Excel)', () => {
  const ops = [{ type: 'setCell', sheet: '工程基本資料', addr: 'B1', value: '甲工程' }];

  test('範本非 .xlsm 應丟錯(保巨集只支援 macro-enabled 活頁簿)', () => {
    expect(() => buildJob('template.xlsx', 'out.xlsm', ops))
      .toThrow(/\.xlsm/);
  });

  test('輸出非 .xlsm 應丟錯(存回仍須保巨集)', () => {
    expect(() => buildJob('template.xlsm', 'out.xlsx', ops))
      .toThrow(/\.xlsm/);
  });

  test('operations 非陣列或空應丟錯(沒東西可寫)', () => {
    expect(() => buildJob('t.xlsm', 'o.xlsm', [])).toThrow(/operations/);
    expect(() => buildJob('t.xlsm', 'o.xlsm', null)).toThrow(/operations/);
  });

  test('未知 operation type 應丟錯', () => {
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ type: 'setFont', sheet: 'x', addr: 'A1' }]))
      .toThrow(/setFont/);
  });

  test('setCell 缺 sheet 或 addr 應丟錯', () => {
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ type: 'setCell', addr: 'A1', value: 1 }]))
      .toThrow(/sheet/);
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ type: 'setCell', sheet: 'x', value: 1 }]))
      .toThrow(/addr/);
  });

  test('setRange 缺 startAddr 或 values 非二維陣列應丟錯', () => {
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ type: 'setRange', sheet: 'x', values: [[1]] }]))
      .toThrow(/startAddr/);
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ type: 'setRange', sheet: 'x', startAddr: 'A2', values: [1, 2] }]))
      .toThrow(/values/);
  });

  test('copyRowDown 的 srcRow/count 須為正整數', () => {
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ type: 'copyRowDown', sheet: 'x', srcRow: 0, count: 3 }]))
      .toThrow(/srcRow/);
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ type: 'copyRowDown', sheet: 'x', srcRow: 2, count: 0 }]))
      .toThrow(/count/);
  });

  // 刪列不可逆——公式跟著整列消失。startRow 少驗一次就可能刪掉報表正文,
  // 而刪掉的正文不會有任何錯誤訊息,只是報表少了幾段。
  test('deleteRows 的 startRow/count 須為正整數', () => {
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ type: 'deleteRows', sheet: 'x', startRow: 0, count: 3 }]))
      .toThrow(/startRow/);
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ type: 'deleteRows', sheet: 'x', startRow: 35, count: 0 }]))
      .toThrow(/count/);
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ type: 'deleteRows', startRow: 35, count: 3 }]))
      .toThrow(/sheet/);
  });

  // 契約數量欄是固定寬度但數量不是:2,600.00 放不下,Excel 印 ########。
  // 值是對的,逐格比對永遠看不到——要把報表印出來才看得見。
  test('autoFitColumns 的 cols 須為欄名陣列', () => {
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ type: 'autoFitColumns', sheet: 'x', cols: [] }]))
      .toThrow(/cols/);
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ type: 'autoFitColumns', sheet: 'x', cols: ['H1'] }]))
      .toThrow(/cols/);
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ type: 'autoFitColumns', sheet: 'x', cols: 'H' }]))
      .toThrow(/cols/);
    expect(buildJob('t.xlsm', 'o.xlsm', [{ type: 'autoFitColumns', sheet: 'x', cols: ['H', 'AA'] }])
      .operations).toHaveLength(1);
  });

  test('合法操作回傳正規化 job', () => {
    const job = buildJob('t.xlsm', 'o.xlsm', ops);
    expect(job).toEqual({ templatePath: 't.xlsm', outPath: 'o.xlsm', operations: ops });
  });
});

describe('fillTemplate 前置檢查(不啟 Excel)', () => {
  test('範本不存在應 reject(不浪費開 Excel)', async () => {
    await expect(
      fillTemplate('no-such-template.xlsm', 'out.xlsm',
        [{ type: 'setCell', sheet: 'x', addr: 'A1', value: 1 }])
    ).rejects.toThrow(/範本不存在/);
  });
});

// setRowFill:費用列底色(見 contract-items 的 費用列底色)。
// 參數驗證要嚴,壞值往下走會變成 driver 裡 Convert.ToInt32 的 COM 例外,
// 而那條路徑的訊息對承辦人完全沒有意義。
describe('setRowFill 參數驗證', () => {
  const ok = { type: 'setRowFill', sheet: '每日施工紀錄', firstRow: 30, lastRow: 34, firstCol: 1, lastCol: 604, fill: 'E2F0D9' };
  test('合法參數通過', () => {
    expect(() => buildJob('t.xlsm', 'o.xlsm', [ok])).not.toThrow();
  });

  test('setFormula 只接受以 = 開頭的公式', () => {
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ type: 'setFormula', sheet: 'x', addr: 'A1', formula: 'SUM(A1:A2)' }]))
      .toThrow(/formula/);
    expect(buildJob('t.xlsm', 'o.xlsm', [{ type: 'setFormula', sheet: 'x', addr: 'A1', formula: '=SUM(A1:A2)' }])
      .operations).toHaveLength(1);
  });
  test('fill 為 null 代表清除,合法', () => {
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ ...ok, fill: null }])).not.toThrow();
  });
  test('fill 不是 RRGGBB 要擋下', () => {
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ ...ok, fill: 'green' }])).toThrow(/RRGGBB/);
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ ...ok, fill: '#E2F0D9' }])).toThrow(/RRGGBB/);
  });
  test('lastRow 小於 firstRow 要擋下', () => {
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ ...ok, firstRow: 34, lastRow: 30 }])).toThrow(/firstRow/);
  });
  test('lastCol 小於 firstCol 要擋下', () => {
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ ...ok, firstCol: 9, lastCol: 1 }])).toThrow(/firstCol/);
  });
  test('列號非正整數要擋下', () => {
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ ...ok, firstRow: 0 }])).toThrow(/firstRow/);
  });
});

describe('setNumberFormat 參數驗證', () => {
  const ok = { type: 'setNumberFormat', sheet: '每日施工紀錄', firstRow: 30, lastRow: 34, firstCol: 7, lastCol: 7, format: '0.0000' };
  test('合法參數通過', () => {
    expect(() => buildJob('t.xlsm', 'o.xlsm', [ok])).not.toThrow();
  });
  // 空字串會被 Excel 當成清掉格式(變 General),那不是任何呼叫端想要的
  test('format 為空字串或非字串要擋下', () => {
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ ...ok, format: '' }])).toThrow(/format/);
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ ...ok, format: 3 }])).toThrow(/format/);
  });
  test('列/欄範圍顛倒要擋下', () => {
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ ...ok, firstRow: 34, lastRow: 30 }])).toThrow(/firstRow/);
    expect(() => buildJob('t.xlsm', 'o.xlsm', [{ ...ok, firstCol: 8, lastCol: 7 }])).toThrow(/firstCol/);
  });
});
