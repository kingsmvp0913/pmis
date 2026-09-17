/**
 * 聖捷土木包工業 — 建築物施工日誌 PDF 讀取器。
 *
 * 此格式一天跨兩頁：第一頁包含表頭、13 個直接工程項目與貳至伍費用項，
 * 第二頁以陸（營業稅）開頭，接續材料、人員及機具資料。
 */

const META_VENDOR_KEY = '聖捷土木包工業';
const ITEM_NO_RE = /^(?:\d{1,2}|[壹貳參肆伍陸])$/;
const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'T', '組', '座', '處', '只', '個']);

const nfkc = (value) => String(value == null ? '' : value).normalize('NFKC');
const compact = (value) => nfkc(value).replace(/[\s\u00a0]+/g, '');

function text(value) {
  const valueText = nfkc(value).replace(/[\r\n]+/g, '').trim();
  return valueText === '' || /^[-－]+$/.test(valueText) ? null : valueText;
}

function number(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const valueText = compact(value).replace(/[,％%]/g, '');
  if (!valueText || /^[-－]+$/.test(valueText)) return null;
  const parsed = Number(valueText);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateTextToISO(value) {
  const match = compact(value).match(/(\d{2,4})年(\d{1,2})月(\d{1,2})日/);
  if (!match) return null;
  let year = Number(match[1]);
  if (year < 1911) year += 1911;
  const pad = (part) => String(Number(part)).padStart(2, '0');
  return `${year}-${pad(match[2])}-${pad(match[3])}`;
}

function bands(items, tolerance = 0.7) {
  const result = [];
  for (const item of (items || []).slice().sort((a, b) => (b.y - a.y) || (a.x - b.x))) {
    const current = result[result.length - 1];
    if (current && Math.abs(current.y - item.y) <= tolerance) current.items.push(item);
    else result.push({ y: item.y, items: [item] });
  }
  for (const band of result) band.items.sort((a, b) => a.x - b.x);
  return result;
}

const itemsIn = (band, left, right) => (band ? band.items : [])
  .filter((item) => item.x >= left && item.x < right)
  .sort((a, b) => a.x - b.x);

const joined = (items) => text((items || []).map((item) => item.s).join(''));
const compactJoined = (items) => text(compact((items || []).map((item) => item.s).join('')));
const bandText = (band) => compactJoined(band ? band.items : []);
const hasText = (band, pattern) => pattern.test(bandText(band) || '');

function rowAnchor(band) {
  const noItem = (band.items || []).find((item) => item.x < 60 && ITEM_NO_RE.test(compact(item.s)));
  if (!noItem) return null;
  const unitRaw = compactJoined(itemsIn(band, 225, 265));
  const quantityRaw = compactJoined(itemsIn(band, 265, 323));
  if (!unitRaw || quantityRaw == null) return null;
  return {
    band,
    y: band.y,
    no: compact(noItem.s),
    unitRaw,
    quantityRaw,
  };
}

function rowFromAnchor(anchor, name) {
  const unit = compact(anchor.unitRaw);
  return {
    項次: anchor.no,
    工程項目: text(name),
    單位: KNOWN_UNITS.has(unit) ? unit : null,
    契約單價: null,
    契約數量: number(anchor.quantityRaw),
    本日完成數量: number(compactJoined(itemsIn(anchor.band, 323, 401))),
    本日完成金額: null,
    累計完成數量: number(compactJoined(itemsIn(anchor.band, 401, 480))),
  };
}

function segmentCost(lines, from, to, anchorY) {
  const middle = (lines[from].y + lines[to - 1].y) / 2;
  return (middle - anchorY) ** 2;
}

/**
 * 項次／數值印在合併列的垂直中央，長名稱則分散於中央上下。
 * 以連續分段找出讓每個項次最接近其名稱區塊中點的唯一配置。
 */
function assignNames(anchors, nameLines) {
  const rowCount = anchors.length;
  const lineCount = nameLines.length;
  if (!rowCount || lineCount < rowCount) return null;
  const dp = Array.from({ length: rowCount + 1 }, () => Array(lineCount + 1).fill(Infinity));
  const previous = Array.from({ length: rowCount + 1 }, () => Array(lineCount + 1).fill(-1));
  dp[0][0] = 0;
  for (let row = 1; row <= rowCount; row += 1) {
    for (let used = row; used <= lineCount - (rowCount - row); used += 1) {
      for (let split = row - 1; split < used; split += 1) {
        if (!Number.isFinite(dp[row - 1][split])) continue;
        const score = dp[row - 1][split] + segmentCost(nameLines, split, used, anchors[row - 1].y);
        if (score < dp[row][used]) {
          dp[row][used] = score;
          previous[row][used] = split;
        }
      }
    }
  }
  if (!Number.isFinite(dp[rowCount][lineCount])) return null;
  const names = Array(rowCount);
  let used = lineCount;
  for (let row = rowCount; row > 0; row -= 1) {
    const split = previous[row][used];
    names[row - 1] = text(nameLines.slice(split, used).map((line) => line.value).join(''));
    used = split;
  }
  return names;
}

function parseWeather(headerBand) {
  if (!headerBand) return { morning: null, afternoon: null };
  const afternoonLabel = headerBand.items.find((item) => compact(item.s) === '下午:');
  const dateLabel = headerBand.items.find((item) => compact(item.s) === '填表日期:');
  return {
    morning: joined(headerBand.items.filter((item) => item.x >= 115 && (!afternoonLabel || item.x < afternoonLabel.x))),
    afternoon: joined(headerBand.items.filter((item) => afternoonLabel && item.x >= afternoonLabel.x + afternoonLabel.w
      && (!dateLabel || item.x < dateLabel.x))),
  };
}

function parseFirstPage(items) {
  const allBands = bands(items);
  if (!allBands.some((band) => hasText(band, /^建築物施工日誌$/))) {
    throw new Error('不是聖捷建築物施工日誌第一頁');
  }

  const headerBand = allBands.find((band) => hasText(band, /本日天氣:上午:/));
  const date = dateTextToISO(bandText(headerBand));
  if (!date) throw new Error('聖捷施工日誌讀不到填報日期');
  const weather = parseWeather(headerBand);
  const weekMatch = (bandText(headerBand) || '').match(/星期([一二三四五六日天])/);

  const nameBand = allBands.find((band) => hasText(band, /^工程名稱/));
  const nameY = nameBand ? nameBand.y : null;
  const projectName = nameY == null ? null : compactJoined(items.filter((item) =>
    item.x >= 79 && item.x < 325 && item.y > nameY - 18 && item.y < nameY + 18));
  const vendorName = nameY == null ? null : compactJoined(items.filter((item) =>
    item.x >= 403 && item.y > nameY - 5 && item.y < nameY + 5));

  const startBand = allBands.find((band) => hasText(band, /^開工日期/));
  const startDate = startBand ? dateTextToISO(compactJoined(itemsIn(startBand, 120, 325))) : null;
  const progressBand = allBands.find((band) => hasText(band, /預定進度\(%\)/));
  const planned = progressBand ? number(compactJoined(itemsIn(progressBand, 139, 330))) : null;
  const actual = progressBand ? number(compactJoined(itemsIn(progressBand, 401, 530))) : null;

  const tableHeader = allBands.find((band) => hasText(band, /施工項目單位契約數量本日完成數量累計完成數量/));
  if (!tableHeader) throw new Error('聖捷施工日誌找不到施工項目表頭');
  const section = allBands.find((band) => band.y < tableHeader.y && hasText(band, /^壹直接工程$/));
  const anchors = allBands
    .filter((band) => band.y < tableHeader.y && band.y > 45)
    .map(rowAnchor).filter(Boolean)
    .filter((anchor) => anchor.no !== '陸')
    .sort((a, b) => b.y - a.y);
  const upper = section ? section.y - 0.5 : (anchors[0] ? anchors[0].y + 12 : tableHeader.y);
  const lower = anchors.length ? anchors[anchors.length - 1].y - 9 : 45;
  const nameLines = allBands
    .filter((band) => band.y < upper && band.y > lower)
    .map((band) => ({ y: band.y, value: compactJoined(itemsIn(band, 60, 230)) }))
    .filter((line) => line.value)
    .sort((a, b) => b.y - a.y);
  const names = assignNames(anchors, nameLines);
  if (!names || names.some((name) => !name)) throw new Error('聖捷施工日誌工程項目名稱分列失敗');

  return {
    header: {
      工程名稱: projectName,
      填報日期: date,
      星期: weekMatch ? `星期${weekMatch[1]}` : null,
      天氣_上午: weather.morning,
      天氣_下午: weather.afternoon,
      預定進度: planned,
      實際進度: actual,
      出工總人數: null,
      本日累計金額: null,
      承包廠商: vendorName,
      開工日期: startDate,
    },
    dailyRows: anchors.map((anchor, index) => rowFromAnchor(anchor, names[index])),
    extras: {},
  };
}

function parseMaterials(allBands, materialHeader, crewHeader) {
  if (!materialHeader || !crewHeader) return [];
  const result = [];
  for (const band of allBands) {
    if (band.y >= materialHeader.y || band.y <= crewHeader.y + 1) continue;
    const name = compactJoined(itemsIn(band, 24, 205));
    const unitRaw = compactJoined(itemsIn(band, 205, 265));
    const quantity = number(compactJoined(itemsIn(band, 323, 401)));
    if (name && quantity != null) result.push({ 名稱: name, 單位: unitRaw || null, 數量: quantity });
  }
  return result;
}

function parseCrewAndMachines(allBands, crewHeader, stopBand) {
  const crew = [];
  const machines = [];
  let total = null;
  if (!crewHeader || !stopBand) return { crew, machines, total };
  for (const band of allBands) {
    if (band.y >= crewHeader.y || band.y <= stopBand.y + 1) continue;
    const trade = compactJoined(itemsIn(band, 20, 100));
    const people = number(compactJoined(itemsIn(band, 100, 210)));
    if (trade && people != null) {
      if (people > 0) crew.push({ 工別: trade, 人數: people });
      total = (total || 0) + people;
    }
    const machine = compactJoined(itemsIn(band, 300, 400));
    const quantity = number(compactJoined(itemsIn(band, 400, 480)));
    if (machine && quantity != null && quantity > 0) machines.push({ 名稱: machine, 數量: quantity });
  }
  return { crew, machines, total };
}

function parseContinuationPage(items) {
  const allBands = bands(items);
  const feeAnchor = allBands.map(rowAnchor).find((anchor) => anchor && anchor.no === '陸');
  if (!feeAnchor) throw new Error('聖捷施工日誌第二頁找不到陸、營業稅');
  const feeName = compactJoined(itemsIn(feeAnchor.band, 60, 230));
  const materialHeader = allBands.find((band) => hasText(band, /材料名稱單位設計數量本日使用數量累計使用數量/));
  const crewHeader = allBands.find((band) => hasText(band, /工別本日人數累計人數機具名稱本日使用數量/));
  const stopBand = allBands.find((band) => crewHeader && band.y < crewHeader.y && hasText(band, /^四、本日施工項目/));
  const materials = parseMaterials(allBands, materialHeader, crewHeader);
  const peopleAndMachines = parseCrewAndMachines(allBands, crewHeader, stopBand);
  const extras = {};
  if (materials.length) extras.主要材料 = materials;
  if (peopleAndMachines.crew.length) extras.出工明細 = peopleAndMachines.crew;
  if (peopleAndMachines.machines.length) extras.主要機具 = peopleAndMachines.machines;
  return {
    row: rowFromAnchor(feeAnchor, feeName),
    出工總人數: peopleAndMachines.total,
    extras,
  };
}

function isFirstPage(items) {
  return bands(items).some((band) => hasText(band, /^建築物施工日誌$/));
}

async function parseAll(filePath, ctx) {
  if (!/\.pdf$/i.test(filePath)) throw new Error('聖捷施工日誌讀取器僅支援 PDF');
  const filetypes = ctx && ctx.filetypes;
  if (!filetypes || typeof filetypes.extractItems !== 'function') {
    throw new Error('缺少注入的 filetypes.extractItems');
  }
  const pages = await filetypes.extractItems(filePath);
  const itemCount = pages.reduce((sum, page) => sum + (page.items || []).length, 0);
  if (!itemCount) throw new Error('PDF 沒有文字層，請改走掃描件辨識');

  const days = [];
  for (let index = 0; index < pages.length; index += 1) {
    const items = pages[index].items || [];
    if (!isFirstPage(items)) continue;
    const day = parseFirstPage(items);
    const nextItems = pages[index + 1] && (pages[index + 1].items || []);
    if (!nextItems || isFirstPage(nextItems)) {
      throw new Error(`聖捷施工日誌 ${day.header.填報日期} 缺少第二頁`);
    }
    const continuation = parseContinuationPage(nextItems);
    day.dailyRows.push(continuation.row);
    day.header.出工總人數 = continuation.出工總人數;
    day.extras = continuation.extras;
    days.push(day);
    index += 1;
  }
  if (!days.length) throw new Error('找不到聖捷建築物施工日誌頁面');
  if (!days.every((day) => day.header.填報日期)) throw new Error('聖捷施工日誌有頁面讀不到填報日期');
  return days.sort((left, right) => left.header.填報日期.localeCompare(right.header.填報日期));
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

function selfTest() {
  const item = (x, y, w, s) => ({ x, y, w, s });
  const firstPage = [
    item(241.6, 788.2, 112.1, '建築物施工日誌'),
    item(38.4, 761.9, 79.9, '本日天氣:上午:'), item(118.3, 761.9, 19.9, '細雨'),
    item(163.5, 761.9, 29.9, '下午:'), item(193.4, 761.9, 10, '陰'),
    item(378.6, 761.9, 49.8, '填表日期:'), item(433.4, 761.9, 10.1, '115'),
    item(451.1, 761.9, 10, '年'), item(466.1, 761.9, 5, '9'), item(473.6, 761.9, 10, '月'),
    item(488.6, 761.9, 5, '1'), item(496.2, 761.9, 10, '日'), item(511.2, 761.9, 19.7, '星期'),
    item(531, 761.9, 10, '二'),
    item(31.1, 739.7, 48, '工程名稱'), item(88.8, 747.5, 228, '雲林縣麥寮鄉麥寮國小活動中心漏水災後復'),
    item(88.8, 731.9, 36, '建工程'), item(331.8, 739.7, 72, '承攬廠商名稱'),
    item(415.8, 739.9, 77.2, META_VENDOR_KEY),
    item(76.3, 684, 48, '開工日期'), item(208.8, 684, 12, '115'), item(229.8, 684, 12, '年'),
    item(244.8, 684, 6, '9'), item(253.8, 684, 12, '月'), item(268.9, 684, 6, '1'), item(277.9, 684, 12, '日'),
    item(67.3, 667.7, 48, '預定進度'), item(115.3, 667.7, 18, '(%)'), item(237.4, 667.7, 24, '1.22'),
    item(334.8, 667.7, 48, '實際進度'), item(382.8, 667.7, 18, '(%)'), item(470.5, 667.7, 24, '3.63'),
    item(101.4, 631.7, 48, '施工項目'), item(234.1, 631.7, 24, '單位'), item(268.6, 631.7, 48, '契約數量'),
    item(323.9, 631.7, 72, '本日完成數量'), item(401.9, 631.7, 72, '累計完成數量'),
    item(37.3, 615.4, 12, '壹'), item(65.2, 615.4, 48, '直接工程'),
    item(65.2, 599.2, 156, '工程告示牌、職安告示牌與交'), item(40.3, 591.4, 6, '1'),
    item(240.1, 591.4, 12, '式'), item(289.6, 591.4, 6, '1'), item(356.9, 591.4, 6, '1'), item(434.9, 591.4, 6, '1'),
    item(65.2, 583.6, 96, '通管制設施(租用)'),
    item(65.2, 535, 150, '施工動線開闢與損壞復原;妨礙'), item(65.2, 519.4, 156, '施工介面相關之構造設備拆'),
    item(40.3, 511.6, 6, '4'), item(240.1, 511.6, 12, '式'), item(289.6, 511.6, 6, '1'),
    item(65.2, 503.8, 156, '除、或遷移與復原,管路整理'), item(65.2, 488.2, 60, '固定與架高'),
    item(37.3, 108.1, 12, '貳'), item(65.2, 108.1, 162, '職業安全衛生管理費(壹*1%)'),
    item(240.1, 108.1, 12, '式'), item(289.6, 108.1, 6, '1'), item(347.9, 108.1, 24, '0.06'), item(425.9, 108.1, 24, '0.06'),
  ];
  const secondPage = [
    item(37.3, 787.4, 12, '陸'), item(65.2, 787.4, 126, '營業稅((壹~伍)*5%)'),
    item(240.1, 787.4, 12, '式'), item(289.6, 787.4, 6, '1'), item(347.9, 787.4, 24, '0.06'), item(425.9, 787.4, 24, '0.06'),
    item(83.8, 753.7, 48, '材料名稱'), item(216.5, 753.7, 24, '單位'), item(268.6, 753.7, 48, '設計數量'),
    item(323.9, 753.7, 72, '本日使用數量'), item(401.9, 753.7, 72, '累計使用數量'),
    item(31.3, 693.3, 24, '工別'), item(104.3, 693.3, 48, '本日人數'), item(233, 693.3, 48, '累計人數'),
    item(335.9, 693.3, 48, '機具名稱'), item(401.9, 693.3, 72, '本日使用數量'),
    item(25.3, 669.5, 36, '普通工'), item(125.3, 669.5, 6, '5'), item(254, 669.5, 6, '5'),
    item(24.2, 652.3, 20.9, '四、'), item(45.1, 652.3, 80, '本日施工項目'),
  ];
  try {
    const day = parseFirstPage(firstPage);
    const continuation = parseContinuationPage(secondPage);
    if (day.header.工程名稱 !== '雲林縣麥寮鄉麥寮國小活動中心漏水災後復建工程') return false;
    if (day.header.填報日期 !== '2026-09-01' || day.header.預定進度 !== 1.22 || day.header.實際進度 !== 3.63) return false;
    if (day.dailyRows.length !== 3 || day.dailyRows[0].工程項目 !== '工程告示牌、職安告示牌與交通管制設施(租用)') return false;
    if (day.dailyRows[1].項次 !== '4' || !day.dailyRows[1].工程項目.includes('管路整理固定與架高')) return false;
    if (continuation.row.項次 !== '陸' || continuation.row.本日完成數量 !== 0.06) return false;
    if (continuation.出工總人數 !== 5 || continuation.extras.出工明細[0].工別 !== '普通工') return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '星期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '出工總人數', '本日累計金額', '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約單價', '契約數量', '本日完成數量', '本日完成金額', '累計完成數量',
      '出工明細', '主要材料', '主要機具',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parseFirstPage, parseContinuationPage, assignNames, bands },
};
