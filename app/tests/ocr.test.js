const path = require('path');
const fs = require('fs');
const { collapseCjkSpaces, DEFAULT_WIDTHS } = require('../server/ocr');

// Windows OCR 對中文會逐字插空格,不清掉的話所有標籤都比不中。
describe('collapseCjkSpaces', () => {
  test('中文字之間的空格清掉', () => {
    expect(collapseCjkSpaces('工 程 名 稱')).toBe('工程名稱');
    expect(collapseCjkSpaces('雲 林 縣 北 港 鎮')).toBe('雲林縣北港鎮');
  });
  // 數字之間的空白必須留著:'115 06 16' 清成 '1150616' 會讓日期解析錯位
  test('數字之間的空格保留', () => expect(collapseCjkSpaces('115 06 16')).toBe('115 06 16'));
  // 中文與數字交界也保留,以免破壞數字邊界
  test('中文與數字交界保留', () => {
    expect(collapseCjkSpaces('契約規定工期 150 日曆天')).toBe('契約規定工期 150 日曆天');
  });
  test('空值', () => expect(collapseCjkSpaces('')).toBe(''));
});

// 兩個解析度是 spec §3.5 的實測結論:2200+3400 取聯集 72%→77%,
// 加第三個增益為 0 但成本多 50%。寫成測試以免日後有人「順手」加一個。
test('預設只跑兩個解析度', () => {
  expect(DEFAULT_WIDTHS).toEqual([2200, 3400]);
});

// driver 必須是純 ASCII:中文寫進 .ps1 需要 BOM,漏了就是亂碼
// (見 memory xlsm-excel-com-findings)。沿用 excel-com-driver.ps1 的既有約定。
test('driver 存在且為純 ASCII', () => {
  const p = path.join(__dirname, '../server/ocr/ocr-driver.ps1');
  expect(fs.existsSync(p)).toBe(true);
  expect(fs.readFileSync(p).every((b) => b < 128)).toBe(true);
});
