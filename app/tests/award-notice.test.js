const {
  flattenRows, firstValue, parseAmount, parseDirectFields,
} = require('../server/award-notice');

describe('flattenRows / firstValue — 跨頁攤平與錨點查找', () => {
  test('多頁攤平成單一列陣列,保持原順序', () => {
    const pages = [
      { page: 1, rows: [{ label: '標案案號', value: 'A1150608' }] },
      { page: 2, rows: [{ label: '機關名稱', value: '雲林縣莿桐鄉大美國民小學' }] },
    ];
    expect(flattenRows(pages)).toEqual([
      { label: '標案案號', value: 'A1150608' },
      { label: '機關名稱', value: '雲林縣莿桐鄉大美國民小學' },
    ]);
  });

  test('只取有值的那一列', () => {
    // 標籤過長會換行,續行同樣是「標案名稱」但無值;取到空字串會讓該欄變空
    const rows = [
      { label: '標案名稱', value: '' },
      { label: '標案名稱', value: '114年大美國小老舊廁所整修工程' },
    ];
    expect(firstValue(rows, '標案名稱')).toBe('114年大美國小老舊廁所整修工程');
  });

  test('找不到標籤回 null(不回空字串,以免與「有值但為空」混淆)', () => {
    expect(firstValue([{ label: 'X', value: 'Y' }], '標案名稱')).toBe(null);
  });
});

describe('parseAmount — 金額字串轉數字', () => {
  test('去千分位與「元」', () => {
    expect(parseAmount('3,122,168元')).toBe(3122168);
    expect(parseAmount('478,372元')).toBe(478372);
  });

  test('不是金額格式回 null(決標公告同頁有大寫國字金額,不得誤抓)', () => {
    expect(parseAmount('參佰壹拾貳萬貳仟壹佰陸拾捌元')).toBe(null);
    expect(parseAmount(null)).toBe(null);
    expect(parseAmount('')).toBe(null);
  });
});

describe('parseDirectFields — 標籤與值同列的 4 個錨點', () => {
  const rows = [
    { label: '機關名稱', value: '雲林縣北港鎮南陽國民小學' },
    { label: '單位名稱', value: '雲林縣北港鎮南陽國民小學' },
    { label: '標案案號', value: '1150113' },
    { label: '標案名稱', value: '114年南陽國小北棟教室廁所整修工程' },
    { label: '總決標金額', value: '3,122,168元' },
  ];

  test('抽出 4 值', () => {
    expect(parseDirectFields(rows)).toEqual({
      工程名稱: '114年南陽國小北棟教室廁所整修工程',
      主辦機關: '雲林縣北港鎮南陽國民小學',
      工程編號: '1150113',
      契約金額: 3122168,
    });
  });

  test('缺哪欄該欄就是 null,其餘照抽(不整份放棄)', () => {
    const partial = rows.filter((r) => r.label !== '標案案號');
    const out = parseDirectFields(partial);
    expect(out.工程編號).toBe(null);
    expect(out.工程名稱).toBe('114年南陽國小北棟教室廁所整修工程');
  });

  test('工程編號照抄,不得做格式驗證或推導', () => {
    // 實測案號格式各機關自訂:1150113 / A1150608 / TKPS-A1150603 / ywjh11504 / 114-17
    for (const no of ['A1150608', 'TKPS-A1150603', 'DRJH-1140923', 'ywjh11504', '114-17']) {
      expect(parseDirectFields([{ label: '標案案號', value: no }]).工程編號).toBe(no);
    }
  });
});
