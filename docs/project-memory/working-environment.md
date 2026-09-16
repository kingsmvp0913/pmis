---
name: working-environment
description: 這個專案的操作環境——會賠掉一輪的六個陷阱、前端怎麼驗、server 怎麼啟、測試資料現況、OCR 量測原則
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-15T01:45:00.514Z
---

從 MEMORY.md 接手點抽出來的常駐操作知識(2026-08-15)。**不隨每日進度變動的放這裡**,
接手點只留「今天做到哪」。

## 🧰 六個會賠掉一輪的操作陷阱

- **橋頭/許厝要用 `(1).xlsx` 那兩份**(廠商的更正版),四份舊 `.xlsm` 單價 0/33 對得上。
  ⚠️ 檔名的 `(1)` 一般代表「重複下載」不是「更正版」,**拿錯就重現 1860 筆 E6 硬錯**,
  而且看起來會像讀取器壞了。見 [[source-data-defect-log]]。
- **`compare-all.js` 可續跑**,「改完重跑看有沒有變」根本沒重跑——先移除
  `compare-all.json`,跑完核對 `raw` 的時間戳。見 [[end-to-end-report-comparison]]。
- **Excel 失敗會留下無視窗的 `EXCEL.EXE`**,累積後每案都被 `RPC_E_CALL_REJECTED` 拒絕。
  **單獨重跑仍失敗時先 `Get-Process EXCEL`,再懷疑程式。** Word COM 同理(`WINWORD`)。
- **人工報表 A 欄是帶前綴的顯示項次(`壹.1`)**,拿它當輸入餵產線會被判成費用項目。
  見 [[fee-item-formula]]。
- **有兩支測試本來就逼近 Jest 的 5 秒**,加測試會把它們推過臨界,紅得像功能壞掉。
  看到全套紅先確認是不是 "Exceeded timeout";要判斷是不是自己改慢的就
  `git stash` 跑一次基準。見 [[running-tests]]。
- **這個工作樹有另一條線在動,而且它會替你 push。**
  開工一定先 `git fetch` + `git rev-list --left-right --count origin/main...HEAD`,
  **兩個方向都不要假設**:別以為「我沒推就還沒推」,也別以為「我推了」。
  2026-08-14 實際踩到:收工前寫「4 個 commit 未推送」,fetch 後只剩 1 個。
- ⚠️ **它還會在工作樹裡留下「不是我改的」未提交檔案。**
  2026-08-15 收工前 `git status` 冒出 `app/scripts/start.js`、`啟動.bat`、`安裝.bat`
  三個我整輪沒碰過的檔(內容是「直接下載 ZIP 沒有 .git 時要提示使用者」,與我無關)。
  **處理方式:不提交也不還原,只回報。**
  → 推論:**`git commit -a` 與 `git add .` 在這個工作樹是危險的**,
  一律只 `git add` 自己動過的檔案路徑。

## 前端怎麼驗(登入頁擋不住)

系統要密碼登入,而我不代輸入認證資訊。改用**同源頁面直接跑真正的 render 流程**:
開 `localhost:4141`、`Api.setToken('fake')` + 覆寫 `Api.get/put/upload` 回假資料,
再設 `location.hash`;或直接 `document.body.appendChild(DailyLogs.card(4))` 建元件、
click 按鈕、讀 `.hint` 的文字。**比讀程式碼確定得多,而且不必碰 DB。**

⚠️ `mcp__claude-in-chrome__javascript_tool` 裡**不要包 async IIFE**——回傳會變 `{}`,
看起來像沒執行(其實有跑)。直接用 top-level await。

2026-08-12 五個前端項目、2026-08-15 費用項目說明的兩條分支,都是這樣驗完的
(含深色模式的 `getComputedStyle` 實測)。

## 環境與啟動

- 啟動走 `node app/scripts/start.js` **不是** `node server/index.js`——後者少了
  `JWT_SECRET` 會直接掛掉。⚠️ `config.json` 在**根層 `data/`**,不是 `app/data/`。
  `Start-Process node -ArgumentList "app/scripts/start.js" -WorkingDirectory <PMIS_ROOT>`
- **server 狀態每次自己確認,別信任何文件寫的**:
  `Get-NetTCPConnection -LocalPort 4141 -State Listen`。
- 測試資料留著三個新工程 #7 仁德/#8 南陽/#9 四湖、兩家事務所(呂罡銘/大墩)、
  `data/output/` 下數份公文——使用者說留著。
  **四湖(#9)的日誌樣本混了 2025 與 2026 兩個標案,硬錯多屬正常,別當 bug 追。**
- 樣本樹在 `%USERPROFILE%\OneDrive\Desktop\PMIS範例\`(**不是** `Desktop\`,
  中間有 OneDrive)。各子目錄的份數見 [[template-folder-coverage]]。

## OCR 量測原則

基座在 `data/parser-tools/ocr-ab/`。**一律量「對/錯/漏」不要量「命中率」**
——後者會把「拿漏換錯」看成改善。引擎已是 PP-OCRv5,**不要再換**
(2026-08-15 實測仍全面勝過 Windows OCR:191/4/21 vs 167/15/25)。

**有快取,調抽取規則是秒級離線迭代**;重跑一次 OCR 要 40 分鐘以上。
⚠️ `preset5m` 只有 3400 一種寬度(那就是產品實際用的),`win`/`v5m` 才有多解析度。

⛔ **換過引擎之後,舊的版面結論全部要重驗。** 2026-08-15 踩到兩次:
「臺中市格式標籤逐字水平散開」與「工程名稱都是值跨框」都是 Windows OCR 時代的結論,
在 PP-OCRv5 下根因整組不同。
