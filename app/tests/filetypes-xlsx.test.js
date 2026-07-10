const { gridFromWorksheet } = require('../server/parsers/filetypes/xlsx');

describe('gridFromWorksheet 錯誤格處理', () => {
  test("error cell(t==='e',如 #REF!/#VALUE!)轉 null,不讓錯誤代碼偽裝成數字", () => {
    // SheetJS 對 error cell 的 .v 是錯誤代碼數字(#REF!→23、#VALUE!→15、#DIV/0!→7)
    const ws = {
      '!ref': 'A1:C1',
      A1: { t: 'n', v: 35 },              // 正常數字
      B1: { t: 'e', v: 23, w: '#REF!' },  // 錯誤格 → 應為 null
      C1: { t: 'e', v: 15, w: '#VALUE!' },// 錯誤格 → 應為 null
    };
    const grid = gridFromWorksheet(ws);
    expect(grid[0][0]).toBe(35);
    expect(grid[0][1]).toBeNull();
    expect(grid[0][2]).toBeNull();
  });

  test('合併儲存格起點值填滿整個合併區', () => {
    const ws = {
      '!ref': 'A1:C1',
      A1: { t: 'n', v: 599 },
      '!merges': [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }],
    };
    const grid = gridFromWorksheet(ws);
    expect(grid[0][0]).toBe(599);
    expect(grid[0][1]).toBe(599);
    expect(grid[0][2]).toBe(599);
  });
});
