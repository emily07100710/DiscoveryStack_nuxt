# 公開 SEO／GEO 訓練資料治理與多維標註契約

本文件定義 DiscoveryStack 第一個公開資料訓練集的**不可降低門檻**。目標不是建立無邊界的通用語言模型，而是建立可評估的 **SEO／GEO 網站內容與使用者旅程洞察模型**。每一筆樣本均必須保留來源、權利依據、擷取與標註版本、人工審核決策、去重與個人資料處理結果；公開可存取本身不構成訓練許可。

## 一、資料來源准入規則

每個候選來源先建立 Source Card，再進行任何抓取或資料集納管。Source Card 的 `policyEvidence` 必須保存授權或使用條款 URL、robots 檢查結果、檢查時間、適用範圍、來源頁面與人工判斷理由。資料處理只保存為訓練所需的衍生特徵、可檢核的有限引文與雜湊；不得把原始 HTML、帳號資料、表單輸入或未經核可的長篇內容加入資料庫。

| 權利與條款狀態 | 資料集處置 | 額外條件 |
|---|---|---|
| CC0、明確公有領域，或資料提供者明確授權機器學習訓練 | 可成為候選訓練來源 | 仍須通過來源頁面範圍、robots、PII、去重與人工審核 |
| CC BY | 僅在保存作者、作品名稱、URL、授權與修改說明後，才可送人工政策審核 | 資料集 manifest 必須產出可用的 attribution 表 |
| CC BY-SA、ODbL 或其他 share-alike 條件 | 預設為 `needs_policy_review` | 在確認模型輸出與資料集發布方式符合相同方式授權義務前，不進入訓練集 |
| CC BY-NC、CC BY-NC-SA、CC BY-NC-ND | 不進入商業或可能商業化的訓練資料集 | 不以「研究」名稱規避非商業限制 |
| CC BY-ND、權利不明、條款禁止自動化／訓練、robots 限制目標路徑、付費或登入內容 | `blocked` | 不抓取、不儲存為 artifact、不提交訓練 |

Creative Commons 說明 CC BY 允許在歸屬前提下改作與商業使用；CC BY-SA 另要求以相同或相容條件分享改作；ND 禁止改作；NC 限制非商業使用。[1] MDN 的文件授權頁也示範了 CC BY-SA 內容須保留標題、URL、作者／貢獻者與修改說明，並明確將商標與視覺識別排除在內容授權之外。[2] 因此本專案不把「網站可讀」或「資料集平台標示 CC0」視為對上游網站內容的充分授權，而是逐來源驗證其實際內容權利。

> 這是可稽核的資料治理規則，不是法律意見。對於 share-alike、資料庫權或特定司法管轄的疑義，來源維持 `needs_policy_review`，直到 owner 或法律顧問核可。

## 二、100 筆真實樣本的資料品質門檻

首個可提交的 development dataset 至少需要 100 筆**內容雜湊去重後**的樣本；每筆須滿足以下條件：來源為已核准的 `training_candidate`、artifact 具 `passed` 品質狀態、PII 為 `none_detected` 或有可稽核的遮罩紀錄、人工標註已覆核、至少一項可檢核來源證據存在，且無撤回／移除標記。100 筆並非以同一頁切片、模板頁、404、標籤頁或近似重複內容湊成；這些將按 canonical URL、內容雜湊與相似度閾值排除。

資料集 manifest 會固定記錄資料集版本、每筆 artifact 與 source ID、資料分割、審核者、權利快照、標註 taxonomy 版本、特徵契約版本、去重決策與移除條件。只有完成 manifest 核准後，系統才會解鎖遠端 Hugging Face development job 的提交。

## 三、SEO／GEO 多維標註 taxonomy v2（草案）

每筆資料可擁有多個標籤；不適用值以 `unknown` 或空集合明示，不能以二元 yes／no 偽造確定性。自動抽取只形成候選；人工確認、修正或否決才形成訓練真值。每個標籤均保存 `value`、`evidenceArtifactId`、`evidenceLocator`、`confidence`（1–5）、`labelMethod`（rule／human／human_amended）、`reviewState` 與 `taxonomyVersion`。

| 標註維度 | 值域／格式 | 模型用途 |
|---|---|---|
| 搜尋與使用者意圖 | informational、commercial_investigation、transactional、navigational、local_action、support；可多選 | 判斷頁面是否符合搜尋任務與下一步 |
| 使用者旅程 | discovery、understanding、response、progression、conversion；可有主階段與輔階段 | 辨識內容在決策路徑中的功能與缺口 |
| 頁面與內容類型 | home、service、solution、product、pricing、faq、guide、case_study、contact、booking、comparison、location、other；可多選 | 連結資訊架構、內容格式與旅程作用 |
| 主題與實體 | 分層主題、服務／產品、產業、受眾、地點、組織、概念與關係 | 支援語意匹配、主題覆蓋與 GEO 實體明確性 |
| GEO 可引用性 | answer_directness、evidence_clarity、entity_disambiguation、structured_data_presence、source_attribution、freshness；各 0–4 | 識別生成式搜尋容易引用、摘要與驗證的內容訊號 |
| 技術 SEO | title／H1／canonical／indexability／schema types／internal-link band／language／hreflang；結構化值 | 建立可解釋的技術品質特徵 |
| 信任與品質 | author_or_owner_transparency、contactability、first_party_evidence、claims_support、content_maintenance、accessibility_basics；各 0–4 | 找出可信度、可驗證性與品質缺口 |
| 行動摩擦與修復優先度 | cta_clarity、path_continuity、service_routing、price_or_expectation_setting、form_friction、mobile_accessibility；各 0–4，加上 `remediationPriority` 1–5 | 產生可行動的使用者旅程診斷，不把推測轉成事實 |
| 治理元資料 | source／licence／terms／robots／PII／dedupe／review／retention／dataset split | 限制資料使用、支援撤回並重建 manifest |

## 四、初始候選來源的處理方式

| 候選來源 | 可提供的價值 | 初步處置 |
|---|---|---|
| Kaggle「SEO Crawl Datasets」 | 結構欄位與技術 SEO 特徵的基準參考 | 僅作**候選資料卡與 schema 參考**。雖然資料頁標示 CC0，仍需針對其中每個被爬網站確認上游內容權利，未完成前不可作為訓練樣本。[3] |
| 明確 CC0／公有領域的官方技術文件或資料集 | 可生成技術 SEO 結構、內容類型與可引用性樣本 | 逐一登錄來源、核對實際授權頁、robots 與資料範圍後，可進入抓取及人工標註程序 |
| MDN 文件 | 對技術內容、結構性頁面和 attribution 機制具有參考價值 | 預設 `needs_policy_review`，不是自動納入：文件為 CC BY-SA，且商標與視覺識別不在授權範圍內。[2] |
| Google Search Central 文件 | 直接涵蓋 sitemap、robots、結構化資料、內容呈現與技術 SEO，適合作為第一批明確可再利用的技術 SEO／GEO 樣本 | 只納入逐頁顯示 CC BY 4.0 通知的文字內容；排除商標、品牌素材、圖片／影音及另行標示的內容。`developers.google.com/robots.txt` 對一般 user-agent 僅排除 `/youtube/partner/`，並公布 sitemap；仍實施節流、單頁擷取與每次 URL 政策檢查。[4][5] |

2026-08-17 已在正式 Search Central 文件索引實測確認：該索引將候選內容劃分為「搜尋基礎入門、SEO 基礎知識、檢索及建立索引、排名與搜尋外觀、監控和偵錯、網站專屬指南」，並在頁尾標示「除非另有註明，否則內容採 CC BY 4.0、程式碼範例採 Apache 2.0」。首批資料僅從這些 SEO 文件分類中逐頁挑選；每頁仍要再次檢驗該頁的授權頁尾、canonical URL、是否含另行授權媒材和原始內容雜湊，才可建立訓練 artifact。[6]

## 五、完成定義

此任務只有在 owner-only ML Workbench 顯示一筆**非 BLOCKED**、至少 100 筆的已核准 dataset manifest、完整標籤分布與一個真實遠端 Hugging Face job ID 時才算完成。若遠端工作失敗，系統必須保留失敗證據並明確顯示「未完成」，而不是把送出請求或建立空白 run 視為訓練成功。

## 參考資料

[1] [Creative Commons, *The CC Licenses*](https://creativecommons.org/cc-licenses/)

[2] [MDN Web Docs, *Attribution and copyright licensing*](https://developer.mozilla.org/en-US/docs/MDN/Writing_guidelines/Attrib_copyright_license)

[3] [Kaggle, *SEO Crawl Datasets*](https://www.kaggle.com/datasets/eliasdabbas/seocrawldatasets)

[4] [Google Developers, *Site Policies*](https://developers.google.com/site-policies)

[5] [Google Search Central, *Introduction to robots.txt*](https://developers.google.com/search/docs/crawling-indexing/robots/intro)

[6] [Google Search Central, *SEO documentation index*](https://developers.google.com/search/docs)
