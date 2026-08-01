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

  // 元長國小實測(用 readKickoffReport 印出真實碼位才確認,截圖用肉眼判讀會誤判):
  // OCR 把開工報告表上「114-116年」的半形連字號讀成中文數字「一」,變成
  // 「114一116年」,與決標公告的「114-116年」逐字比對判成不符——這不是破折號
  // 誤讀,是「一」被 OCR 誤認,兩者在畫面截圖上幾乎分辨不出來,故上面 em/en dash
  // 那條規則救不到這個案例,需要另一條規則。
  test('「一」在兩個阿拉伯數字之間正規化為連字號(元長國小實測案例)', () => {
    const 開工報告表值 = '元長國小辦理「114一116年公立國民中小學老舊廁所整修工程計畫」';
    const 決標公告值 = '元長國小辦理「114-116年公立國民中小學老舊廁所整修工程計畫」';
    expect(normalizeOrgName(開工報告表值)).toBe(normalizeOrgName(決標公告值));
    expect(normalizeOrgName('114一116')).toBe('114-116');
  });

  // 中文數字「一」是合法中文字(「第一期工程」「一號橋」),範圍必須嚴格限縮在
  // 「前後都是阿拉伯數字」——這幾支測試是這條規則能不能存在的前提,任何一支被
  // 改壞都代表限縮條件被放寬了,必須擋下來。
  test('「一」不在兩個阿拉伯數字之間時不得改動', () => {
    expect(normalizeOrgName('第一期工程')).toBe('第一期工程'); // 前面是「第」,不是數字
    expect(normalizeOrgName('一號橋改建工程')).toBe('一號橋改建工程'); // 在字串開頭,前面沒有數字
    expect(normalizeOrgName('114一')).toBe('114一'); // 後面沒有數字(字串結尾)
    expect(normalizeOrgName('一期')).toBe('一期'); // 前後都不是數字
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
