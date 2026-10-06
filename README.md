# DiscoveryStack

DiscoveryStack 由兩個獨立應用組成：`public-site` 是公開 Astro 官網，`nuxt-app` 是 Node API、客戶管理入口與擁有人工作台。根目錄指令只協調這兩個應用，不再啟動舊的 React/Express 產物。

## 開發與驗證

先各自在 `public-site` 與 `nuxt-app` 執行 `pnpm install --frozen-lockfile`，使用各應用的 lockfile。根目錄套件不是這兩個應用的依賴替代品。

- `pnpm dev`：啟動 Nuxt；公開站另在 `public-site` 執行 `pnpm dev`。
- `pnpm check`：檢查公開站及 Nuxt。
- `pnpm build`：依序產生公開站 `public-site/dist` 與後台 `nuxt-app/.output`。
- `pnpm build:public`、`pnpm build:private`：只建立指定應用。
- `pnpm test`：公開站 build/tests，加上 Nuxt typecheck/build/safe tests。預設不啟用真實供應商測試。
- `pnpm start`：啟動已建立的 Nuxt Node server；公開站需另由靜態主機服務 `public-site/dist`。
- `pnpm db:generate`：只產生 migration SQL；不會套用資料庫。
- `pnpm db:check-identifiers`：檢查 MySQL/MariaDB migration identifier。

舊的 `db:push` 自動套用指令已移除。Migration 必須先審查，並在指定資料庫依受控程序套用；一般 build、start 與 test 不應修改正式資料庫。

## 設定與啟用

環境變數範本：[公開站](public-site/.env.example)、[後台](nuxt-app/.env.example)。真實金鑰、憑證與資料庫連線只存於部署平台 Secrets，不能提交版本庫。

按照 [設定與實際啟用](nuxt-app/docs/CONFIGURATION_READY_LAUNCH.md) 配置登入、Resend、AI、R2、Stripe、Cloudflare 及網域供應商。擁有人工作台新增「Managed Sites → 上線設定」與「圖片倉庫」，前者是唯讀設定檢查，後者需明確確認才執行真實健康檢查。

本機程式測試通過不等於 production 已完成。寄件網域、付款 webhook、資料庫 migration、網站交付與不休眠背景排程仍需逐項實測。

更多應用邊界：[公開站文件](public-site/README.md)、[後台文件](nuxt-app/README.md)。
