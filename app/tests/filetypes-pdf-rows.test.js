const { rowsFromItems } = require('../server/parsers/filetypes/pdf');

describe('rowsFromItems — 決標公告兩欄表座標分欄(純函式)', () => {
  test('區塊名直排字(x<45)不得混進標籤欄', () => {
    // 決標公告左緣有「機/關/資/料」直排字,混進去會讓標籤變「機機關名稱」而永遠抓不到
    const items = [
      { x: 31, y: 708, s: '機' },
      { x: 49, y: 708, s: '機關名稱' },
      { x: 166, y: 708, s: '雲林縣北港鎮南陽國民小學' },
    ];
    expect(rowsFromItems(items)).toEqual([
      { label: '機關名稱', value: '雲林縣北港鎮南陽國民小學' },
    ]);
  });

  test('同一列的標籤與值 y 可差 1~3px,須容差合併', () => {
    // 實測「決標方式」標籤 y=415、值 y=413;不容差就永遠配不到值
    const items = [
      { x: 49, y: 415, s: '決標方式' },
      { x: 169, y: 413, s: '最有利標' },
    ];
    expect(rowsFromItems(items)).toEqual([{ label: '決標方式', value: '最有利標' }]);
  });

  test('同列多個 item 依 x 由左到右接合,不依原始順序', () => {
    // 東榮案號被拆成 'DR' + 'JH-1140923' 兩個 item,順序不保證
    const items = [
      { x: 49, y: 513, s: '標案案號' },
      { x: 186, y: 513, s: 'JH-1140923' },
      { x: 169, y: 513, s: 'DR' },
    ];
    expect(rowsFromItems(items)).toEqual([{ label: '標案案號', value: 'DRJH-1140923' }]);
  });

  test('列序為由上而下(y 大者在前)', () => {
    const items = [
      { x: 49, y: 100, s: '下面那列' },
      { x: 49, y: 700, s: '上面那列' },
    ];
    expect(rowsFromItems(items).map((r) => r.label)).toEqual(['上面那列', '下面那列']);
  });

  test('純空白 item 略過,不產生空欄干擾', () => {
    const items = [
      { x: 49, y: 100, s: '   ' },
      { x: 166, y: 100, s: '有值' },
    ];
    expect(rowsFromItems(items)).toEqual([{ label: '', value: '有值' }]);
  });

  test('整列所有 item 皆為空白 → 該列完全不輸出(而非輸出一列空字串)', () => {
    // 上一個測試就算把「略過空白 item」那行整個刪掉也會通過——因為 join() 結尾有
    // .trim(),就算空白 item 沒被跳過,拼接後一樣是 ''。這個測試才會真的因為那行
    // 被刪而變紅:少了 skip,空白 item 仍會被塞進 bucket,產生一列 {label:'',value:''}
    // 而非「該列消失」,污染下游以列數判斷是否有資料的邏輯。
    const items = [
      { x: 49, y: 100, s: '   ' },
      { x: 166, y: 100, s: '  ' },
    ];
    expect(rowsFromItems(items)).toEqual([]);
  });

  test('全形數字等相容字元做 NFKC 正規化', () => {
    // 部分 PDF 字型把字元映到相容區,不正規化下游錨點比對會落空
    const items = [
      { x: 49, y: 100, s: '標案案號' },
      { x: 166, y: 100, s: '１１５０１１３' },
    ];
    expect(rowsFromItems(items)[0].value).toBe('1150113');
  });
});
