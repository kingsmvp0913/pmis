const path = require('path');
const fs = require('fs');
const { collapseCjkSpaces, WINDOWS_WIDTHS, defaultWidths, activeEngine } = require('../server/ocr');
const paddle = require('../server/ocr/paddle-engine');
const { S2T, toTraditional } = require('../server/ocr/variants');

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

// 後備引擎(Windows OCR)才跑兩個解析度取聯集;那是在補它「每份文件最佳解析度
// 不同」的不穩定,不是普遍有效的手段。寫成測試以免有人「順手」加第三個。
test('Windows 後備引擎跑兩個解析度', () => {
  expect(WINDOWS_WIDTHS).toEqual([2200, 3400]);
});

// PP-OCRv5 下聯集實測增益為 0(3400 單跑 181、3400+2200 也是 181),而且把較差的
// 2200 排前面會讓「先命中者保留」蓋掉正確答案(181→179)。所以它只跑一個。
test('PP-OCRv5 只跑一個解析度', () => {
  expect(paddle.DEFAULT_WIDTH).toBe(3400);
  if (paddle.isAvailable()) expect(defaultWidths()).toEqual([3400]);
  else expect(defaultWidths()).toEqual(WINDOWS_WIDTHS);
});

test('引擎選擇與可用性一致', () => {
  expect(activeEngine()).toBe(paddle.isAvailable() ? 'paddle' : 'windows');
});

// PP-OCR 的中文模型簡繁共用一套字典,對繁體文件會零星吐簡體字形(24 份實測
// 编 11 次、额 9 次、国 4 次、贰 1 次)。一個字就足以讓整欄抽不到。
describe('簡體字形吸附', () => {
  test('實測撞到的字', () => {
    expect(toTraditional('契約金额')).toBe('契約金額');
    expect(toTraditional('契約编號')).toBe('契約編號');
    expect(toTraditional('橋頭国民小学')).toBe('橋頭國民小學');
    expect(toTraditional('贰佰捌拾壹萬')).toBe('貳佰捌拾壹萬');
  });
  // 一對多的字收進來會製造「看起來合理的錯字」,比不轉換更糟。
  test('歧義字一律不碰', () => {
    for (const ch of ['复', '表', '里', '面', '干', '后', '发', '松', '只', '谷', '历', '钟', '志', '板', '台']) {
      expect(S2T[ch]).toBeUndefined();
    }
    expect(toTraditional('複價 報表 公里')).toBe('複價 報表 公里');
  });
  test('查不到的字原樣通過', () => expect(toTraditional('工程名稱ABC123')).toBe('工程名稱ABC123'));
  test('空值', () => expect(toTraditional(null)).toBe(''));
});

// driver 必須是純 ASCII:中文寫進 .ps1 需要 BOM,漏了就是亂碼
// (見 memory xlsm-excel-com-findings)。沿用 excel-com-driver.ps1 的既有約定。
test('driver 存在且為純 ASCII', () => {
  const p = path.join(__dirname, '../server/ocr/ocr-driver.ps1');
  expect(fs.existsSync(p)).toBe(true);
  expect(fs.readFileSync(p).every((b) => b < 128)).toBe(true);
});
