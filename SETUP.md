# 上傳到 GitHub 的操作指南

這份文件教你如何把這些設計文件推送到你的 GitHub repo `pcpcchen-coder/AIOS`。

**預估時間**：5 分鐘

---

## 前置檢查

在開始前，確認你的環境有：
- ✅ Git 已安裝（`git --version` 有輸出）
- ✅ GitHub 帳號已登入（本機有 SSH key 或 HTTPS 認證）
- ✅ 已建立 GitHub repo：https://github.com/pcpcchen-coder/AIOS

如果 GitHub repo 是空的（沒有 README、沒有 commits），選擇 **路徑 A**。
如果 repo 已經有內容，選擇 **路徑 B**。

---

## 路徑 A：全新的空 repo（推薦）

### Step 1：下載或解壓縮檔案

我幫你打包成一個 zip 檔（見對話中的下載連結）。下載後解壓到你想放的位置，例如：

```bash
cd ~/Projects
unzip nous-repo.zip
cd nous-repo
```

或者你直接把我提供的檔案手動放到一個新資料夾，結構會是：

```
nous-repo/
├── README.md
├── SETUP.md            ← 本文件
├── .gitignore
└── docs/
    ├── README.md
    ├── 01_Complete_Technical_Blueprint.md
    ├── 02_OSS_Component_Map.md
    ├── 03_3Month_Accelerated_Roadmap.md
    ├── 04_Generative_Interaction_System.md
    └── 05_Progress_and_Next_Steps.md
```

### Step 2：初始化 Git 並推送

在 nous-repo 資料夾內執行：

```bash
# 初始化 git
git init
git branch -M main

# 加入所有檔案
git add .

# 建立第一個 commit
git commit -m "Initial commit: Nous Cognitive OS design documents

- Complete 12-month technical blueprint
- OSS component map (integration-first strategy)
- 3-month accelerated roadmap
- Generative interaction system design
- Progress summary and next steps"

# 連接到你的 GitHub repo
git remote add origin https://github.com/pcpcchen-coder/AIOS.git

# 推送
git push -u origin main
```

**完成！** 打開 https://github.com/pcpcchen-coder/AIOS 應該就看到所有內容了。

---

## 路徑 B：repo 已經有內容

### Step 1：clone 現有的 repo

```bash
cd ~/Projects
git clone https://github.com/pcpcchen-coder/AIOS.git
cd AIOS
```

### Step 2：複製檔案進去

把我打包的檔案（README.md、SETUP.md、.gitignore、docs/ 資料夾）複製進 AIOS/ 資料夾。

如果 repo 已經有 README.md，會被覆蓋——如果你想保留舊的，先備份或改名（例如 `README_original.md`）。

### Step 3：commit 並 push

```bash
git add .
git commit -m "Add Nous Cognitive OS design documents"
git push
```

---

## 如果遇到問題

### 問題 1：`git push` 被拒絕（rejected）

代表 GitHub 端有你本機沒有的內容。解法：

```bash
git pull origin main --rebase
git push
```

### 問題 2：認證失敗

**HTTPS**：GitHub 已不接受密碼認證，需要 Personal Access Token：
1. 到 https://github.com/settings/tokens 建立 Token（勾 repo 權限）
2. 推送時輸入 Token 而非密碼

**SSH**（更方便，一次設定終身受用）：
1. 檢查是否有 SSH key：`ls ~/.ssh/id_*.pub`
2. 沒有的話產生一組：`ssh-keygen -t ed25519`
3. 把 `~/.ssh/id_ed25519.pub` 內容加到 https://github.com/settings/keys
4. 把 remote 改成 SSH 格式：
   ```bash
   git remote set-url origin git@github.com:pcpcchen-coder/AIOS.git
   ```

### 問題 3：檔案顯示不了中文或亂碼

確認你的終端機是 UTF-8。多數情況下 Git 會自動處理。

---

## 上傳成功後的檢查清單

打開 https://github.com/pcpcchen-coder/AIOS ，確認：

- [ ] README.md 在首頁顯示，內容正確
- [ ] docs/ 目錄可以進入，看到 5 份文件
- [ ] 中文顯示正常（GitHub 對中文支援良好）
- [ ] 檔案之間的內部連結可以點擊跳轉

---

## 下一步建議

上傳完成後，可考慮：

1. **設定 About 描述**：在 repo 右上角齒輪，加上 tagline
   - 建議：`Nous — Cognitive OS with Claude as Kernel. Design docs & roadmap.`

2. **加上 Topics**：讓 GitHub 幫你被搜到
   - 建議：`ai`, `claude`, `agent`, `mcp`, `cognitive-os`, `tauri`, `local-first`

3. **建立第一個 Issue**：追蹤下一階段的產出
   - 例如：「Produce Nous_Narrative.md (elevator pitch + 5 personas)」

4. **決定要不要公開**：目前如果是 Private，什麼時候轉 Public？我在文件裡有討論這件事。

---

## 有問題？

如果任何一步卡住，回來告訴我錯誤訊息，我幫你 debug。
