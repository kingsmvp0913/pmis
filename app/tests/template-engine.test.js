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
