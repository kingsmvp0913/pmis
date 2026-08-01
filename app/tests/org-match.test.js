const { normalizeOrgName, extractCounty, findByName, COUNTIES } = require('../server/org-match');

describe('normalizeOrgName', () => {
  // 同一份決標公告內即混用臺/台(雲林縣台西國中 vs 雲林縣立臺西國民中學)。
  // 不正規化的話,比對出來的「不符」全是假的,承辦人會被迫去請廠商修正正確的文件。
  test('臺一律正規化為台', () => {
    expect(normalizeOrgName('臺中市西區大勇國民小學')).toBe('台中市西區大勇國民小學');
    expect(normalizeOrgName('雲林縣立臺西國民中學')).toBe('雲林縣立台西國民中學');
  });

  // 決標公告的值來自 PDF 抽取,常挾帶全形空白與前後空白。
  test('移除所有空白(含全形)並轉半形', () => {
    expect(normalizeOrgName(' 晉林 土木　包工業 ')).toBe('晉林土木包工業');
    expect(normalizeOrgName('ＡＢＣ營造')).toBe('ABC營造');
  });

  // 這條規則涵蓋的是「OCR 把半形連字號誤讀成西式破折號」的情境,與下面「一」
  // 的正規化是兩起不同的實測案例(見 org-match.js 的註解)——**不是**元長國小
  // 那份文件的真正成因,這裡只驗證 em/en dash 本身收斂成半形連字號的行為。
  test('破折號(em/en dash)正規化為半形連字號,不影響其餘內容', () => {
    expect(normalizeOrgName('A—B工程')).toBe('A-B工程');
    expect(normalizeOrgName('A–B工程')).toBe('A-B工程');
  });

  // 純粹驗證正則本身的邊界行為(無空白的最小案例),不代表真實 OCR 資料形狀——
  // 真正的元長案例(含空白)在下一支測試,直接引用 kickoff-report.test.js 釘住
  // 的真實值,這裡只是先確認「數字-一-數字」這個最小 pattern 本身會轉換。
  test('「一」緊鄰在兩個阿拉伯數字之間時正規化為連字號(regex 最小案例)', () => {
    expect(normalizeOrgName('114一116')).toBe('114-116');
  });

  // 元長國小的真實案例:字串**直接引用**
  // app/tests/kickoff-report.test.js:239 對 extractFields 的斷言值,不是另外
  // 憑印象或截圖手打一份——這是 repo 裡唯一被釘住的真值來源,兩邊若不同步
  // 需要一併更新。真實 OCR 輸出本身含空白與全形括號,「一」與前後數字之間
  // 也夾著空白(是「114 一 116」不是「114一116」)。上一輪把正規化規則放在
  // 去空白**之前**,導致真實資料完全比對不到,用無空白的簡化字串測不出這個
  // 順序 bug——這支測試就是為了擋住同一個順序問題再次發生。
  test('元長國小真實案例(引用 kickoff-report.test.js:239 的真值):正規化後與決標公告相等', () => {
    const 開工報告表值 = '元長國小辦理 「 114 一 116 年公立國民中小學老舊廁所整修工程計畫 」';
    const 決標公告值 = '元長國小辦理「114-116年公立國民中小學老舊廁所整修工程計畫」';
    expect(normalizeOrgName(開工報告表值)).toBe(normalizeOrgName(決標公告值));
  });

  // 中文數字「一」是合法中文字(「第一期工程」「一號橋」),範圍必須嚴格限縮在
  // 「前後都是阿拉伯數字」——這幾支測試是這條規則能不能存在的前提,任何一支被
  // 改壞都代表限縮條件被放寬了,必須擋下來。含空白版本專門用來釘住上面的
  // 順序問題:去空白之後才判斷前後字元,「第 一 期 工程」去空白得「第一期工程」,
  // 前面仍是「第」不是數字,依然不得轉換。
  test('「一」不在兩個阿拉伯數字之間時不得改動(含去空白後的情況)', () => {
    expect(normalizeOrgName('第一期工程')).toBe('第一期工程'); // 前面是「第」,不是數字
    expect(normalizeOrgName('一號橋改建工程')).toBe('一號橋改建工程'); // 在字串開頭,前面沒有數字
    expect(normalizeOrgName('114一')).toBe('114一'); // 後面沒有數字(字串結尾)
    expect(normalizeOrgName('一期')).toBe('一期'); // 前後都不是數字
    expect(normalizeOrgName('第 一 期 工程')).toBe('第一期工程'); // 去空白後前面仍是「第」
    expect(normalizeOrgName('一 號 橋')).toBe('一號橋'); // 去空白後仍在字串開頭
  });

  // 限縮條件是「前後都要是數字」,上面那支測試只釘住了「前面非數字」的情況——
  // 若有人把條件鬆成 /一(?=\d)/(只要求後面是數字,不管前面),上面那支測試
  // 全部不會紅(因為裡面沒有任何「一的前面非數字、後面卻緊接數字」的案例)。
  // 這支測試專門補這個缺口。
  test('「一」前面不是數字、後面緊接數字時仍不得改動(限縮條件的另一半)', () => {
    expect(normalizeOrgName('一2工程')).toBe('一2工程');
    expect(normalizeOrgName('雲林縣一3標案')).toBe('雲林縣一3標案');
  });

  // 連續多個「數字-一-數字」的行為釘住,避免日後改動時在邊界條件上悄悄漂走。
  test('連續多個「一」介於數字之間時逐一轉換', () => {
    expect(normalizeOrgName('1一2一3')).toBe('1-2-3');
  });

  test('空值回 null,不回空字串', () => {
    expect(normalizeOrgName('')).toBeNull();
    expect(normalizeOrgName('   ')).toBeNull();
    expect(normalizeOrgName(null)).toBeNull();
    expect(normalizeOrgName(undefined)).toBeNull();
  });
});

describe('extractCounty', () => {
  // schools.county 供篩選與顯示;抽錯不會壞資料,但會讓學校列表分類錯亂。
  test('從機關全名開頭抽出縣市', () => {
    expect(extractCounty('雲林縣北港鎮南陽國民小學')).toBe('雲林縣');
    expect(extractCounty('雲林縣立古坑國民中小學')).toBe('雲林縣');
    expect(extractCounty('嘉義縣立東榮國民中學')).toBe('嘉義縣');
  });

  // 臺中市必須先正規化才比得到 COUNTIES 裡的「台中市」。
  test('臺中市可抽出(正規化後)', () => {
    expect(extractCounty('臺中市西區大勇國民小學')).toBe('台中市');
  });

  test('抽不到回 null,不猜測', () => {
    expect(extractCounty('某某國民小學')).toBeNull();
    expect(extractCounty('')).toBeNull();
    expect(extractCounty(null)).toBeNull();
  });
});

describe('findByName', () => {
  const list = [
    { id: 1, name: '晉林土木包工業' },
    { id: 2, name: '展翔營造股份有限公司' },
  ];

  test('正規化後逐字相等才算命中', () => {
    expect(findByName(list, ' 晉林土木包工業 ')).toEqual({ id: 1, name: '晉林土木包工業' });
  });

  // 模糊比對會綁錯廠商,而錯誤會一路污染監造報表與後續所有 SP;
  // 多按一次「建立」的成本遠低於綁錯。這條測試存在就是為了擋住日後有人加模糊比對。
  test('部分相符不算命中——禁止模糊比對', () => {
    expect(findByName(list, '晉林土木')).toBeNull();
    expect(findByName(list, '展翔營造')).toBeNull();
    expect(findByName(list, '晉林土木包工業有限公司')).toBeNull();
  });

  test('空名稱或空清單回 null', () => {
    expect(findByName(list, '')).toBeNull();
    expect(findByName([], '晉林土木包工業')).toBeNull();
    expect(findByName(null, '晉林土木包工業')).toBeNull();
  });

  // 「一」正規化為連字號是為了修 OCR 誤讀,不能反過來讓兩家名稱不同、只是
  // 剛好都在數字之間出現「一」與「-」的廠商被誤判成同一家——那種錯誤會
  // 一路污染監造報表與後續所有 SP,比多按一次「建立」貴得多。
  test('「一」的正規化不弱化逐字比對——不同廠商不會被誤判成同一家', () => {
    const 分包商清單 = [
      { id: 10, name: '114一116年營造有限公司' },
      { id: 11, name: '117一119年營造有限公司' },
    ];
    // 用決標公告常見的連字號寫法查詢,各自只命中數字區間真正相符的那一家
    expect(findByName(分包商清單, '114-116年營造有限公司')).toEqual(
      { id: 10, name: '114一116年營造有限公司' }
    );
    expect(findByName(分包商清單, '117-119年營造有限公司')).toEqual(
      { id: 11, name: '117一119年營造有限公司' }
    );
    // 區間對不上的兩家絕不會被混在一起
    expect(findByName(分包商清單, '114-119年營造有限公司')).toBeNull();
  });
});

describe('COUNTIES', () => {
  // 與前端 schools.js 的下拉共用同一份語意;數量對不上代表其中一邊漏改。
  test('22 個縣市', () => {
    expect(COUNTIES).toHaveLength(22);
    expect(COUNTIES).toContain('雲林縣');
  });
});
