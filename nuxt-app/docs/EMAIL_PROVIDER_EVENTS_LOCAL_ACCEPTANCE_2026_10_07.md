# 郵件供應商回報：本機驗收與正式啟用邊界

2026-10-07（Asia/Taipei）。狀態：**LOCAL_VALIDATED / NOT_DATABASE_APPLIED / NOT_DEPLOYED / PROVIDER_GATED**。本文件是本輪新增功能的證據，不沿用先前 0047 的部署或 owner 200 來聲稱 0048 已完成正式驗收。

## 已補完的工程

- 新增唯一一個 signed server-to-server route：POST `/api/managed-sites/email-outbox/resend-webhook`。開關與設定檢查先於讀 body；原始 bytes 的 Svix HMAC、300 秒時間窗、實際 64 KiB 串流限制及支援事件 schema 均先於取得資料庫。未知追蹤類型忽略，不收集開信／點擊。
- 新增縮減的持久事件表與 SQL 去重／重播／碰撞檢查。只保存 provider email UUID、七種事件、時間與私有指紋，不保存信箱、主旨、本文、退信文字、owner/project tags、原始 body、header、簽章或密鑰。回呼先於同步接受落盤時仍可保存，但不補造已寄送的 outbox。
- 擁有人 GET 仍固定最多 50 筆，先驗 owner，只將 durable acceptedAt ＋ exact receipt ＋原 provider configuration 綁定的事件歸屬；跨 owner／null owner／同 receipt/config 多筆歧義均不借權。預設關閉或未完整設定時不查新增表，避免部署與 schema 次序造成假成功。
- 送達、退信、投訴等事實以 SQL 聚合，亂序不抹除不利紀錄。後台分開「佇列狀態」與「供應商回報」；所有 `inboxDeliveryVerified` 維持 false。Resend 的 delivered 指收件郵件伺服器，不是已入個人信箱或已讀。
- 既有 JSON body reader 行為保留；簽章用的新 raw reader 拒絕只有 parsed object／重建 JSON 的 cache。UTC DATETIME 的計算欄位使用 Drizzle mysql2 的明確 decoder，保留毫秒。
- 範本新增獨立 `NUXT_MANAGED_SITE_EMAIL_EVENTS_ENABLED=false` 與 `NUXT_MANAGED_SITE_EMAIL_EVENTS_WEBHOOK_SECRET=`。事件觀測不會打開寄信、重試、LINE、發布、爬取或訓練。

## 最後固定來源與實際執行

維持 `main`，HEAD `8a77bf595b5afd857fed0b63129b8f0688eea32e`。27 個新增／修改的程式、測試、範本及規格檔逐一固定；source manifest SHA-256：`94d49785149438f4d7cc168b0b3c007d2bd09c44ceb2c1571153ede57cf4f53a`。本文件不含執行程式，刻意排除於來源固定清單，僅在通過後記錄結果。

依序執行型別檢查（22.494 秒）→ fresh node-server build（21.383 秒）→完整安全 Vitest（258.83 秒，包裝程序 259.201 秒），全部 exit 0：**320 個檔案／5,917 項通過，17 個檔案／46 項 opt-in 整合跳過，共 337 檔案／5,963 項，0 失敗**。JSON success、逐檔及逐項計數已獨立核對。完整報告 SHA-256：`ba0eadd8d92c46cd5c2b8df110c082d37ce584b57ab1b3e3bc7d148083e7b703`。

使用安裝在工作區的工具，不安裝或更換依賴、不關閉套件驗證；Nuxt 明確指定不存在的獨立 dotenv 路徑，子程序只繼承環境白名單，不繼承正式 DB 或憑證。供應商、爬取、模型、內容排程等開關保持關閉。必要權限僅給本機 listener，不代表允許正式供應商或資料庫操作。

- 原始 byte reader／route／service／projection／configuration／migration 和原 JSON／owner inspection 的聚焦首輪為 9 檔案／134 項通過。最終完整套件另包含真實 loopback H3 chunked wire、原始 bytes 變動拒絕、413 串流終止，以及精確 webhook path 不在 public CORS allowlist 的檢查；新 HTTP 檔為 14 項，全部通過。
- 最終同來源另在既有本機 MySQL 8.4.11 映像、`--pull=never`、只綁 loopback 的專用合成資料庫實測 **7／7 通過、0 跳過**：schema、並行 PK 去重、簽章輪替不改既存證據、碰撞不可覆寫、callback 先到、owner/config/receipt 歧義與隔離、亂序及毫秒聚合、無效日期零列寫入。報告 SHA-256：`3b0062a88ec60e62a2bfb469a75581881b4c5aad89af1704e7156a869100f19d`。自有一次性容器與合成資料已移除，未連正式 TiDB。這不會把完整套件的 SQL opt-in 跳過改成通過。
- fresh node-server 的 **7 項本機 HTTP 檢查通過**：回呼預設關閉、過大 body 在 disabled 路徑仍不讀取／處理、非 POST 及 preflight 拒絕、未知 action 404、owner 401 及 spoofed query 401。六個真正私人 API 回應嚴格 no-store／noindex；無資料未知 action 的 404 依 Nitro 錯誤處理契約為 no-cache／noindex。全部沒有公共 CORS，也不反映 body canary；自有程序已停止。
- 實際郵件 SFC、實際 owner layout 與 OwnerAsyncState 在 CSP `connect-src none` 的明確合成預覽中驗收。桌面 document／viewport 均 1,280 px；手機均 390 px，表格僅在自己的 348 px 容器內橫向捲動、scrollWidth 790 px。正常七種回報、空佇列、503 錯誤、關閉回報均核對；唯讀更新與錯誤重讀後各為合成讀取 2／寫入 0／寄信 0／發布 0／訓練 0。UI 在前一次完整 source manifest 下驗收，這三個實際 SFC 的 SHA-256 已逐一和最終來源重比，相同；沒有把不同 manifest 的測試報告重新標成最終同版。
- 桌面／手機／錯誤截圖只存受限本機驗收附件，均標明非正式、非客戶資料。預覽程序與自有測試分頁已關閉，viewport 恢復，使用者正式分頁未改動。驗收附件目錄 0700、檔案 0600，未放 Git／未上傳。

## 保留的失敗與修復

- 第一輪型別檢查 exit 2：新 service test 兩處 mock 回傳推導為 `Promise<string>`，及一處 byte index 可能 undefined。僅修正測試的 literal 型別與明確 byte 讀取，不使用 any、不改產品閘門；重新固定來源後 typecheck 通過。
- 前一次完整套件 exit 1：319 檔案／5,916 項通過，1 檔案／1 項失敗，17 檔案／46 項跳過。原錯誤為 `expected { idx: 48, version: '5', …(3) } to be undefined`；0047 的歷史 migration test 假設它永遠是 journal 最末。保留完整舊 snapshot、DDL 及順序斷言，改為核對後面是精確 0048；不是刪測試／跳過／放寬 SQL。修正後再次從 typecheck、fresh build 起完整重驗，得到以上最終結果。
- 本機 HTTP 輔助程序最初用未設定密碼的 `/owner-login` 預期 200 作 ready 檢查，實際 route 合理回 503；改用匿名 owner API 的預期 401。後續輔助程序又要求未知 404 保留 private no-store，已直接核對 Nitro runtime 對所有 404 強制 no-cache 的原契約；僅修正無資料 404 的預期，真正私人 API 的全部斷言保留。原失敗 log 保留，產品來源、權限、CORS 與庫版本不改。

## 尚未正式套用的精確變更

Drizzle 在 DATABASE_URL unset 時生成 migration `0048_managed_email_provider_events_v1.sql`，未連資料庫。SQL SHA-256：`bd687006de112d142e59b6e5a7b88d3a9568ef160a95528ebc0e0212676e3027`。

只有四條新增式 DDL：一張 8 欄事件表、該新表的兩個索引，以及既有 outbox 的一個 receipt/config lookup 索引。不改舊欄位、狀態、lease、重寄鍵或既有資料；migration test 完整比較 0047／0048 snapshots，除這個既有表新增索引外，所有舊表逐項相同。

**本輪沒有 commit、push、正式 DB apply、Render 部署、環境設定修改、webhook 註冊、秘密建立、寄信、LINE、爬取、發布或訓練；新增服務費為 0。** 先前針對精確 0047 的授權不冒充這張新表的正式套用授權。

下一次正式操作需使用者明確核准：費用上限 0，先做新的一致性受限本機備份與隔離完整還原／0048 演練，再只套這四條 DDL 和 canonical ledger；保持既有資料語意，正常非 force 推送這份已固定來源與驗收文件到既有兩個 main，使用既有 Render Free 服務部署，核對正確 Live SHA、兩個必要 CI 與 owner 唯讀頁。不得升級、購買、換 DB 方案、改供應商秘密或啟用寄信／回呼／LINE／發布／爬取／訓練；若產生費用或超出已核准的變更就停止。

## 仍不能宣稱完成的營運／外部驗收

- `manual_required` 仍是安全停止。這輪沒有 operator 結案／恢復流程，不會無視安全時窗、產生新寄送 key 或重寄已接受／不確定的郵件。獨立人工處理工作流、事件 retention／營運政策仍需後續明確設計與審核，不能把觀測表當成這些已完成。
- 真實 Resend account、寄件網域驗證、獨立 endpoint signing secret、正式 webhook 註冊、實際受控寄信及回呼尚未驗收。sender/API/allowlist/private-origin/timeout/encryption/pepper 設定應在觀測期間保持穩定；改設定會安全地留下未歸屬觀測，不猜測舊 receipt 權威。獨立簽章 secret 輪替已本機驗證不改送信 configuration fingerprint。
- 真 LINE 官方帳號／LIFF 客戶綁定、客戶逐稿確認到真 publisher／served HTML、唯讀 GSC／GA4、來源授權與去識別化核准、足量合格觀測及時間外／主體外 holdout 都需要真實驗收。沒有因本輪郵件功能而取得客戶學習 consent，也沒有把 LLM API 回答當成消費者 AI 搜尋的真引用標籤。
- 免費 Render 休眠限制仍存在，不能聲稱 24 小時可靠排程。沒有升級、建立保活服務或隱藏付費方案。
- 一鍵客戶建站、客戶站持久部署與網域合作維持先前延後範圍；公開 Astro、三個範例核心與金流未在本輪修改，不把歷史範例測試當作新的成品驗收。
