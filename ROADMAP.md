# ROADMAP
> 儀表板:https://claude.ai/code/artifact/e1b04c95-6804-47ca-a423-b88400eb4a14

## 檔案卡(穩定事實,只在事實變動時改)
- 部署:**Render 免費方案**(tendertech2018 帳號)— 公開站 https://discoverystack-web.onrender.com(不會睡)+ 後台 https://discoverystack-api.onrender.com(會睡,喚醒約 50 秒);2026-09-01 上線,老闆親測登入成功
- 上線方式:push 到 **tendertech2018/DiscoveryStack_nuxt** 的 main → Render 自動部署;emily07100710/DiscoveryStack_nuxt(origin)是主開發 repo,推 main 要兩邊都推才同步
- 本站網域:還沒買、名字未定,目前用 onrender.com 附網址(doalignment.com 是白老鼠客戶站,程式在另一個 repo「duduyoga」,不是本站)

| 服務 | 供應商 | 使用帳號 | 實例/專案名 | 後台連結 |
|---|---|---|---|---|
| 主機 | Render(免費方案) | tendertech2018 | discoverystack-web + discoverystack-api | dashboard.render.com |
| 建站主機(客戶站) | Cloudflare Pages + R2(倉庫) | 待補:問老闆是哪個 Cloudflare 帳號 | 專案前綴 ds;09-02 測試專案 ds-o1-p1(可刪) | dash.cloudflare.com |
| 程式碼 | GitHub ×2 | emily07100710(主開發)/ tendertech2018(部署來源) | DiscoveryStack_nuxt | github.com |
| 資料庫 | TiDB Cloud(MySQL 相容) | tendertech2018@gmail.com | discoverystack-production(AWS 東京 · Starter · v8.5.3) | tidbcloud.com |
| 量測 GA4 | Google Analytics | DoAlignment 帳號 406473099 | property 552043438 · 追蹤碼 G-1Y0HJGHKGS | analytics.google.com |
| 量測 GSC | Google Search Console | 使用者帳號(非網域擁有者,權限受授) | sc-domain:doalignment.com | search.google.com/search-console |
| 量測服務帳號 | Google Cloud IAM | discoverystack-measurement@discoverystack-measurement.iam.gserviceaccount.com | 唯讀(GA4 檢視者 + GSC siteFullUser) | — |
| 登入 | 臨時密碼登入(已上線;密碼只放 Render 環境變數,不記錄;正式前換強密碼) | 單一 owner 帳號 | OWNER_SIMPLE_LOGIN_PASSWORD | discoverystack-api.onrender.com/owner-login |
| 金流(國際) | Stripe | 已有帳號(細節待補) | — | dashboard.stripe.com |
| 金流(台灣) | 綠界或藍新(未定,屆時由 PM 評選) | 未申請 | — | — |

- 慣例:main 單線開發;conventional commits(feat/fix/docs/test);測試全 mock 不打真服務;migration 只產生、套用要另外批准;外部服務一律自己打 API(fetch 可注入假的),不裝供應商 SDK(Cloudflare、Google、Stripe 都照做)
- 驗收基準:GEO_ENGINEERING_SPEC_v2.0,標準是「完整商業產品,不是 MVP」;完成度細節看 PROJECT_MAP.md §8

## 進度
- 目標:觀測站統計與 0036 修正 09-02 併入 main,正式資料庫套到 37 支、線上觀測站頁面應該恢復(沒開頁驗);介入閉環(對話 5)與 Stripe 收款(對話 6)在跑;下一個開整合期(benchmark 續跑掛排程)
- 🔵 進行中(對話 6):Stripe 真收款接上訂購鏈 — 客戶付錢 → 確認收到 → 觸發開站;09-02 發包,不裝套件自己打 API
- 🔵 進行中(對話 5):介入與實驗閉環 — 改動登記簿、部署/重抓確認、實驗結果、refresh 佇列,綁到既有 baseline 前後量測;Phase 4 出口;09-01 發包
- 🟡 待驗收:GA4 收數 — 09-01 PM 真瀏覽器實測追蹤碼會發送(程式載入+page_view 送出;先前抓原始碼的檢法不適用動態載入);等老闆開 GA4 即時報表看到數字回報,就點亮
- ⚪ 排隊 1:整合期 — 觀測站 benchmark 續跑掛上排程(對話 4 已交件,可開:nuxt.config.ts 加一行排程 + 一支 task);AI 編輯接真 LLM(broker 落地了、檔案跟 Stripe 不同,可以另開);約 60 條沒前端的 API 挑關鍵的補畫面
- ⚪ 排隊 2:煙測 — 拿 doalignment.com 真資料跑一次爬蟲證據+知識底座+觀測站 benchmark(0034–0036 都套好了,可以開);正式環境開真開站要先設 broker 環境變數(照 nuxt-app/MANAGED_SITE_INTERNAL_BROKER_SETUP_V1.md)並跑一次 DNS TXT 所有權驗證(目前 NOT RUN);自有模型訓練照交接規則排最後
- 🔴 老闆要做(安全):Backblaze 刪掉 Application Key「discoverystack-vault」並重產 Master Key(B2 已棄用);Cloudflare 的 R2 鑰匙與 Pages token 出現過在對話 1 聊天裡,重產後貼給對話 1 更新 .env;Cloudflare 測試痕跡可刪(Pages 專案 ds-o1-p1 + 一個 preview 部署、R2/B2 桶裡的測試小檔)
- 另外掛著:換掉臨時登入密碼(正式前,直接在 Render 改環境變數);Render 免費方案會睡 → 排程睡著時不會跑;正式網域還沒買;5 個孤兒引擎逐一給歸屬;root db:push 死 script;CI 的 NUXT_BUILD_TYPECHECK=false

## 已拍板
- 2026-09-02 benchmark 建立當下把品牌名、別名、網域跟對手名冊一起凍進快照,之後續跑、重算、比較一律用凍結值;改專案網域只影響新建的 benchmark(對話 4 Fresh Review 第三條,PM 拍板一起修、不另開單)
- 2026-09-02 Stripe 不裝官方套件、自己打它的 API(跟全案其他外部服務一致,測試好換假的);條件:webhook 簽章自己驗(拿原始內容算 HMAC、時間差 5 分鐘內、比對用等時法)、每次呼叫固定 Stripe-Version、建付款頁帶 Idempotency-Key
- 2026-09-02 建站倉庫改用 Cloudflare R2(Backblaze B2 不接受程式送的防覆蓋標頭、回 501,放棄);客戶站部署用 Cloudflare Pages 直接上傳;仲介服務做在程式裡(in-process),不另開一台服務
- 2026-09-02 介入閉環設計拍板(對話 5 討論關卡,走商業版):前後成績除了排程文章自動拿,手改頁面也按網址向 GSC 自動拉(每筆每天最多一次,憑證沒設就 unknown),手動貼數字只當備援並標明來源;上線確認=整站掃描指紋比對+單頁「現在就檢查」(找到預期文字=強證據、只有指紋變=弱證據);Google 重抓確認=老闆按檢查+排程自動問(每筆每天一次、最多 30 天);回頭處理清單用全域可調門檻(掉 20%/至少 30 筆/90 天)且每項寫原因;自動收成績接上自動掛結果,排程發布文章自動登記改動(只准掛在 content-operations/service.ts 或 publication-routing,被擋就先做手動、留 broker 落地後補)
- 2026-09-02 觀測站 benchmark 設計拍板(對話 4 討論關卡,走商業版):樣本逐筆存+母表存聚合快照(快照要能從樣本重算);改非同步、可從斷點續跑(主機會睡)、不用 Nitro 排程以免撞 broker 的 nuxt.config.ts、單次上限 250 probes 可用環境變數調;部分失敗照成功數算 n、只准手動補跑;舊 prompt/對手首次使用自動補建版本與名冊,另給一支冪等 sync API;引用日期優先序 provider 日期 > URL 日期 > Last-Modified,HEAD 抓取 opt-in 預設關、擋內網、疑似假日期存 unknown
- 2026-09-01 第二波並行:排隊 2(AI 編輯、補畫面)大多在 managed-sites 引擎內、跟 broker 撞檔,先跳過;改開觀測站統計(對話 4)與介入閉環(對話 5),檔案跟 broker 與彼此互不相撞;兩邊都會加表,後落地者照撞號規則 rebase 重產生
- 2026-09-01 平行分支 migration 撞號一律「rebase 到 main 後用 pnpm db:generate 重新產生」,不手改 SQL/snapshot/journal(知識底座 0034→0035 第一次照做)
- 2026-09-01 三線並行開工:broker(對話 1)+ 爬蟲證據(對話 2)+ 知識底座(對話 3),檔案互不相撞;Stripe 與 broker 撞檔,排 broker 之後
- 2026-09-01 優先序改判:「一鍵生成真網站」提到最前面;GEO 六步路線內容不變、整體往後挪
- 2026-09-01 後台=自家公司內部用,**不賣系統給別的公司**;近期一人操作,員工帳號保留擴充空間但不急做 →「多租戶大改造」議題結案
- 2026-09-01 兩塊生意(服務既有網站/建站代管)**並重**;「客戶付款→自動買網域開站收錢」確定要做、排進近期
- 2026-09-01 doalignment.com=第一個白老鼠客戶,整條服務線(診斷→內容→發布→量測)拿它練真的
- 2026-09-01 金流:Stripe 已有帳號;台灣金流在綠界/藍新之間由 PM 屆時評選推薦
- 2026-09-01 一個月目標=三線都推一點(GEO 線、上線、建站收款),並行順序由 PM 排
- 2026-09-01 交接文件(08-29 盤點 v2.0 差距)的六步順序定為正式路線:頁面證據→知識庫→真實 provider→煙測→觀測與實驗→最後模型
- 2026-09-01 交接硬規則生效:mock/contract 不得當真實功能宣稱;外部寫入與真憑證一律明確 opt-in;證據不足寧存 unknown 不猜;動公開官網視覺前先留 screenshot/build 對照
- (日期不詳,記錄於 PROJECT_MAP)完成標準=完整商業產品,不是 MVP;v2.0 規格全區塊都算範圍
- (日期不詳)geoflow/autogeo 兩個第三方只匯入原始碼,不接 runtime、不安裝、不部署
- (日期不詳)不從零訓練通用大語言模型;自有模型只學「哪裡有問題、先改什麼、什麼有效」

## 已完成
- 2026-09-02 0036 修好併入 main、正式資料庫套到 37 支(對話 4 修:兩個 json 欄位改 $defaultFn、還原到 0035 重產 0036_silent_stranger、加一條「migration 裡 json 欄位不准字面預設值」的測試;PM 驗收:6 個檔案全在觀測站地盤、migration 與 benchmark 測試綠、識別字政策通過;PM 用 drizzle-kit 重套,36→37 支、170→174 張表,4 張 benchmark 表與 5 個新欄位都在;線上觀測站頁面應該恢復,沒開頁驗)
- 2026-09-02 正式資料庫套用 0034(爬蟲證據)與 0035(知識底座):老闆批准、PM 用 drizzle-kit 依序套,34→36 支、150→170 張表,套前套後都查過;0036 第一版被 TiDB 擋下,修好後另行套上(見上一行)
- 2026-09-02 觀測站可重複 benchmark 併入 main(對話 4 交件:同一問題重複跑 N 次、樣本數+信賴區間、prompt 版本化、對手名冊、引用新鮮度、品牌名+網域凍進快照;Fresh Review B 三條備註修畢;PM 驗收:範圍乾淨(45 檔全在觀測站地盤)、合併後型別檢查 0 錯、正式 build 成功、163 測試檔全綠;main 由對話 4 快轉到合併 commit 2188dd5 並推兩邊,PM 核實本機與兩個 GitHub 一致;真 AI 平台呼叫、引用網址真抓取 NOT RUN;0036 修好後套上)
- 2026-09-02 一鍵建站第一次真的開出一站(broker 併入 main:程式內建仲介服務接 Cloudflare Pages + R2,真部署測試通過、公網讀回頁面;根因是打 Cloudflare 的三個呼叫跟真 API 不合,mock 測試看不出來;PM 驗收:範圍乾淨、合併後型別檢查 0 錯、正式 build 成功、159 測試檔全綠;DNS TXT 所有權驗證 NOT RUN;正式環境未設環境變數,開站功能線上未啟用)
- 2026-09-01 Entity + Claim + Source 知識底座併入 main(三線並行第二個交件:15 張知識表 + 28 條 owner API + 後台頁,孤兒 JSON-LD 引擎接上、交付預覽會附 JSON-LD;PM 驗收:範圍乾淨、142 測試綠、型別檢查過、0035 只建知識表;對真資料實跑仍未做)
- 2026-09-01 整站爬蟲/頁面證據 slice 併入 main(三線並行第一個交件:URL 清單+原始碼 vs 實際畫面比對+canonical/sitemap 稽核+最小結果頁;PM 驗收:範圍乾淨、21 測試綠、型別檢查過;對真站實跑仍是 opt-in 未跑)
- 2026-09-01 整套系統上線 Render + 密碼登入修好(老闆親測登入成功;PM 實開兩網址驗過;部署細節記入檔案卡)
- 2026-09-01 Google 唯讀憑證接通 + 量測排程啟動(GSC 真的查到 doalignment.com 搜尋數據)
- 2026-09-01 資料庫 schema 與 34 個 migration 在 TiDB 實際套用成功
- 2026-08-31 PROJECT_MAP 依 v2.0 驗收基準全面重寫;v2.0 定為驗收基準
- 2026-08-31 CI 保護上線(GitHub Actions 綠燈:nuxt-app 143 測試檔 + public-site)
- (較早)公開/私有雙站隔離驗證完成(3,799 測試通過,公開站只能打兩支 API)
