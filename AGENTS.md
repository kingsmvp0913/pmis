# PMIS — Codex 開發規則

本檔供互動式 Codex 使用。`.claude/CLAUDE.md` 與 `.claude/agents/*.md` 是 PMIS 平台執行期的 Claude pipeline 設定；除非任務明確要求，請勿修改、搬移或改名它們。

## Skills

- **getSQL**（`.claude/skills/getSQL/SKILL.md`）：查詢遠端專案資料庫時先完整閱讀；只允許 `SELECT` / `WITH`。
- **gen-vendor-parser**（`.claude/skills/gen-vendor-parser/SKILL.md`）：新增或修改廠商施工日誌讀取器前先完整閱讀。

## Hard Rules

- 以繁體中文（臺灣）回覆；思考可用英文。對需求有歧義時，先說明 2–3 種合理解讀與核心假設；仍無法確認時再提問。
- 只做解決需求所需的最小修改；不得順手重構或整理相鄰、無關的程式碼。
- 不得在已同意的需求規格外新增欄位、資料模型、邏輯或投機性功能；遇到不清楚的結構或意圖時，先說明疑點並釐清，不得自行猜測。
- 寫入專案檔案時使用相對路徑或環境變數，禁止寫死絕對路徑。
- 修改前閱讀受影響模組的 immediate callers、exports 與共用 utilities，並維持既有程式碼風格。
- 遵循專案既有慣例優先於個人偏好；若慣例可能有害，須明確提出，不得暗中另行採用不同模式。
- 開始工作前定義可驗證的成功條件；每個重要步驟後說明已完成事項、驗證結果與待辦。規則或既有模式衝突時，選擇較新或較受測的一方並說明理由，不得混用。
- 不得隱匿跳過項目、不確定性或失敗；未完整驗證不得宣稱完成或測試通過。
- 不得自行修改 `.claude/settings*.json`、hooks、CI 或本檔；這些都是工作流程設定，須有使用者明確授權。
- 不得自行 commit 或 push；先交付可審閱的 diff 與驗證結果。

## PMIS 架構邊界

- `app/server/**`、`app/public/**` 是 PMIS 平台程式碼；`data/**` 是執行期資料，不納入一般程式修改。
- 前端（`app/public/**`）配色一律使用 `app.css` 的 CSS 變數或 dark-aware class；不得只在 inline style 寫死淺色背景，造成深色模式文字不可讀。需要底色區隔時使用 `var(--bg)`、`var(--surface)` 等既有變數。
- `.claude/agents/*.md` 是由平台 pipeline 載入的 prompt，含輸出契約（如 `<result>`、JSON 欄位與 placeholder）。修改前必須先讀完整檔案及其呼叫端，並為契約新增或更新驗證。
- 廠商讀取器必須是 deterministic；不得在讀取器中呼叫 AI、網路、`process.cwd()`，或直接載入檔型工具。檔型工具一律由 `ctx.filetypes` 注入。
- 讀取器的 `meta.vendorKey` 必須等於決標公告的正式廠商名稱；不可由檔名或日誌內容猜測。

## 驗證與測試

- 修改程式前後皆要執行相關驗證；全量 Jest 指令為 `cd app && npm test`（已固定 `--runInBand`）。
- 新專案接手時先量一次全量測試輸出大小；超過 20,000 bytes 時，全跑採安靜摘要模式，失敗的測試再單獨以完整輸出重跑。
- 測試必須驗證商業意圖，而非只驗證實作細節；不得為了通過而削弱或修改既有測試。
- 報告真實測試結果，包含失敗、跳過與既有紅燈；沒有完整驗證不可宣稱完成。

### 已知測試環境問題（2026-08-25 基線）

- 乾淨工作樹執行 `cd app && npm test` 時，會啟動 `EXCEL.EXE` 與 Jest/Node 子程序，且可能在 Jest 輸出摘要前長時間卡住並留下 Excel 鎖定檔 `app/templates/~$*.xlsm`。若發生，先確認子程序命令列確為該次 `npm test`，再終止該次程序並移除鎖定檔；不可將其誤報為程式測試失敗。
