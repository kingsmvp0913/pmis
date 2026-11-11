# pmis-queue:自動修正佇列

這個 repo 只放承辦人送來的辨識問題與處理狀態,**必須是私人 repo**。流程說明見程式 repo 的
`docs/自動修正流程.md`。原始檔處理完會被刪掉,歷史也會被壓掉,不會留在這裡。

## 一次性設定

1. **建 repo**:GitHub 右上 `+` → New repository,名稱 `pmis-queue`,選 **Private**,勾 **Add a README file**
   (要有第一個 commit,PMIS 才推得進來)。
2. **放 workflow**:把這個資料夾裡的 `.github/workflows/fix-queue.yml` 放到新 repo 的同一個路徑
   (網頁上 Add file → Create new file,檔名打 `.github/workflows/fix-queue.yml`,貼上內容)。
3. **權杖一:給使用者電腦用**(Settings → Developer settings → Fine-grained tokens → Generate):
   - Repository access 選 `pmis` 與 `pmis-queue` 兩個
   - Permissions → Contents:`pmis` 選 **Read-only**、`pmis-queue` 選 **Read and write**
   - 填進使用者電腦的 `data/config.json`:`"GITHUB_TOKEN": "<權杖>", "QUEUE_REPO": "<帳號>/pmis-queue"`
4. **權杖二:給 workflow 推修正用**(同上建一組):只選 `pmis`,Contents **Read and write**。
   放到 `pmis-queue` 的 Settings → Secrets and variables → Actions → **Secrets**,名稱 `PMIS_PUSH_TOKEN`。
5. **Claude 憑證**:在有 Claude 訂閱的電腦執行 `claude setup-token`,把印出的權杖放到同一處 Secrets,
   名稱 `CLAUDE_CODE_OAUTH_TOKEN`。
6. **程式 repo 名稱**:同一頁切到 **Variables**,新增 `PMIS_REPO` = `<帳號>/pmis`。

## 外流時

任一組權杖外流,到 GitHub 的 Fine-grained tokens(或 `claude setup-token` 重發)撤銷重建即可。
使用者電腦那組只能讀程式、寫佇列;推修正那組只在 workflow 最後一步出現,Claude 拿不到。
