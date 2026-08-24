# Market Intelligence Signal Engine V1

## 定位

Market Intelligence Signal Engine V1 是一個 **offline、pure TypeScript、deterministic** 的市場訊號治理引擎。它只接收已由上游取得的 bounded metadata snapshot，進行格式驗證、正規化、簡單統計與市場假設範圍檢查；它不是 crawler、不是搜尋引擎、不是 Google 或 Meta API client，也不是引用、排名、流量或投資建議生成器。

本版本的輸出只能描述「在指定 observation window 內觀察到的訊號」，不能把市場興趣或廣告活動誤稱為市場規模、搜尋量、因果關係、市占率、產品品質、轉換率、SEO/GEO 曝光、AI citation、流量、ROI 或 factual proof。輸出中的 metrics 是治理與排序訊號，不是 truth score。

## 為什麼不是每一個市場問題都能直接用訊號

市場訊號是有限、相對且帶有觀察偏差的資料。Google Trends 的時間序列在 V1 中被視為相對興趣 observation；即使數值上升，也不能單獨證明真實需求、購買意圖或任何 factual claim。Meta Ad Library snapshot 只表達在 bounded window 內觀察到的廣告活動；有廣告不等於有較高品質、較高市占或較好的商業結果。

因此引擎不會把一個訊號偷偷 fallback 成其他證據等級。請求如果把 market signal 當成 `factual_claim`、`ranking_claim` 或 `investment_claim`，會直接回傳 `rejected` 與 `UNSUPPORTED_CLAIM_USE`。只有 `market_hypothesis` 可以進入評估流程，而且輸出仍標示 `hypothesisOnly: true`。

## 來源與資料邊界

| 輸入 | V1 支援內容 | V1 不做的事 |
| --- | --- | --- |
| Google Trends | synthetic CSV parser、日期、0–100 值、`<1` suppressed value、locale、window、source hash | 不發出 Google request、不 scraping、不保存真實查詢資料、不把相對興趣當搜尋量 |
| Meta Ad Library | synthetic metadata snapshot、publisher identity、ad ID、creative hash、日期、status、locale、window、source hash | 不發出 Meta request、不下載廣告素材、不保存客戶資料、不推導市占或轉換率 |
| Engine output | bounded metrics、accepted/rejected snapshot IDs、policy reason、missing evidence、limitations、fingerprint | 不含 quote、DOI、頁碼、研究結論、全文、PDF 或自動引用 |

所有 fixture 都是 synthetic；測試沒有複製真實論文摘要、客戶內容、真實廣告或生產資料。引擎沒有 database、schema、migration、API route、page、UI、LLM/provider、deploy 或 background job。

## Parser contract

### Google Trends CSV

CSV 必須使用精確 header `date,value`，每一列都必須是 ISO date 與 0 到 100 的有限數字。`<1` 會被明確轉成 `0`，並附加 `SUPPRESSED_VALUE` warning 與 limitation；它不會被偽裝成精確數字。重複日期、錯誤日期、越界數字、window 外 observation、錯誤欄位數、缺 hash 或非 SHA-256 hash 都會 fail closed。

Parser 需要呼叫端提供 `snapshotId`、`keyword`、`locale`、`window`、`capturedAt` 與原始輸入的 SHA-256 `sourceHash`。引擎不會自己抓取或重新取得資料。

### Meta snapshot

Meta snapshot 需要 `snapshotId`、publisher、locale、window、capturedAt、SHA-256 `sourceHash` 與 ad metadata。每筆 ad 需要 `adId`、`startedAt`、`lastSeenAt`、`status` 與 `creativeHash`。重複 ad ID、未知 status、日期錯誤、沒有 publisher、沒有 hash 或不與 window 重疊的 ad 會被拒絕。Publisher identity 會做 Unicode normalization、lowercase、網址前綴移除、公司型態字尾清理與 exact stable identity normalization；不同頁面不能僅靠不同 ad ID 假裝成不同 publisher。

## Deterministic metrics

### Trend metrics

引擎會依 ISO date 排序 observation；同一天來自多個 snapshot 的值會以 arithmetic mean 合併。輸出包含 `pointCount`、first/latest/mean/min/max、change percentage、線性回歸 slope、volatility、peak、coverage 與 direction。當 baseline 為零時，`changePercent` 為 `null`，不會製造無限大或假百分比；少於兩個 distinct observation 時 direction 為 `insufficient_data`。

方向判定是治理用 threshold，不是預測模型。所有數字固定 rounding，所有集合依 stable sort 與 duplicate removal 處理。

### Meta activity metrics

引擎會依 `publisherIdentity:adId` deduplicate ad identity，計算 snapshot count、publisher count、total/unique ad count、latest active ad count、unique creative count、bounded window 內 new ad count、平均廣告年齡與活動方向。只有一個 snapshot 時 activity direction 為 `insufficient_data`；它仍可描述該 bounded snapshot，但不會偽造時間方向。

## Policy 與 fail-closed status

Policy catalog 集中管理 snapshot、observation、ad 與 request 限制，並以 `market-intelligence-signal-policy-v1.0.0` 版本化。Engine 版本為 `market-intelligence-signal-engine-v1.0.0`。

| 狀態 | 意義 |
| --- | --- |
| `ready` | 請求是 market hypothesis，至少有通過 validation 的 bounded snapshot，且 metrics 有足夠資料；仍必須人工解讀限制 |
| `not_ready` | 輸入本身可被辨識，但沒有足夠 observation／snapshot 形成可靠的 bounded comparison；不可偷偷 fallback |
| `rejected` | claim use、格式、provider、日期、locale、hash、status 或其他安全條件不合格；不得進入下游假設 |

每一次 assessment 都回傳 accepted/rejected snapshot IDs、rejection reasons、missing evidence types、limitations、policy version、engine version 與 deterministic fingerprint。`deterministicFingerprint` 對相同 canonical input 穩定；輸入陣列順序不會改變結果 identity。

## Human review checklist

在任何下游文件、brief 或決策中使用 assessment 前，人工 reviewer 必須確認 observation 原始來源、日期與 window、publisher identity、hash provenance、locale、suppressed values、snapshot completeness，以及是否把 hypothesis 過度解讀為 factual claim。Reviewer 也必須確認沒有把 market signal 改寫成 ranking guarantee、AI citation guarantee、traffic guarantee、ROI guarantee 或投資建議。

## 目前沒有自動接入

本輪沒有把 engine 接到既有 repository、Brief、Job 或 GEOFlow service；沒有 API route、資料表、migration、UI、provider credential 或 deployment。未來若要接入，建議流程是：由外部受治理的 approved evidence／snapshot pipeline 產生並驗證 metadata，呼叫本 engine 產生 bounded assessment，再由 GEOFlow Brief 將 assessment 明確標記為 market hypothesis，最後交給 Risk Gate 與 human review。此接入不應繞過本 engine 的 claim-use guard、source hash、locale、window 或 limitation contract。

## 測試覆蓋

`tests/market-intelligence-signal-engine.test.ts` 包含 40 個有意義案例，涵蓋 CSV parser、Meta snapshot validation、publisher normalization、suppressed values、invalid dates、source hash、duplicate records、bounded snapshots、missing evidence、locale/window mismatch、unsupported factual/ranking/investment use、deterministic metrics、stable ordering、fingerprint、no fabricated citation fields 與 no-network purity boundary。Fixtures 位於 `tests/fixtures/market-intelligence/`，僅使用 synthetic metadata。
