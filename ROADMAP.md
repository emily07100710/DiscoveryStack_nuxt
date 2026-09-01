# ROADMAP
> 儀表板:https://claude.ai/code/artifact/e1b04c95-6804-47ca-a423-b88400eb4a14

## 檔案卡(穩定事實,只在事實變動時改)
- 部署:**Render 免費方案**(tendertech2018 帳號)— 公開站 https://discoverystack-web.onrender.com(不會睡)+ 後台 https://discoverystack-api.onrender.com(會睡,喚醒約 50 秒);2026-09-01 上線,老闆親測登入成功
- 上線方式:push 到 **tendertech2018/DiscoveryStack_nuxt** 的 main → Render 自動部署;emily07100710/DiscoveryStack_nuxt(origin)是主開發 repo,推 main 要兩邊都推才同步
- 本站網域:還沒買、名字未定,目前用 onrender.com 附網址(doalignment.com 是白老鼠客戶站,程式在另一個 repo「duduyoga」,不是本站)

| 服務 | 供應商 | 使用帳號 | 實例/專案名 | 後台連結 |
|---|---|---|---|---|
| 主機 | Render(免費方案) | tendertech2018 | discoverystack-web + discoverystack-api | dashboard.render.com |
| 程式碼 | GitHub ×2 | emily07100710(主開發)/ tendertech2018(部署來源) | DiscoveryStack_nuxt | github.com |
| 資料庫 | TiDB Cloud(MySQL 相容) | tendertech2018@gmail.com | discoverystack-production(AWS 東京 · Starter · v8.5.3) | tidbcloud.com |
| 量測 GA4 | Google Analytics | DoAlignment 帳號 406473099 | property 552043438 · 追蹤碼 G-1Y0HJGHKGS | analytics.google.com |
| 量測 GSC | Google Search Console | 使用者帳號(非網域擁有者,權限受授) | sc-domain:doalignment.com | search.google.com/search-console |
| 量測服務帳號 | Google Cloud IAM | discoverystack-measurement@discoverystack-measurement.iam.gserviceaccount.com | 唯讀(GA4 檢視者 + GSC siteFullUser) | — |
| 登入 | 臨時密碼登入(已上線;密碼只放 Render 環境變數,不記錄;正式前換強密碼) | 單一 owner 帳號 | OWNER_SIMPLE_LOGIN_PASSWORD | discoverystack-api.onrender.com/owner-login |
| 金流(國際) | Stripe | 已有帳號(細節待補) | — | dashboard.stripe.com |
| 金流(台灣) | 綠界或藍新(未定,屆時由 PM 評選) | 未申請 | — | — |

- 慣例:main 單線開發;conventional commits(feat/fix/docs/test);測試全 mock 不打真服務;migration 只產生、套用要另外批准
- 驗收基準:GEO_ENGINEERING_SPEC_v2.0,標準是「完整商業產品,不是 MVP」;完成度細節看 PROJECT_MAP.md §8

## 進度
- 目標:等 broker(對話 1)交件驗收;三線並行已落地兩線(爬蟲證據、知識底座)
- 🔵 進行中(對話 1):一鍵建站「真的開出一站」— broker 仲介服務第一段;做完貼完成報告回來驗收
- 🟡 待驗收:GA4 收數 — 09-01 PM 真瀏覽器實測追蹤碼會發送(程式載入+page_view 送出;先前抓原始碼的檢法不適用動態載入);等老闆開 GA4 即時報表看到數字回報,就點亮
- ⚪ 排隊 1:Stripe 真收款接上訂購鏈 — 刻意不跟 broker 同時做(改同一批訂購鏈檔案),broker 落地就開
- ⚪ 排隊 2:整合期 — AI 編輯接真 LLM;約 60 條沒前端的 API 挑關鍵的補畫面
- ⚪ 排隊 3:觀測站可重複 benchmark、介入/實驗閉環;自有模型訓練照交接規則排最後
- 另外掛著:site-evidence(migration 0034)與知識底座 15 張表(0035)都還沒套用到正式資料庫,線上要用前先批准套用;換掉臨時登入密碼(正式前,直接在 Render 改環境變數);Render 免費方案會睡 → 排程睡著時不會跑;正式網域還沒買;5 個孤兒引擎逐一給歸屬;root db:push 死 script;CI 的 NUXT_BUILD_TYPECHECK=false

## 已拍板
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
- 2026-09-01 Entity + Claim + Source 知識底座併入 main(三線並行第二個交件:15 張知識表 + 28 條 owner API + 後台頁,孤兒 JSON-LD 引擎接上、交付預覽會附 JSON-LD;PM 驗收:範圍乾淨、142 測試綠、型別檢查過、0035 只建知識表;對真資料實跑仍未做)
- 2026-09-01 整站爬蟲/頁面證據 slice 併入 main(三線並行第一個交件:URL 清單+原始碼 vs 實際畫面比對+canonical/sitemap 稽核+最小結果頁;PM 驗收:範圍乾淨、21 測試綠、型別檢查過;對真站實跑仍是 opt-in 未跑)
- 2026-09-01 整套系統上線 Render + 密碼登入修好(老闆親測登入成功;PM 實開兩網址驗過;部署細節記入檔案卡)
- 2026-09-01 Google 唯讀憑證接通 + 量測排程啟動(GSC 真的查到 doalignment.com 搜尋數據)
- 2026-09-01 資料庫 schema 與 34 個 migration 在 TiDB 實際套用成功
- 2026-08-31 PROJECT_MAP 依 v2.0 驗收基準全面重寫;v2.0 定為驗收基準
- 2026-08-31 CI 保護上線(GitHub Actions 綠燈:nuxt-app 143 測試檔 + public-site)
- (較早)公開/私有雙站隔離驗證完成(3,799 測試通過,公開站只能打兩支 API)
