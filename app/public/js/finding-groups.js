/** 施工日誌錯誤分組：純資料函式，供畫面與 Jest 共用。 */
const FindingGroups = (() => {
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const dayNumber = (iso) => {
    if (!ISO_DATE.test(String(iso))) return null;
    const [y, m, d] = String(iso).split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  };

  function formatFindingDates(input) {
    const dates = [...new Set((input || []).filter(Boolean).map(String))].sort();
    const parts = [];
    for (let i = 0; i < dates.length;) {
      const start = dates[i];
      const startDay = dayNumber(start);
      let end = i;
      while (startDay != null && end + 1 < dates.length
        && dayNumber(dates[end + 1]) === dayNumber(dates[end]) + 1) end++;
      const count = end - i + 1;
      parts.push(count > 1 ? `${start}～${dates[end]}（${count} 天）` : start);
      i = end + 1;
    }
    return parts.join('、') || '—';
  }

  function groupFindings(errors, warnings) {
    const findings = [
      ...(errors || []).map((e) => ({ ...e, 級別: '硬錯' })),
      ...(warnings || []).map((e) => ({ ...e, 級別: '警告' })),
    ];
    const groups = [];
    const byKey = new Map();
    for (const finding of findings) {
      // 全案型錯誤沒有日期，保留逐筆顯示，避免兩個不同統計來源被外觀相同的文字合併。
      const key = finding.日期 ? JSON.stringify([
        finding.級別, finding.code || '', finding.項次 || '', finding.訊息 || '',
      ]) : null;
      let group = key == null ? null : byKey.get(key);
      if (!group) {
        group = {
          級別: finding.級別,
          code: finding.code,
          項次: finding.項次,
          訊息: finding.訊息,
          日期: [],
          findings: [],
          問題歸屬: '待確認',
        };
        groups.push(group);
        if (key != null) byKey.set(key, group);
      }
      group.findings.push(finding);
      if (finding.日期 && !group.日期.includes(String(finding.日期))) group.日期.push(String(finding.日期));
    }
    for (const group of groups) {
      group.日期.sort();
      group.日期顯示 = formatFindingDates(group.日期);
    }
    return groups;
  }

  const recognitionProblems = (groups) => (groups || [])
    .filter((group) => group.問題歸屬 === '辨識問題')
    .flatMap((group) => group.findings)
    .map(({ 級別, code, 日期, 項次, 訊息 }) => ({ 級別, code, 日期, 項次, 訊息 }));

  return { groupFindings, formatFindingDates, recognitionProblems };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FindingGroups;
