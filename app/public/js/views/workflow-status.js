/**
 * workflow-status.js — 工程頁的流程狀態列
 *
 * 工程編輯頁有 8 個區塊,順序就是實際承辦流程,但承辦人得一路捲到底才知道自己
 * 走到哪。而且各區塊的前置條件是**按下去才知道**:契約詳細價目表要先有決標金額、
 * 施工日誌要先有契約表與開工日期——後端訊息寫得很明確,但那是事後才看到。
 *
 * 這一列把五個關卡的完成狀態一次攤開,並指出下一步該做什麼。
 * 判定一律用**後端已有的資料**(附件種類、契約項目數、主檔欄位),不另外開 API,
 * 也不重寫一份判斷邏輯——真正的把關仍在各自的路由。
 */
const WorkflowStatus = (() => {
  /**
   * @param {object} p        工程主檔(GET /projects/:id 的回應)
   * @param {Array}  atts     附件清單(GET /projects/:id/attachments)
   * @param {number} itemCount 契約詳細價目表的項目數
   * @param {number} logDays  已寫入的施工日誌天數
   */
  function bar(p, atts, itemCount, logDays) {
    const has = (kind) => (atts || []).some((a) => a.kind === kind);
    const steps = [
      { 名: '決標公告', 好: has('award_notice'), 缺: '建立工程時上傳' },
      { 名: '工程基本資料', 好: !!(p.start_date && p.award_amount), 缺: '需開工日期與契約金額' },
      { 名: '開工報告表', 好: has('kickoff_report'), 缺: '上傳並核對後歸檔' },
      { 名: '契約詳細價目表', 好: itemCount > 0, 缺: '需先有決標金額,再上傳發包經費總表' },
      { 名: '施工日誌', 好: logDays > 0, 缺: '需先建立契約詳細價目表與開工日期' },
    ];

    // 第一個未完成的關卡就是「下一步」。前面沒完成的,後面按了也只會被後端擋下。
    // 判定邏輯(steps 陣列、next 的算法)完全不動,只改下面的呈現方式。
    const next = steps.find((s) => !s.好);
    // 圓形節點 + 連接線的 stepper。之前拿 .error-msg(錯誤語意)套在「當前步驟」
    // 上,「工程基本資料」還沒填完時看起來像出錯——那不是錯誤,只是還沒到。
    // 連接線顏色規則:第 i 個節點左側那段線,顏色看「前一個節點是否已完成」
    // (steps[i-1].好),不是看自己——這樣「已完成 → 當前」那段線也會是完成色,
    // 視覺上讀成「進度到這裡」,「當前之後」才轉灰,呼應一般 stepper 的語意。
    const cells = steps.map((s, i) => {
      const isCurrent = s === next;
      const state = s.好 ? 'done' : (isCurrent ? 'current' : 'todo');
      const lineCls = i === 0 ? '' : (steps[i - 1].好 ? ' line-done' : ' line-todo');
      const nodeText = s.好 ? '✓' : (isCurrent ? String(i + 1) : '');
      return el('div', { class: 'wf-step ' + state + lineCls }, [
        el('div', { class: 'wf-node' }, nodeText),
        el('div', { class: 'wf-label' }, s.名),
      ]);
    });

    const tip = next
      ? el('div', { class: 'hint', style: 'margin-top:4px' }, `下一步:${next.名} — ${next.缺}`)
      : el('div', { class: 'hint', style: 'margin-top:4px' },
        `五個關卡都完成了(已寫入 ${logDays} 天施工日誌)。`);

    return el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, '流程進度'),
      // 窄螢幕水平捲動,但這裡沒有子節點會逃出容器邊界(不像 .more-menu 用
      // position:fixed 搬去 body),不會重演「捲動容器裁切」那個坑。
      el('div', { class: 'wf-steps' }, cells),
      tip,
    ]);
  }

  return { bar };
})();
