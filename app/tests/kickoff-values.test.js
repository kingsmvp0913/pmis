const { rocToISO, cnNumToNumber, parseMoney, parseDuration, deriveDuration } = require('../server/kickoff-values');

// 決標公告是 115/06/16,開工報告表是「中華民國115年6月16日」。
// 兩種寫法必須落到同一個值,否則決標日這欄永遠判不符。
describe('rocToISO', () => {
  test('斜線式', () => expect(rocToISO('115/06/16')).toBe('2026-06-16'));
  test('個位數月日不補零也要吃', () => expect(rocToISO('115/6/3')).toBe('2026-06-03'));
  test('中文年月日', () => expect(rocToISO('中華民國115年6月16日')).toBe('2026-06-16'));
  test('OCR 逐字空格後的中文年月日', () => expect(rocToISO('115 年 6 月 16 日')).toBe('2026-06-16'));
  // 民國 0 年不存在;三位數以上年份是 OCR 讀錯(如 1150 年),不得編造日期
  test('非法值回 null 不編造', () => {
    expect(rocToISO('0/6/16')).toBeNull();
    expect(rocToISO('_J50_')).toBeNull();
    expect(rocToISO(null)).toBeNull();
  });
  // 2 月 30 日必須擋掉:JS Date 會自動滾到 3 月 2 日,靜默產生一個錯日期
  test('日曆上不存在的日期回 null', () => expect(rocToISO('115/2/30')).toBeNull());
});

describe('cnNumToNumber', () => {
  // 台西:貳佰肆拾伍萬陸仟元整
  test('萬位國字大寫', () => expect(cnNumToNumber('貳佰肆拾伍萬陸仟元整')).toBe(2456000));
  // 鹿場:新台幣:貳佰捌拾壹萬肆仟叁拾貳元整 —— 前綴與「元整」都要能吃掉
  test('帶前綴與元整', () => expect(cnNumToNumber('新台幣:貳佰捌拾壹萬肆仟叁拾貳元整')).toBe(2814032));
  test('小寫國字亦可', () => expect(cnNumToNumber('二百四十五万六千')).toBe(2456000));
  test('非國字回 null', () => expect(cnNumToNumber('3,122,168元')).toBeNull());
});

describe('parseMoney', () => {
  test('阿拉伯數字含千分位', () => expect(parseMoney('3,122,168元')).toBe(3122168));
  test('國字大寫', () => expect(parseMoney('貳佰肆拾伍萬陸仟元整')).toBe(2456000));
  test('純數值', () => expect(parseMoney(3122168)).toBe(3122168));
  test('讀不到回 null', () => expect(parseMoney('__J_?O_')).toBeNull());
  // OCR 把千分位讀成全形逗號(南陽/元長舖面實測)。不做 NFKC 的話這裡會回 3,
  // 而 3 是個「看起來合法」的金額 —— 比對層攔不住,會一路寫進歸檔後的工程資料。
  test('全形千分位不得截斷成第一段', () => expect(parseMoney('新台幣3，122，168元')).toBe(3122168));
  test('全形數字', () => expect(parseMoney('４４１６２７０')).toBe(4416270));
  // 千分位被讀成句點(南陽 PP-OCRv5 實測)。舊邏輯的 [\d,]+ 遇到句點就停,會回 3。
  test('千分位讀成句點', () => expect(parseMoney('新台幣3.122,168元')).toBe(3122168));
  test('千分位混句點與逗號', () => expect(parseMoney('3.122.168')).toBe(3122168));
  // 反面:分隔符後不是剛好三位數,就不是千分位,不得動它。
  test('小數兩位不得當千分位', () => expect(parseMoney('2590.00')).toBe(2590));
  test('一位小數不得當千分位', () => expect(parseMoney('1.5')).toBe(1));
});

describe('parseDuration', () => {
  test('日曆天', () => expect(parseDuration('150日曆天')).toEqual({ 天數: 150, 基準: '日曆天' }));
  // 明禮是全 24 份中唯一的工作天案例。由日期推導出的必然是日曆天,
  // 不分基準就會對明禮產生一個必然的假警報。
  test('工作天要辨識出來', () => expect(parseDuration('160工作天')).toEqual({ 天數: 160, 基準: '工作天' }));
  // 大美:「機關通知日起 90 日曆天竣工」—— 數字埋在句子裡
  test('埋在句子裡的天數', () => expect(parseDuration('機關通知日起90日曆天竣工')).toEqual({ 天數: 90, 基準: '日曆天' }));
  // OCR 逐字空格
  test('OCR 空格', () => expect(parseDuration('1 6 0 日 曆 天')).toEqual({ 天數: 160, 基準: '日曆天' }));
  // 南陽 150→'_J50_'、石龜 120→'__J_?O_' :OCR 讀壞的值不得硬湊成數字
  test('讀壞的值回 null 不硬湊', () => {
    expect(parseDuration('_J50_')).toEqual({ 天數: null, 基準: null });
    expect(parseDuration('一』一一')).toEqual({ 天數: null, 基準: null });
  });
  test('沒基準字樣也要取到天數', () => expect(parseDuration('150')).toEqual({ 天數: 150, 基準: null }));
});

describe('deriveDuration', () => {
  // 含頭尾:3/18 到 8/14 是 150 天。少算一天則 24 份全部判不符。
  test('含頭尾計算', () => expect(deriveDuration('2026-03-18', '2026-08-14')).toBe(150));
  test('同一天為 1 天', () => expect(deriveDuration('2026-03-18', '2026-03-18')).toBe(1));
  test('跨年', () => expect(deriveDuration('2026-07-15', '2027-01-10')).toBe(180));
  test('缺值回 null', () => expect(deriveDuration(null, '2026-08-14')).toBeNull());
  // 竣工早於開工是資料錯誤,不得回負數讓它靜默通過比對
  test('迄早於起回 null', () => expect(deriveDuration('2026-08-14', '2026-03-18')).toBeNull());
});

// 開工報告表那一欄的版面是「□日曆天 □工作天,___年__月__日前竣工」——
// **兩個詞本來就都印在紙上**,24 份實測有 17 份的文字同時出現。
// 舊版用「哪個詞存在」判、且工作天排前面,那 17 份一律誤判成工作天。
describe('parseDuration:日曆天/工作天並列的表單版面', () => {
  test('數字緊接哪個詞就是哪個基準,不看另一個詞在不在', () => {
    expect(parseDuration('150日曆天工作天')).toEqual({ 天數: 150, 基準: '日曆天' });
    expect(parseDuration('日曆天工作天160工作天')).toEqual({ 天數: 160, 基準: '工作天' });
  });

  // 兩個都印著、又沒有數字緊接任一個 → 猜錯的代價是一個必然的假硬錯,
  // 回 null 讓承辦人自己選(他本來就知道是哪一種)
  test('兩個詞都有但無從判斷時回 null,不猜', () => {
    expect(parseDuration('日曆天工作天').基準).toBe(null);
  });

  test('只出現一個詞時照舊採用', () => {
    expect(parseDuration('日曆天 90 天')).toEqual({ 天數: 90, 基準: '日曆天' });
    expect(parseDuration('工作天').基準).toBe('工作天');
  });

  // 欄位配對常只抓到後半段:台西實際餵進來的是「工作天115年10月28日前竣工」,
  // 那個 115 是**民國年**不是天數(真值 120)。橋頭同樣讀成 116(真值 180)。
  // 120→115 看起來完全像個合法工期,不會有人察覺——這種錯比讀不到危險。
  test('民國年份不可被當成天數', () => {
    expect(parseDuration('工作天115年10月28日前竣工').天數).toBe(null);
    expect(parseDuration('工作天116年01月10日前竣工').天數).toBe(null);
  });

  test('日期片段拿掉後仍找得到真的天數', () => {
    expect(parseDuration('120日曆天,115年10月28日前竣工'))
      .toEqual({ 天數: 120, 基準: '日曆天' });
  });
});
