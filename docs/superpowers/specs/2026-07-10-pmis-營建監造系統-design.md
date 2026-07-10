# PMIS 營建監造管理系統 — 設計書

- **日期**:2026-07-10
- **狀態**:設計待審閱
- **專案路徑**:`C:\pmis\`
- **平台**:僅 Windows
- **取代**:本設計取代舊的 `2026-07-02-pmis-design.md`(舊設計為通用「廠商×報表對應引擎」,與本次結構化營建管理需求為不同系統)。

---

## 1. 系統目的

一套本機營建監造管理系統,供**不懂程式的使用者**管理:營造廠商、學校、保險公司、工程四張主檔,並把各廠商繳交的**施工日誌**(每家格式不同)轉成**固定格式的監造報表與公文**,同時追蹤每月繳交狀態。

核心價值:
- 主檔一次設好,工程關聯自動帶入。
- 廠商施工日誌格式再亂,也能經由**離線產生的讀取模組**萃取成固定監造報表——**產線不呼叫 AI、金額 deterministic**。
- 每月繳交狀態一目了然(綠=已繳 / 紅=未繳),依結算日自動算截止。

---

## 2. 技術架構(照 odoo-v2 重構)

| 層 | 做法 |
|---|---|
| 後端 | Node.js + Express,`app/server/` 每個領域一個 `*-routes.js`,各自 `registerRoutes(app)` |
| 資料庫 | PostgreSQL(`pg`)+ `app/server/db.js`(`getPool()` / `migrate()` / `query()`),schema 以 `CREATE TABLE IF NOT EXISTS` 冪等建立;測試用 `pg-mem` 注入 |
| 多使用者 | JWT(Bearer token)+ `bcryptjs`;首次啟動 `/api/setup/status` 回報 `needsSetup`,引導建立管理員;`verifyToken` middleware 保護 API |
| 前端 | 原生 JS SPA:`app/public/js/views/*.js`(一個 view 一檔)、`app.css`(dark-aware CSS 變數)、`dialog.js`、`api.js`、`app.js` 路由 |
| 安裝/啟動 | `install.ps1`(winget 靜默安裝 Node LTS + PostgreSQL 17,再跑 `scripts/setup.js` 建 DB、跑 migration、建管理員)+ `start.ps1`(背景啟動、自動開瀏覽器) |
| 服務埠 | `localhost:4141`(避開 odoo-v2 的 3939) |
| 檔案 | 上傳/產出檔存 `data/`;DB 只存相對路徑 |

### 2.1 資料夾結構(規劃)

```
C:\pmis\
├── install.ps1                  ← 一鍵安裝(winget + setup)
├── start.ps1                    ← 一鍵啟動
├── package.json
├── app\
│   ├── server\
│   │   ├── index.js             ← Express 進入點(埠 4141)
│   │   ├── db.js                ← PostgreSQL pool + migrate + query
│   │   ├── auth.js              ← JWT + 首次設定
│   │   ├── vendor-routes.js     ← 廠商 + 聯絡人 + 批次匯入(見 §9)
│   │   ├── school-routes.js     ← 學校 + 聯絡人
│   │   ├── insurer-routes.js    ← 保險公司 + 險種
│   │   ├── project-routes.js    ← 工程 + 規劃設計費
│   │   ├── history-routes.js    ← 歷史紀錄 / 繳交狀態 / 上傳 / 下載 / 刪除
│   │   ├── report.js            ← 監造報表 + 公文 產生引擎(待範本,見 §7)
│   │   ├── settings.js          ← 系統設定(結算日)
│   │   ├── admin-routes.js      ← 使用者管理
│   │   └── parsers\
│   │       ├── filetypes\       ← 共用檔型讀取器(xlsx / docx / pdf → 原始結構)
│   │       ├── registry.js      ← vendor_id / 格式鍵 → 讀取模組 dispatcher
│   │       └── vendors\         ← 每廠商一支讀取模組(由 skill 產生,見 §8)
│   ├── public\
│   │   ├── css\app.css
│   │   ├── js\{app.js,api.js,dialog.js,theme.js,views\*.js}
│   │   └── index.html
│   └── scripts\setup.js
└── data\
    ├── uploads\                 ← 上傳的施工日誌原檔
    └── output\                  ← 產出的監造報表 / 公文
```

---

## 3. 資料模型

```
users                 id, username, password_hash, role, active, created_at
settings              key, value      -- settlement_day(結算日 1–28)

vendors               id, name, created_at
vendor_contacts       id, vendor_id, name, phone, email, line_id, is_primary

schools               id, name, county          -- county = 台灣縣市
school_contacts       id, school_id, name, phone, email, line_id, is_primary

insurers              id, name
insurance_types       id, insurer_id, name

projects              id, project_no,           -- 工程編號,手動 KEY IN
                      name,
                      vendor_id  -> vendors,
                      school_id  -> schools,
                      start_date            NULL,   -- 開工日(可空)
                      contract_completion_date NULL, -- 契約竣工日(可空)
                      actual_completion_date   NULL, -- 實際竣工日(建立時空,竣工才填)
                      award_amount          NULL,   -- 決標金額(空=未招標)
                      insurer_id -> insurers,
                      insurance_type_id -> insurance_types,
                      insurance_start, insurance_end,
                      design_fee_type,      -- 'lump_sum' | 'pct'
                      design_fee_amount,    -- 總包價法:金額
                      design_fee_pct,       -- 建造費用百分比:%
                      created_at

submission_history    id, project_id -> projects,
                      period,               -- 應繳週期(年月,如 2026-07)
                      type,                 -- 'monthly' | 'supervision'(督導)
                      daily_log_path,       -- 上傳的施工日誌原檔(相對 data/uploads)
                      official_doc_path,    -- 產出公文(相對 data/output)
                      report_path,          -- 產出監造報表(相對 data/output)
                      deadline,             -- 依結算日算出的截止日
                      submitted_at,         -- 實際上傳時間
                      created_at
```

### 3.1 已確認的規則

1. **規劃設計費**
   - `lump_sum`(總包價法):實際金額 = `design_fee_amount`。
   - `pct`(建造費用百分比):實際金額 = `award_amount × design_fee_pct%`(**基數採決標金額**;決標金額未填時無法計算,畫面顯示「未招標,待補」)。
2. **聯絡人**:廠商與學校聯絡人結構相同 — 姓名 / 電話 / Email / LineID + `is_primary`(可多筆,勾一位主要)。
3. **工程的險種**:下拉從所選保險公司的 `insurance_types` 連動帶出。
4. **決標金額**未填 = 未招標(語意)。
5. **實際竣工日**建立時為空,竣工才填。

---

## 4. 畫面 / 選單(其餘原生功能一律隱藏)

| 選單 | 內容 |
|---|---|
| **登入** | 首次啟動導向建立管理員 |
| **廠商** | list + 搜尋;編輯:名稱 + 多聯絡人(勾主要);**批次匯入**(見 §9) |
| **學校** | list + 搜尋;名稱、學區(縣市下拉)、多聯絡人 |
| **保險公司** | list;名稱 + 多險種(只有名稱) |
| **工程** | list + 搜尋;編輯全部欄位;**點開展開「歷史檔案」區**(見 §5) |
| **系統設定** | 結算日(1–28) |
| **使用者管理** | admin:新增 / 停用使用者、改密碼 |

---

## 5. 工程歷史檔案 + 繳交狀態

### 5.1 歷史檔案區(工程 list 點開)

- 每筆歷史紀錄一列,**已繳綠色、未繳紅色**。
- 一個「**產生監造報表**」按鈕 → 彈窗:
  1. 選 **督導 / 每月**。
  2. 上傳施工日誌檔。
  3. 建立一筆 `submission_history`;`type=supervision` 時為**額外多插一筆**(內容格式相同,只差分類標記)。
- 每筆可下載 **公文**、**監造報表**(產出檔)。
- 每筆可**刪除**(避免傳錯)→ 同時刪除 `data/` 內對應的 `daily_log_path` / `official_doc_path` / `report_path` 實體檔。

### 5.2 繳交狀態(綠 / 紅)邏輯

- 系統設定 `settlement_day`(如 5)→ 每月截止日 = **當月該日**(例:結算日 5 → 7 月當期須於 7/5 前繳)。
- 每個工程、每個月一個「應繳週期」。
- 該週期**已有監造報表紀錄 = 綠(已繳)**;已到期仍無紀錄 = **紅(未繳)**。
- `deadline` 於建立紀錄時依結算日算出並存入。

---

## 6. 施工日誌 → 監造報表 pipeline(核心)

### 6.1 問題本質

各廠商施工日誌**檔型與版面全不同**(實例:A 家玉森 = Word 施工日誌 + Excel 第二聯;B 家金大竹崎 = 單一 PDF 第二聯,逐日一頁),但都要轉成**同一份固定監造報表**。系統無法自動猜對應 → 需 per 廠商設定,這是需求第 8 點「初始化」的由來。

### 6.2 解法:離線產生的 plugin 讀取器(產線不接 AI)

- **每廠商(或每格式)一支讀取模組** `app/server/parsers/vendors/<key>.js`,實作統一介面:
  ```
  parse(filePath) -> { header: {...固定欄位}, dailyRows: [{...逐日}] }
  ```
- 共用**檔型讀取器** `parsers/filetypes/`(Excel 用 `xlsx`、Word 用解 XML / `mammoth`、文字型 PDF 用 `pdf-parse`)負責把檔案讀成原始結構;廠商模組負責把原始結構對應到監造報表欄位。
- `parsers/registry.js` 依工程的 `vendor_id`(或格式鍵)挑對應模組。
- **讀取模組由 `gen-vendor-parser` skill 在開發/設定階段產生並 commit(見 §8);執行時純 deterministic,不呼叫任何 AI、不需 API 金鑰、可離線、金額精準。**
- 新增一家廠商 = 提供其施工日誌樣本 → 跑 skill 產一支模組 → 放進系統。**使用者不寫程式、產線不接 AI。**

### 6.3 逐日彙總(待範本定案)

施工日誌是**逐日**資料,監造報表(每月 / 督導)為**一週期一張彙總**。「逐日列 → 該期一張報表」的彙總規則,需看到監造報表範本才能定稿。

---

## 7. 範圍切分(監造報表 / 公文 範本尚未提供)

| 現在做(第一階段) | 待監造報表 / 公文 範本到位再做(第二階段) |
|---|---|
| 四張主檔 + 聯絡人 + 規劃設計費 + 工程編號 | 讀取模組**輸出欄位定稿**(= 報表需要的欄位) |
| 多使用者 + 一鍵安裝 + odoo-v2 樣式基座 | 逐日 → 該期彙總規則 |
| 廠商批次匯入 | **填入固定監造報表範本 → 產出** |
| 施工日誌上傳、存檔、歷史紀錄、督導多插一筆 | **依固定格式產出公文**(帶工程主檔欄位) |
| 繳交狀態(綠/紅)、結算日、到期計算 | plugin 讀取器架構落地 + 各廠商模組(逐一由 skill 產) |
| 下載原始檔、刪除(連檔) | `gen-vendor-parser` skill 實作 |

> 第一階段完成即為可用的管理系統。範本一到,補上「讀取模組定稿 + 彙總填範本 + 公文產生」即接上。

---

## 8. Skill:`gen-vendor-parser`(產生廠商讀取檔)

- **用途**:把「離線產生廠商讀取模組」制度化;onboard 新廠商格式時呼叫。
- **觸發**:`/gen-vendor-parser`。
- **輸入**:廠商識別鍵 + 該廠商施工日誌樣本路徑 + 監造報表目標欄位 schema。
- **流程**:
  1. 偵測檔型(xlsx / xls / docx / pdf)。
  2. 用共用檔型讀取器分析原始結構(表頭、表格、關鍵 cell、逐日列)。
  3. 把來源結構對應到監造報表目標 schema。
  4. **產生** `app/server/parsers/vendors/<key>.js`(實作 §6.2 統一介面,只用共用檔型工具,無 AI 呼叫)。
  5. **產生 fixture 測試**:用樣本斷言已知值(如工程名稱、某日「本日完成金額」),確保讀取正確(Rule 9:測試驗證意圖)。
  6. 於 `registry.js` 註冊 `vendor_id → 模組`。
  7. 回報對應了哪些欄位、哪些找不到(標紅給人工補)。
- **護欄**:金額類欄位一律追溯到具體 cell / 位置;找不到就留空 + 警告,**絕不編造數字**。

---

## 9. 廠商批次匯入

- 廠商 list 提供「批次匯入」:貼上名稱(一行一家)。
- 系統**去除空行、去重、跳過已存在**,只建立新廠商。
- 動機:實際名單常帶重複與空行(來自「每工程對應廠商」的原始資料);此功能一次建立、日後沿用,且**不把名單寫死進程式**。

---

## 10. 元件職責(單一職責、可獨立測試)

| 元件 | 職責 |
|---|---|
| `db.js` | PostgreSQL 連線池 + 冪等 migration + query 包裝 |
| `auth.js` | JWT 簽發/驗證、首次設定、密碼雜湊 |
| `*-routes.js` | 各主檔 / 歷史 / 設定 / 使用者 的 REST API |
| `parsers/filetypes/*` | 各檔型 → 原始結構(統一輸出) |
| `parsers/vendors/*` | 各廠商 → 監造報表欄位(deterministic,skill 產) |
| `parsers/registry.js` | 依廠商挑讀取模組 |
| `report.js` | 依讀取結果填入固定監造報表 / 公文範本(第二階段) |
| `views/*.js` | 各畫面(list / 編輯 / 歷史 / 設定 / 使用者) |

---

## 11. 錯誤處理

- **施工日誌解析失敗 / 格式不符** → 明確中文錯誤,標示偵測到的檔型,不中斷其他流程。
- **金額欄位找不到** → 該欄留空 + 警告標註,不靜默略過、不猜值。
- **決標金額未填但選建造費用百分比** → 顯示「未招標,設計費待補」,不硬算。
- **刪除歷史紀錄** → 先刪實體檔再刪 DB 列;任一步失敗明確回報。
- 原生 SQL 前 `flush` / 後 `invalidate`(比照專案慣例,避免快取不同步)。

---

## 12. 測試策略

- **主檔 CRUD**:廠商/學校/保險公司/工程 建立、聯絡人多筆、主要聯絡人唯一性。
- **規劃設計費**:兩種類型計算(含決標金額未填時的行為)。
- **繳交狀態**:給定結算日與紀錄,驗證綠/紅與 `deadline` 計算(Rule 9:督導多插一筆、到期未繳必須為紅)。
- **批次匯入**:去重、跳過已存在、忽略空行。
- **讀取模組**:每支 vendor parser 用真實樣本 fixture 驗證抽出的欄位與金額正確。
- **刪除連檔**:刪紀錄後實體檔確實不存在。

---

## 13. 範圍界線(YAGNI)

**納入**:四張主檔 + 聯絡人、規劃設計費、工程編號、多使用者、一鍵安裝、施工日誌上傳/歷史/繳交狀態/結算日、批次匯入、plugin 讀取器架構、`gen-vendor-parser` skill、(第二階段)監造報表/公文產生。

**不納入**:非需求提到的原生功能(選單隱藏)、雲端部署、產線 AI 呼叫、OCR(掃描件)、使用者自寫 SQL。

---

## 14. 待使用者於實作前提供

- **監造報表固定範本**(Excel/Word)— 決定讀取模組輸出欄位、彙總規則、填表輸出。
- **公文固定範本**— 決定公文產生的欄位來源與版面。
