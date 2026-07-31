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

describe('rowsFromItems — CJK 部首補充區誤映還原(決標公告字型缺陷)', () => {
  // 用碼位跳脫(\uXXXX)而非直接貼字元:直接貼字元的話,檔案編碼一變(或編輯器
  // 自動正規化)差異就會消失,測試會失去意義、看不出還原是否真的發生。
  const BAD_MIN = '\u2EA0'; // 民 的部首補充區誤映
  const BAD_CHANG = '\u2ED1'; // 長 的部首補充區誤映
  const BAD_XI = '\u2EC4'; // 西 的部首補充區誤映
  const GOOD_MIN = '\u6C11'; // 民
  const GOOD_CHANG = '\u9577'; // 長
  const GOOD_XI = '\u897F'; // 西

  test('民/長/西 誤映到部首補充區需還原,否則與主檔(schools.name/projects.name)逐字比對每次都會誤判不一致', () => {
    // 28 份決標公告樣本實測:PDF 字型把「民」「長」「西」映到 CJK 部首補充區
    // (U+2EA0/U+2ED1/U+2EC4),NFKC 對這個區塊沒有相容分解(它只還原得了
    // U+F9xx 相容漢字),不額外還原的話,「國民小學」「元長鄉」等字下游與
    // 專案主檔逐字比對會每次都誤判成不一致,硬擋機制形同虛設。
    const items = [
      { x: 49, y: 100, s: '機關名稱' },
      { x: 166, y: 100, s: `雲林縣元${BAD_CHANG}鄉仁德國${BAD_MIN}小學(${BAD_XI}棟)` },
    ];
    expect(rowsFromItems(items)[0].value).toBe(`雲林縣元${GOOD_CHANG}鄉仁德國${GOOD_MIN}小學(${GOOD_XI}棟)`);
  });

  test('標準碼位的民/長/西不得被誤改(對映表只還原問題碼位,不得動到正常字)', () => {
    const items = [
      { x: 49, y: 100, s: '工程名稱' },
      { x: 166, y: 100, s: `雲林縣元${GOOD_CHANG}鄉仁德國${GOOD_MIN}小學(${GOOD_XI}棟)` },
    ];
    expect(rowsFromItems(items)[0].value).toBe(`雲林縣元${GOOD_CHANG}鄉仁德國${GOOD_MIN}小學(${GOOD_XI}棟)`);
  });
});
