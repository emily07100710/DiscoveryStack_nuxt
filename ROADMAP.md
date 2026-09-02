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
| AI 供應商 | 阿里雲百煉 Model Studio(Qwen)國際版 | 老闆帳號(細節待補) | 新加坡(ap-southeast-1)工作區的 OpenAI 相容端點;key 只在 .env 與 Render;換供應商只改環境變數 | 阿里雲國際版 Model Studio 後台(網址待補) |

- 慣例:main 單線開發;conventional commits(feat/fix/docs/test);測試全 mock 不打真服務;migration 只產生、套用要另外批准;外部服務一律自己打 API(fetch 可注入假的),不裝供應商 SDK(Cloudflare、Google、Stripe 都照做);資料表與欄位名一律駝峰(跟既有 173 張表一致);路由型別表已滿,每個新引擎只准 1 個路由檔(萬用路由自己分派),多一個 typecheck 就爆
- 驗收基準:GEO_ENGINEERING_SPEC_v2.0,標準是「完整商業產品,不是 MVP」;完成度細節看 PROJECT_MAP.md §8

## 進度
- 目標:讓老闆以付費客戶身分把一鍵建站完整走一遍(付款 → 開站 → 用一句話改網站);對話 5、6、7 併進 main + Render 設好環境變數就能試;現在開出來的是 *.pages.dev 網址,自動買網域還沒做
- 🔵 進行中(對話 6):Stripe 真收款接上訂購鏈 — 客戶付錢 → 確認收到 → 觸發開站 → 退款/爭議停站 → 對帳;09-02 發包,不裝套件自己打 API;09-02 交件 9e97647 + 8cf5aea(單一路由檔、webhook 內容上限 1MB、手冊補 Origin;PM 試併 main 型別 0 錯、8 測試檔綠、37 檔全在 nuxt-app);跟對話 5 撞號 0037 → 退回 rebase;09-03 PM 看到已 rebase 到新 main 壓成 746ddee(0038_clammy_cerebro),等它的完成報告 + Fresh Review 貼回再驗;真 Stripe 測試模式 NOT RUN
- 🟡 待驗收:GA4 收數 — 09-01 PM 真瀏覽器實測追蹤碼會發送(程式載入+page_view 送出;先前抓原始碼的檢法不適用動態載入);等老闆開 GA4 即時報表看到數字回報,就點亮
- 🟡 待老闆按一下:0037_legal_pete_wisdom 套到正式資料庫 — 介入閉環程式已在 main 推上線,7 張新表還沒開;PM 的自動套用被安全閘擋住,指令已給老闆按 Run;套完回報 PM 核對(預期 38 支、181 張表);也可以等 Stripe 併進 main 後再按一次,0037、0038 一起套(那時預期 39 支)
- ⚪ 排隊 1:客戶完整走一遍 — 09-03 剩 6 還沒併;之後老闆在 Render 設環境變數(換新的 Cloudflare 金鑰、百煉 key + AI 開關 5 個變數、Stripe 測試金鑰,照 nuxt-app/MANAGED_SITE_INTERNAL_BROKER_SETUP_V1.md、LLM_PROVIDER_OPENAI_COMPATIBLE_V1.md 與 Stripe 交件說明)、跑一次 DNS TXT 所有權驗證(目前 NOT RUN),PM 給逐步試跑清單;走完再決定要不要做自動買網域
- ⚪ 排隊 2:整合期 — 觀測站 benchmark 續跑掛上排程(nuxt.config.ts 加一行 + 一支 task);拿 doalignment.com 真資料實跑爬蟲證據+知識底座+觀測站 benchmark(0034–0036 都套好了);約 60 條沒前端的 API 挑關鍵的補畫面;自有模型訓練照交接規則排最後
- 🔴 老闆要做(安全):Backblaze 刪掉 Application Key「discoverystack-vault」並重產 Master Key(B2 已棄用);Cloudflare 的 R2 鑰匙與 Pages token 出現過在對話 1 聊天裡,重產後貼給對話 1 更新 .env;Cloudflare 測試痕跡可刪(Pages 專案 ds-o1-p1 + 一個 preview 部署、R2/B2 桶裡的測試小檔)
- 另外掛著:換掉臨時登入密碼(正式前,直接在 Render 改環境變數);Render 免費方案會睡 → 排程睡著時不會跑;正式網域還沒買;5 個孤兒引擎逐一給歸屬;root db:push 死 script;CI 的 NUXT_BUILD_TYPECHECK=false;POST 請求大小只靠 Content-Length 標頭擋(沒標頭的分段傳輸擋不到,建站編輯器與介入引擎都一樣,全專案統一處理);路由額度只剩約 1 個引擎的份(PM 實測:5、6 都併後再加 1 個萬用路由還過;對話 7 沒加路由檔、額度沒動;升級 Nuxt/Nitro 或改設定要老闆拍板);AI 供應商層兩個已知折衷(對話 7):工作紀錄的供應商欄位沒有 openai_compatible 這個值、先存舊名 autogeo_bailian_qwen 當別名(要補值得另開 migration);GEO 工作台手動優化(server/geo/optimise.ts)與建站產生器(live-connectors)仍走舊的百煉專用通道,整合期一起換

## 已拍板
- 2026-09-03 對話 7 不動資料庫:工作紀錄的供應商欄位沒有 openai_compatible 這個值,先存舊名當別名(執行完全一樣),要補值另開 migration、排整合期;AI 失敗(逾時、亂回、不合法操作、環境變數沒設齊)一律回「AI 暫時無法處理這個要求,請換個說法再試一次。」、不存檔、不套用、退還當日額度、不自動重試
- 2026-09-02 撞號 0037 先後:先併對話 5(Fresh Review 已過、改了四輪不再拖),Stripe rebase 到新 main 重產 0038 並補 Fresh Review 後再併;路由額度 PM 實測:兩邊都併後再加 1 個萬用路由還過,對話 7 之後就滿
- 2026-09-02 AI 供應商做成可換:程式只認「OpenAI 相容端點」,端點、key、模型名全用環境變數;白名單先放百煉(國際版、中國版)+ api.openai.com;之後換 OpenAI 或別家只改環境變數,不改程式(對話 7 補充要求)
- 2026-09-02 下一階段目標改成「老闆以付費客戶身分完整走一遍一鍵建站」;真實 AI 用百煉(Qwen)接,提前另開對話 7 跟 5、6 並行(檔案不撞);API key 只放本機 .env 和 Render 環境變數,絕不貼進任何對話
- 2026-09-02 Google 重抓確認的查詢額度只算「真的問到 Google 並拿到答案」的次數;失敗不算額度,但同一頁同一天失敗 3 次就停到隔天並記原因,避免無限重試(對話 5 交件小缺口,PM 拍板一起修、不另開單)
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
- 2026-09-03 真實 AI 供應商層併入 main(對話 7 交件 a17e40c + 4d9c7fa:程式只認 OpenAI 相容端點,端點/key/模型全用環境變數,白名單=百煉國際版工作區主機、中國版、api.openai.com;GEO 草稿與建站「一句話改網站」都能切到真 AI;第一次 Fresh Review C(規劃器輸出可偽造「AI 不可用」標記跳過額度與存檔)→ 4d9c7fa 修好、第二次 A;PM 驗收:25 檔、沒新路由檔、沒 migration、沒新套件、合併後型別 0 錯、8 相關測試檔綠、識別字政策通過;合併 commit 6da38d1 推兩邊;真百煉呼叫 NOT RUN,等 Render 設 key)
- 2026-09-02 介入與實驗閉環併入 main(對話 5 交件 3b7d298:改動登記簿+事件流水、部署/重抓確認(沒問到 Google 前不給結論、回 409)、實驗結果一定附樣本數與因果免責、refresh 佇列可調門檻、已取消的不進佇列、超過 200 筆分頁走完;改四輪後 Fresh Review 過;PM 驗收:43 檔全在 nuxt-app、合併後型別 0 錯、17 測試檔綠、識別字政策通過;合併 commit eb97bc2 推兩邊;0037_legal_pete_wisdom(7 張表)待老闆套;真 Google 呼叫 NOT RUN)
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
