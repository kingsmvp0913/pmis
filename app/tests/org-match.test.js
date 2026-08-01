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
});

describe('COUNTIES', () => {
  // 與前端 schools.js 的下拉共用同一份語意;數量對不上代表其中一邊漏改。
  test('22 個縣市', () => {
    expect(COUNTIES).toHaveLength(22);
    expect(COUNTIES).toContain('雲林縣');
  });
});
