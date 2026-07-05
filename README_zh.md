# Agent Cost Lens

分析 Codex / Code 類 AI 代理的 session log (`*.jsonl`) — 視覺化 Token 用量、估算 API 成本，並找出優化機會。

---

## 功能特色

- **解析引擎** — 讀取 `~/.codex/sessions/` 下的 Codex session log，按日、專案、session、turn、step 彙總
- **儀表板** — 單一 HTML 頁面，三個主要視圖：
  - **統計** — 按專案、模型、工具、技能、session 分組顯示成本、Token 用量、快取率
  - **搜尋** — 全文搜尋 session，可逐層下鑽查看 Turn / Step / 子代理細節
  - **優化建議** — 使用 Cost Lens 分數找出可能有 Token burn 的 session
- **即時監控** — 顯示目前 rate limit、花費、快取效率與最新 session
- **成本估算** — 依模型定價（GPT‑5.5 / 5.4 / 5.4 Mini），區分快取與非快取 Input Token
- **無資料庫** — 完全依賴靜態 JSON 檔，無需伺服器端儲存

---

## 快速開始

### 環境需求

- Node.js ≥ 18
- Codex session log 位於 `~/.codex/sessions/`（由 Codex Desktop 或 CLI 自動產生）

### 執行

```bash
git clone https://github.com/FreemanTsai/agent-cost-lens.git
cd agent-cost-lens
bash start.sh
```

`start.sh` 會解析近期 log、用 `0.0.0.0:8080` 啟動伺服器，並開啟儀表板。同一個區網內的其他裝置可以用這台機器的 LAN IP 連線：

```bash
ipconfig getifaddr en0
# 然後開啟 http://<LAN-IP>:8080
```

或逐步執行：

```bash
# 解析 log → 產生每日 JSON + Cost Lens 報告
node scripts/parse-codex-logs.mjs

# 啟動開發伺服器
node scripts/server.mjs
```

在瀏覽器中開啟 [http://localhost:8080](http://localhost:8080)。

手動指定伺服器綁定位置：

```bash
HOST=0.0.0.0 PORT=8080 node scripts/server.mjs
```

### CLI 參數

```bash
node scripts/parse-codex-logs.mjs --date=2026-06-15    # 只處理指定日期
node scripts/parse-codex-logs.mjs --date-only          # 跳過優化分析，只產生每日 JSON
node scripts/parse-codex-logs.mjs --all                # 處理所有可用 log 檔
```

---

## 專案結構

```
.
├── scripts/
│   ├── parse-codex-logs.mjs    # 主要解析器 — 讀取 .jsonl，產生每日 JSON + Cost Lens 報告
│   └── server.mjs              # 靜態檔案伺服器 + refresh API（無需框架）
├── start.sh                    # 一鍵啟動（解析 + 伺服器 + 開啟瀏覽器）
├── package.json
├── LICENSE                     # MIT 授權
├── .nvmrc                      # Node.js 版本鎖定
├── test/
│   └── server.test.mjs         # 伺服器整合測試
├── public/
│   ├── index.html                              # 儀表板（統計 + 搜尋 + 優化建議）
│   ├── monitor.html                            # 即時監控
│   └── data/                                   # 每日用量資料（自動產生，git 忽略）
└── DESIGN.md                   # 設計系統參考
```

---

## 即時監控

開啟 [http://localhost:8080/monitor.html](http://localhost:8080/monitor.html) 可以即時查看：

- 目前 rate limit 視窗
- 預估花費與 Token 用量
- 快取命中率
- 最新 session 與下鑽細節

監控頁會透過本機伺服器刷新資料，並使用 `public/data/` 中產生的 JSON 檔。

---

## Cost Lens 分析

**優化建議** 頁面顯示 Cost Lens：依 session 的疑似 token burn 程度排序。每個 session 從 `100` 分開始，命中的 reason 會扣分，儀表板會依優先順序顯示第一個命中的 **Primary Reason**。

| 優先順序 | Primary Reason | 觸發條件 | 扣分 |
|---------:|----------------|----------|-----:|
| 1 | Repeated Rework | 連續執行驗證指令，中間沒有 edit 或不同指令打斷 | low 5, medium 10, high 20 |
| 2 | Search Heavy / Low Edit | `rg` + `sed` + `cat` >= 10，且 search/edit ratio >= 10:1 | medium 6, high 12 |
| 3 | Test Heavy / Low Edit | test 指令 >= 5，且 test/edit ratio >= 5:1 | medium 5, high 10 |
| 4 | Context Heavy | effective input tokens 偏高 | low 1, medium 3, high 6 |
| 5 | High Verification Activity | build/lint/test 合計 >= 8，且 test 指令 < 5 | medium 4, high 8 |

報告會寫入 `public/data/codex-burn*.json`。`public/data/codex-optimize.json` 與各期間的 `public/data/codex-optimize*.json` 仍保留為空的相容報告，供儀表板載入流程使用。

---

## 定價

| 模型            | Input ($/1M tok) | Cached ($/1M tok) | Output ($/1M tok) |
|-----------------|------------------:|-------------------:|-------------------:|
| GPT‑5.5         |              5.00 |               0.50 |              30.00 |
| GPT‑5.4         |              2.50 |               0.25 |              15.00 |
| GPT‑5.4 Mini    |              0.75 |               0.075 |               4.50 |

快取計費：`cache_writes = 1.25 × input_price`，`cache_reads = 0.10 × input_price`。

---

## 資料模型

```
Project
 └─ Session              (一個 .jsonl 檔)
     └─ Turn             (一則使用者訊息 → 一輪 Codex 回應)
         └─ Step         (單次工具呼叫 / 回應)

Session
 ├─ projectName — 工作目錄的目錄名稱
 ├─ sessionId   — 從 rollout 檔名中擷取
 ├─ turns[]     — 使用者 → Codex 的 turn 群組
 ├─ costUsd     — 累計各 step 成本
 └─ tokens      — input、cachedInput、output、reasoningOutput
```

每日 JSON 檔按天產生，避免大型資料集導致記憶體問題。

---

## 授權

MIT
