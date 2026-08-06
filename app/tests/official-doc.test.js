/**
 * official-doc.test.js — 公文套版引擎
 *
 * 產出物是要發出去的正式公文,所以測的是「印在紙上會不會錯」:
 * 值有沒有到位、有沒有漏掉的佔位符、特殊字元會不會讓 docx 開不起來。
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { fillTemplate, PLACEHOLDERS, toIsoDate, toRocDate, buildLogDescription } = require('../server/official-doc');

const TEMPLATE = path.resolve(__dirname, '../templates/公文_空白範本.docx');

// 從產出的 docx 取回 document.xml 的純文字(去掉所有標籤),用來斷言印出來的內容
async function textOf(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml').async('string');
  const parts = [];
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    // XML 實體反逃脫,以符合 Word parser 的行為
    const unescaped = m[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    parts.push(unescaped);
  }
  return parts.join('');
}

const VALUES = {
  發文單位: '呂罡銘建築師事務所',
  發文地址: '403台中市西區中華路一段7號3樓',
  電話: '04-22238088',
  傳真: '04-22230988',
  聯絡人: '呂罡銘',
  電子信箱: 'arch.kmlu@gmail.com',
  受文者: '臺中市西區大勇國民小學',
  發文日期: '115年7月1日',
  發文字號: '銘第4131-5070112號',
  工程名稱: '114學年度南棟教室西側廁所整修工程',
  日誌描述: '施工日誌(115年6月1日至115年6月30日)',
  份數: '乙',
  廠商名稱: '摯東營造有限公司',
  廠商公文日期: '115年7月1日',
  廠商文號: '摯勇字第1150701001號',
};

describe('fillTemplate', () => {
  test('15 個值全部寫進 docx', async () => {
    const buf = await fillTemplate(VALUES, TEMPLATE);
    const text = await textOf(buf);
    for (const key of PLACEHOLDERS) {
      expect(text).toContain(VALUES[key]);
    }
  });

  // 漏一個佔位符 = 公文上印著「{{份數}}」發出去,而且沒有人會在寄出前逐字校對
  test('產出物不得殘留任何佔位符', async () => {
    const buf = await fillTemplate(VALUES, TEMPLATE);
    const text = await textOf(buf);
    expect(text).not.toMatch(/\{\{/);
  });

  // 學校/廠商名稱出現 & < > 會讓 document.xml 不合法,Word 直接開不起來
  test('值含 XML 特殊字元時,產出的 docx 仍可解析且文字正確', async () => {
    const buf = await fillTemplate({ ...VALUES, 受文者: 'A&B<小學>' }, TEMPLATE);
    const text = await textOf(buf);
    expect(text).toContain('A&B<小學>');
  });

  // 範本被改動而多出一個新欄位時,要當場炸掉而不是產出一份印著佔位符的公文
  test('範本含未知佔位符時擲錯', async () => {
    const zip = await JSZip.loadAsync(fs.readFileSync(TEMPLATE));
    let xml = await zip.file('word/document.xml').async('string');
    xml = xml.replace('{{份數}}', '{{份數}}{{沒人認得的欄位}}');
    zip.file('word/document.xml', xml);
    const tmp = path.join(require('os').tmpdir(), 'pmis-tpl-unknown.docx');
    fs.writeFileSync(tmp, await zip.generateAsync({ type: 'nodebuffer' }));
    await expect(fillTemplate(VALUES, tmp)).rejects.toThrow('沒人認得的欄位');
  });
});

describe('toIsoDate', () => {
  // pg 把 DATE 解析成「在地午夜的 Date」,toISOString() 會讓台北時間退一天。
  // 公文上的日期錯一天,是會被學校退件的錯。
  test('Date 物件取在地年月日,不經 UTC', () => {
    expect(toIsoDate(new Date(2026, 6, 1))).toBe('2026-07-01');
  });

  test('純日期字串原樣截斷', () => {
    expect(toIsoDate('2026-07-01')).toBe('2026-07-01');
  });

  test('null/空值回 null', () => {
    expect(toIsoDate(null)).toBeNull();
    expect(toIsoDate('')).toBeNull();
  });
});

describe('toRocDate', () => {
  test('西元轉民國,月日不補零(與樣本一致)', () => {
    expect(toRocDate('2026-07-01')).toBe('115年7月1日');
    expect(toRocDate('2026-12-25')).toBe('115年12月25日');
  });

  test('吃 Date 物件', () => {
    expect(toRocDate(new Date(2026, 5, 30))).toBe('115年6月30日');
  });
});

describe('buildLogDescription', () => {
  // 樣本 doc_b/doc_c 寫的就是完整日曆月;不取日誌實際首尾,因為廠商本來就
  // 不會逐日填(假日無工),用首尾會寫出「6月2日至6月29日」這種與樣本不符的期間。
  test('一般月:整個日曆月', () => {
    expect(buildLogDescription('2026-06', '2026-01-26', null))
      .toBe('施工日誌(115年6月1日至115年6月30日)');
  });

  // 首月若不從開工日起算,公文會宣稱檢送了開工前那幾天的日誌
  test('首月:自開工日起', () => {
    expect(buildLogDescription('2026-01', '2026-01-26', null))
      .toBe('施工日誌(115年1月26日至115年1月31日)');
  });

  // 末月同理:不裁切就會宣稱檢送了竣工後的日誌
  test('末月:至竣工日止', () => {
    expect(buildLogDescription('2026-08', '2026-01-26', '2026-08-15'))
      .toBe('施工日誌(115年8月1日至115年8月15日)');
  });

  test('二月要算對天數', () => {
    expect(buildLogDescription('2026-02', null, null))
      .toBe('施工日誌(115年2月1日至115年2月28日)');
  });

  test('period 格式不對就擲錯,不要默默產出錯的期間', () => {
    expect(() => buildLogDescription('2026/06', null, null)).toThrow('period');
  });
});
