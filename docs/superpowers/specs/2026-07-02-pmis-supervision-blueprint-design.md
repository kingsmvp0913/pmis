# 監造 PMIS 總體藍圖 — 設計書

- **日期**:2026-07-02
- **狀態**:設計待審閱(藍圖層級,各階段實作前另需獨立詳細規格)
- **專案路徑**:`C:\pmis\`
- **前置文件**:`2026-07-02-pmis-design.md`(V1 廠商報表系統)、`2026-07-02-pmis-calendar-design.md`(交件行事曆)

---

## 1. 目的與範圍

現有 `C:\pmis` 是一套聚焦的「廠商報表自動化 + 交件追蹤」工具,只服務單一工程案的隱含假設。本文件規劃如何把它擴建成一套完整的**監造(工程監督)PMIS**,涵蓋監造廠商行政工作的六大職責領域,並同時支援**多個工程案並行**。

**本文件是藍圖,不是實作規格**。它定義:整體架構決策、模組地圖與資料模型關聯、分期路線圖。每個階段(P1~P4)在真正實作前,仍需各自走一次完整的 brainstorming 流程,產出獨立的詳細設計書(比照 `pmis-calendar-design.md` 的模式)。

---

## 2. 背景與現況

現有系統(已上線,v1 + 追加功能):
- 廠商管理、報表範本管理(自動抽欄位)、欄位對應(自動建議)
- 單筆 / 多廠商彙總報表產出
- 交件追蹤(應交 / 已交 / 未交,依期別)
- 交件行事曆(**已設計、尚未實作**)
- PDF 匯出與歸檔、數字驗算、上期資料帶入、範本版本歷史
- 多人帳號與權限(admin / staff,功能層級勾選)

**核心缺口**:資料模型完全扁平(`vendors`、`reports`、`mappings`、`outputs`…皆無工程案歸屬),等於預設只服務一個工程案。但公司實際上**同時監造多個工程案**,這是驅動本次重新規劃的根本原因。

---

## 3. 核心架構決策

### 3.1 新增「工程案(Project)」頂層容器

```sql
CREATE TABLE projects (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,       -- 工程案名稱
    code         TEXT,                -- 案號(選填)
    owner_org    TEXT,                -- 業主單位
    location     TEXT,                -- 工地地點
    start_date   TEXT,
    end_date     TEXT,
    status       TEXT DEFAULT 'active',  -- active / closed
    note         TEXT,
    created_at   TEXT NOT NULL
);
```

現有表全部加上 `project_id INTEGER NOT NULL REFERENCES projects(id)`:
`vendors`、`reports`、`vendor_templates`、`mappings`、`outputs`、`report_vendors`、`submissions`、`report_deadlines`。

**既有資料遷移**:升級時自動建立一筆「既有工程案」(名稱由使用者於安裝後首次登入時命名),並把所有既有資料回填該 `project_id`,確保零資料遺失、不需使用者手動搬移。

### 3.2 使用者權限延伸為「工程案範圍」

新增 `project_users` 對應表(使用者 × 工程案),決定該員能看到哪些工程案:

```sql
CREATE TABLE project_users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
```

- `admin` 角色維持現有慣例:不受此表限制,一律全開(所有工程案)。
- `staff` 角色:除了既有的「功能層級」權限(管理廠商 / 報表 / …),再加一層「工程案範圍」——沒被指派的工程案完全看不到,含選單、資料、URL 直接存取皆需擋。
- 這是既有系統從未存在的維度(單案時不需要),多案架構下必須補齊,否則會有跨案資料外洩風險。

### 3.3 技術棧維持不變

延續 FastAPI + SQLite + Jinja2(伺服器端渲染)+ `.bat` 安裝/啟動的現有模式,`localhost:4141`。不引入新框架、不換資料庫。理由:公司規模與並行案量目前評估不會超出 SQLite 承載能力,維持現有技術棧改動成本最低、風險最可控。若未來實際使用量證明有瓶頸,再單獨評估換 PostgreSQL(不在本次範圍內)。

---

## 4. 六大模組地圖

```
工程案(Project) ─┬─ 契約管理(Contract)          [P3]
                  ├─ 進度管理(Progress)           [P1]
                  ├─ 品質管理(Quality)            [P2]
                  ├─ 文件與公文流程(Document)      [P0,已完成]
                  ├─ 估驗計價(Payment)            [P1.5,見 4.4]
                  └─ 會議與追蹤事項(Meeting)       [P4]
```

### 4.1 文件與公文流程(Document)—— 現有系統整併

現有的 vendors / reports / mappings / outputs / tracking / calendar 直接定位為此模組,不重寫。加上 `project_id` 後即完成整併,無需重新設計核心邏輯。

**未來可能擴充(明確不在本次範圍)**:正式公文簽核流程(業主 ↔ 監造 ↔ 承包商三方往來函文,含簽核鏈)。現有系統只處理「廠商報表」,不處理「公文」,兩者資料形狀不同,若要做需另開規格。

### 4.2 進度管理(Progress)—— P1

```sql
CREATE TABLE progress_baselines (   -- 計畫進度(里程碑)
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id),
    milestone   TEXT NOT NULL,
    planned_date TEXT NOT NULL,
    weight_pct  REAL,               -- 權重(供計算整體進度%)
    sort        INTEGER DEFAULT 0
);

CREATE TABLE progress_reports (     -- 實際進度回報(依期別)
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id),
    period      TEXT NOT NULL,       -- 沿用既有 period 字串慣例
    planned_pct REAL,
    actual_pct  REAL,
    variance_note TEXT,              -- 落後原因說明
    reported_at TEXT NOT NULL
);
```

延伸既有 `submissions`/`period` 的資料慣例(承包商回報 → 監造覆核),與現有交件追蹤同一套「期別」邏輯,技術風險低、可直接沿用現有 UI 樣式(表格化中文介面)。落後預警:`actual_pct < planned_pct` 時標紅,顯示於 `/tracking` 或新頁面。

### 4.3 品質管理(Quality)—— P2

```sql
CREATE TABLE quality_inspections (  -- 抽驗記錄
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id),
    item        TEXT NOT NULL,       -- 抽驗項目
    inspected_at TEXT NOT NULL,
    result      TEXT NOT NULL,       -- pass / fail
    note        TEXT
);

CREATE TABLE material_tests (       -- 材料試驗
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id),
    material    TEXT NOT NULL,
    test_report_no TEXT,
    tested_at   TEXT,
    result      TEXT,
    file_path   TEXT                -- 試驗報告附件
);

CREATE TABLE nonconformances (      -- 不合格改善追蹤(NCR)
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id),
    inspection_id INTEGER REFERENCES quality_inspections(id),
    description TEXT NOT NULL,
    status      TEXT DEFAULT 'open',  -- open / improving / closed
    due_date    TEXT,
    closed_at   TEXT
);
```

NCR 是監造法定核心職責,狀態機(open → improving → closed)需要獨立頁面追蹤,類似現有交件追蹤的「缺件標紅」概念,可重用該 UI 模式。

### 4.4 估驗計價(Payment)—— 與 P1 同期或緊接其後

```sql
CREATE TABLE payment_applications (  -- 估驗計價單
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id),
    period      TEXT NOT NULL,
    amount      REAL NOT NULL,
    cumulative_amount REAL NOT NULL,
    cumulative_pct REAL NOT NULL,   -- 對契約金額的累計比例
    output_id   INTEGER REFERENCES outputs(id),  -- 若由現有報表工具產出,關聯過去
    approved_at TEXT
);
```

現有報表自動化工具若產出的是估驗單,可透過 `output_id` 關聯,金額追蹤邏輯(累計金額、累計%)獨立成表,不寄生在通用的 `outputs` 結構裡,避免把「金流」邏輯和「檔案產出」邏輯混在一起。依賴 `contracts.total_amount`(見 4.5),故技術上晚於或與契約管理同期規劃較合理,但實作可先於 P3(用手動輸入契約金額,不強制先做完整契約模組)。

### 4.5 契約管理(Contract)—— P3

```sql
CREATE TABLE contracts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id    INTEGER NOT NULL REFERENCES projects(id),
    total_amount  REAL NOT NULL,
    start_date    TEXT,
    end_date      TEXT,
    scope_note    TEXT
);

CREATE TABLE contract_changes (      -- 變更設計 / 追加減
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id   INTEGER NOT NULL REFERENCES contracts(id),
    description   TEXT NOT NULL,
    amount_delta  REAL NOT NULL,     -- 追加為正,追減為負
    approved_at   TEXT
);
```

變動頻率低,主要作為其他模組(尤其估驗計價)的基礎資料來源。

### 4.6 會議與追蹤事項(Meeting)—— P4

```sql
CREATE TABLE meetings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id),
    meeting_date TEXT NOT NULL,
    attendees   TEXT,
    minutes     TEXT
);

CREATE TABLE action_items (         -- 追蹤事項
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id  INTEGER REFERENCES meetings(id),
    project_id  INTEGER NOT NULL REFERENCES projects(id),
    description TEXT NOT NULL,
    owner       TEXT,
    due_date    TEXT,
    status      TEXT DEFAULT 'open',  -- open / done
    linked_ncr_id INTEGER REFERENCES nonconformances(id)  -- 選填,可連結品質追蹤
);
```

會議紀錄常會產出追蹤事項,而追蹤事項可能與品質模組的 NCR 是同一件事的兩種視角(會議中提出、品質模組追改善)——`linked_ncr_id` 允許關聯但不強制,避免耦合過緊。排在 P4 是因為與品質/進度模組有交集,建議等那兩塊有雛形後再整合,銜接會更自然。

---

## 5. 建議分期路線圖

| 階段 | 模組 | 狀態 |
|---|---|---|
| P0 | 文件與公文流程(現有)+ 交件行事曆實作 | 系統已完成,行事曆待實作 |
| P1 | 工程案分層改造(3.1/3.2)+ 進度管理 | 未開始 |
| P1.5 | 估驗計價 | 未開始,依賴 P1 的工程案分層 |
| P2 | 品質管理 | 未開始 |
| P3 | 契約管理 | 未開始 |
| P4 | 會議與追蹤事項 | 未開始 |

**排序理由回顧**:P1 進度管理與現有 `submissions`/`period` 資料形狀最接近,技術門檻最低、投入產出比最高,適合作為「工程案分層改造」的第一個驗證模組(等於一次做完架構升級 + 第一個新模組)。品質管理雖是監造法定核心職責,但獨立性高,排 P2 不影響優先做完架構基礎。契約與會議兩者變動頻率低或依賴其他模組先成形,排在後面。

**此順序尚未經使用者最終確認**,下次討論時需要重新拍板,也可能因公司實際痛點調整(例如你之後可能想把品質管理提到 P1)。

---

## 6. 範圍界線(本藍圖階段的 YAGNI)

**本文件納入**:整體架構決策(工程案分層、權限延伸、技術棧維持)、六大模組的概念性資料模型與模組邊界、分期路線圖。

**明確不納入(留待各階段獨立規格書處理)**:
- 每個模組的頁面 / 路由設計、UI 細節、錯誤處理規則
- 公文正式簽核流程(見 4.1,現有文件模組不含此功能)
- 資料庫換成 PostgreSQL 或其他技術棧升級
- 各模組的完整測試計畫

---

## 7. 待確認事項(下次討論時處理)

1. 分期順序(§5)是否照建議走,或依實際痛點調整。
2. `projects` 資料表欄位是否足夠(案號規則?是否需要業主聯絡窗口?)。
3. 工程案範圍權限(§3.2)的 UI 呈現方式(建立使用者時勾選工程案?或工程案頁面內指派成員?)。
4. P1(工程案分層改造 + 進度管理)的詳細規格 —— 下一次 brainstorming 的主題。

---

## 8. 決策紀錄(本次討論產生)

- 整併目標:重新設計成完整監造 PMIS,現有工具整併進去,不是外掛擴充(非維持現狀,非只是定位)。
- 需要「工程案」頂層容器:是,公司同時監造多個工程案。
- 技術整合方式:在現有 FastAPI + SQLite 基礎上擴建,不換技術棧。
