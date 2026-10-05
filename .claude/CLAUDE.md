# CLAUDE.md

<!-- platform-only -->
## Skills
- **getSQL** (`.claude/skills/getSQL/SKILL.md`) - 透過 SSH-SQLM API 查詢遠端 PostgreSQL。觸發：`/getSQL`
When the user types `/getSQL`, invoke the Skill tool with `skill: "getSQL"` before doing anything else.
<!-- /platform-only -->

## 0. Hard Rules
- NEVER modify core Odoo files or `custom_addons/`. 自訂程式一律寫在「當前任務所在的 repo／addons 目錄」內——實際路徑由執行時的 agent prompt 指定；不得寫死或存取工作目錄以外的絕對路徑（如 `online_addons`）。
- NEVER guess intent. Surface 2–3 interpretations when ambiguous; state one core assumption before complex tasks. When still uncertain after surfacing interpretations, ask — do not proceed on a guess.
- Stop when confused. Name what's unclear before continuing.
- NEVER add fields/models/logic beyond the task's agreed spec.
- 寫入專案檔案時一律使用相對路徑或環境變數，**禁止寫死任何絕對路徑**（包括 `C:\` 或 `/home/...`）。
- Think in English. Output Traditional Chinese (Taiwan). No preambles.
- Challenge proposals that violate best practices, security, or performance.
- 不得在未經使用者明確同意下修改工作流程設定（hook、`settings.json`、CI、本檔）。

## 2. Edit Protocol
- Commit: `[Module]: Why (not what)`. File edit: `@Path | Anchor | Action`.
- **Minimum code that solves the problem.** No speculative features. No abstractions for single-use code. (Test: would a senior engineer call this overcomplicated?)
- Touch only what you must. Don't clean up adjacent code, comments, or formatting that isn't yours.
- Match existing code style exactly. Zero drive-by refactoring.
- Before adding code, read exports, immediate callers, and shared utilities. "Looks orthogonal" is dangerous — if unsure why code is structured a certain way, ask.
- Conformance > personal taste inside the codebase. Follow conventions even when you disagree.
- If a codebase convention seems harmful, surface it explicitly. Don't fork silently.
<!-- platform-only -->
- 前端（`app/public`）配色一律走 `app.css` 的 CSS 變數／dark-aware class（如錯誤框套 `.error-msg`）；禁止在 inline style 寫死淺色 `background`（`#fff`/`#fef2f2`/`#f8fafc` 等）而不同時寫死可讀文字色——否則深色模式文字色吃 `var(--text)` 翻白＝隱形。底色需區隔時用 `var(--bg)`/`var(--surface)` 等變數，勿寫死。
<!-- /platform-only -->
- `[Step] → [Verify]`：每步完成後跑受影響的測試（跑法見 `app/package.json`）。

## 3. Output Style
繁中術語：專案/資料庫/佈署/模組. Keep English: Variable/Function/Hook/Class/Field/Model/Method/Controller.

## 4. General Engineering Rules

**Rule 4 — Goal-Driven Execution**: Define success criteria before starting. Iterate until verified. Don't follow steps mechanically; define success and drive to it. Strong success criteria enable independent looping.

**Rule 6 — Context Breaks**: When context is compacted or work continues in a new session, state explicitly what was not carried over.

**Rule 7 — Surface Conflicts, Don't Average Them**: If two patterns contradict, pick one (more recent / more tested). Explain why. Flag the other for cleanup. Don't blend conflicting patterns.

**Rule 9 — Tests Verify Intent**: Tests must encode WHY behavior matters, not just WHAT it does. A test that can't fail when business logic changes is wrong.

**Rule 10 — Checkpoint After Every Significant Step**: Summarize what was done, what's verified, and what's left. Don't continue from a state you can't describe back. If you lose track, stop and restate.

**Rule 12 — Fail Loud**: "Completed" is wrong if anything was skipped silently. "Tests pass" is wrong if any were skipped. Default to surfacing uncertainty, not hiding it.

## 6. 跑測試（`app/` Node 專案）

**測試的實測結論與注意事項一律寫進記憶，不要寫進本檔。** 哪支 flaky、哪支要帶什麼旗標、
目前有幾支測試、已知紅燈是什麼——這些都會隨 commit 漂移，寫進規則檔遲早變成**錯的指令**，
而錯的規則比沒有規則更貴（下個 session 會照著錯的做，還以為有權威依據）。
本檔只留這條「去哪裡看」的規定。

- 跑法看 `app/package.json`；輸出精簡看全域規則；**測試數字一律當場跑，不記在任何文件裡**。
- 其餘（必帶的環境旗標、已知 flaky、已知紅燈、隔離陷阱）看記憶索引 `MEMORY.md` 裡
  「跑測試」那一則。
