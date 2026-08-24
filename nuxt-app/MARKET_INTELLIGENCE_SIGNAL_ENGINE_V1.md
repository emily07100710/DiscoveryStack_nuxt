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
| Google Trends | synthetic CSV parser、日期、0–100 值、`<1` suppressed value、locale、window、必要且 normalized 的 `scaleKey`、source hash | 不發出 Google request、不 scraping、不保存真實查詢資料、不把相對興趣當搜尋量 |
| Meta Ad Library | synthetic metadata snapshot、publisher identity、ad ID、creative hash、日期、status、locale、window、source hash | 不發出 Meta request、不下載廣告素材、不保存客戶資料、不推導市占或轉換率 |
| Engine output | bounded metrics、accepted/rejected snapshot IDs、policy reason、missing evidence、limitations、fingerprint | 不含 quote、DOI、頁碼、研究結論、全文、PDF 或自動引用 |

所有 fixture 都是 synthetic；測試沒有複製真實論文摘要、客戶內容、真實廣告或生產資料。引擎沒有 database、schema、migration、API route、page、UI、LLM/provider、deploy 或 background job。

## Parser contract

### Google Trends CSV

CSV 必須使用精確 header `date,value`，每一列都必須是 ISO date 與 0 到 100 的有限數字。`<1` 會被明確轉成 `0`，並附加 `SUPPRESSED_VALUE` warning 與 limitation；它不會被偽裝成精確數字。重複日期、錯誤日期、越界數字、window 外 observation、錯誤欄位數、缺 hash 或非 SHA-256 hash 都會 fail closed。

Parser 需要呼叫端提供 `snapshotId`、`keyword`、`locale`、`window`、`capturedAt` 與原始輸入的 SHA-256 `sourceHash`。引擎會以 UTF-8 bytes 對實際 CSV 字串計算 SHA-256，並與傳入 hash 做大小寫正規化後的精確比對；只有 hash 外觀正確但內容不一致時也會 fail closed。`scaleKey` 是獨立且必要的 provenance 欄位，不會被加入 CSV hash；它會做 NFKC、trim、lowercase 與 whitespace normalization，缺少、錯誤型別或 normalized 後為空都會 fail closed，不會 fallback 成 `default`。引擎不會自己抓取或重新取得資料。`capturedAt` 必須含 `Z` 或明確 `±HH:MM` timezone，保存前統一為 canonical UTC ISO timestamp。

### Meta snapshot

Meta snapshot 需要 `snapshotId`、publisher、locale、window、capturedAt、SHA-256 `sourceHash` 與 ad metadata。每筆 ad 需要 `adId`、`startedAt`、`lastSeenAt`、`status` 與有效 SHA-256 `creativeHash`。Meta 的 source hash 不是假格式檢查：`metaSnapshotSourceHash` 會對 provider、snapshotId、publisher、locale、window、canonical UTC capturedAt 與排序後的 ads 組成 canonical bounded metadata payload，排除 `sourceHash` 與衍生 `limitations` 後計算 SHA-256，再與輸入精確比對。重複 normalized ad ID、未知 status、日期錯誤、沒有 publisher、沒有 hash 或 ad 不與 snapshot／request window 相交的輸入會被拒絕。Publisher identity 會做 Unicode normalization、lowercase、網址前綴移除，且只從尾端清理公司型態；`Limited Run Games` 不會因中間的 `Limited` 被刪除。不同頁面不能僅靠不同 ad ID 假裝成不同 publisher。

## Deterministic metrics

### Trend metrics

引擎會依 ISO date 排序 observation；每個 Google Trends snapshot 都必須有非空 normalized `scaleKey`，同一天只有在 keyword 與 `scaleKey` 完全一致時才可進入同一 assessment，否則以 `KEYWORD_MISMATCH` 或 `SCALE_MISMATCH` 拒絕衝突 snapshot，絕不平均不同 query 或 normalization scale 的數字。輸出包含 `pointCount`、first/latest/mean/min/max、change percentage、線性回歸 slope、volatility、peak、coverage 與 direction。當 baseline 為零時，`changePercent` 為 `null`，不會製造無限大或假百分比；少於兩個 distinct observation 時 direction 為 `insufficient_data`。request window 與每一個 snapshot window 必須精確相同，且每一個 observation date 必須同時落在兩者內。

方向判定是治理用 threshold，不是預測模型：少於兩點是 `insufficient_data`；未達 change 與 slope threshold 是 `stable`；`latest > first` 是 `rising`；`latest < first` 是 `falling`；端點相等永遠是 `stable`，即使中間波動很大。所有數字固定 rounding，所有集合依 stable sort 與 duplicate removal 處理。

### Meta activity metrics

引擎會依 `publisherIdentity:adId` deduplicate ad identity，計算 snapshot count、publisher count、total/unique ad count、各 publisher 最新 snapshot 的 active ad 總和、unique creative count、bounded window 內 new ad count、平均廣告年齡、全域活動方向與 `publisherDirections`。每個 publisher 都以自己的 first/latest snapshot 比較；若任何 publisher 沒有至少兩個可比較 snapshot，全域方向為 `insufficient_data`，不會用其他 publisher 的時間序列替代。

## Policy 與 fail-closed status

Policy catalog 集中管理 snapshot、observation、ad 與 request 限制，並以 `market-intelligence-signal-policy-v1.0.0` 版本化。Engine 版本為 `market-intelligence-signal-engine-v1.0.0`。

| 狀態 | 意義 |
| --- | --- |
| `ready` | 請求是 market hypothesis，至少有通過 validation 的 bounded snapshot，且 metrics 有足夠資料；仍必須人工解讀限制 |
| `not_ready` | 輸入本身可被辨識，但沒有足夠 observation／snapshot 形成可靠的 bounded comparison；不可偷偷 fallback |
| `rejected` | claim use、格式、provider、日期、locale、hash、status 或其他安全條件不合格；不得進入下游假設 |

每一次 assessment 都回傳 accepted/rejected snapshot IDs、rejection reasons、missing evidence types、limitations、policy version、engine version 與 deterministic fingerprint。所有 datetime 先 canonicalize 到 UTC，`deterministicFingerprint` 對相同 canonical input 穩定；等價 timezone offset 與輸入陣列順序都不會改變結果 identity。公開 parser 與 assessment entrypoint 對 null、undefined、錯誤型別、malformed array 與缺少 nested object 一律回傳結構化 fail-closed 結果，不回傳 raw input、stack 或 secret。

## Human review checklist

在任何下游文件、brief 或決策中使用 assessment 前，人工 reviewer 必須確認 observation 原始來源、日期與 window、publisher identity、hash provenance、locale、suppressed values、snapshot completeness，以及是否把 hypothesis 過度解讀為 factual claim。Reviewer 也必須確認沒有把 market signal 改寫成 ranking guarantee、AI citation guarantee、traffic guarantee、ROI guarantee 或投資建議。

## 目前沒有自動接入

本輪沒有把 engine 接到既有 repository、Brief、Job 或 GEOFlow service；沒有 API route、資料表、migration、UI、provider credential 或 deployment。未來若要接入，建議流程是：由外部受治理的 approved evidence／snapshot pipeline 產生並驗證 metadata，呼叫本 engine 產生 bounded assessment，再由 GEOFlow Brief 將 assessment 明確標記為 market hypothesis，最後交給 Risk Gate 與 human review。此接入不應繞過本 engine 的 claim-use guard、source hash、locale、window 或 limitation contract。

## 測試覆蓋

`tests/market-intelligence-signal-engine.test.ts` 包含 66 個有意義案例，涵蓋 CSV content-bound hash、Meta canonical payload hash、creative hash、publisher normalization、suppressed values、invalid dates、duplicate records、keyword／scale／window alignment、required scaleKey provenance、parser-to-assessment mismatch、timezone canonicalization、multi-publisher metrics、bounded snapshots、missing evidence、unsupported factual/ranking/investment use、malformed runtime input、deterministic metrics、stable ordering、fingerprint、no fabricated citation fields 與 no-network purity boundary。Fixtures 位於 `tests/fixtures/market-intelligence/`，僅使用 synthetic metadata。
