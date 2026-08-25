# GEOFlow Monorepo Import V1

## 這次導入代表什麼

DiscoveryStack 保持單一 GitHub Repository，但同一個 monorepo 裡的程式碼不等於同一個 process，也不等於同一次 deployment。這次只是把已鎖定版本的 GEOFlow 原始碼安全放進 Repository，尚未把它接到任何既有產品 runtime。

目前三個邊界如下：

- `public-site`：Astro 公開網站，繼續負責公開內容與網站體驗。
- `nuxt-app`：DiscoveryStack 私人 control plane，繼續負責內部管理流程。
- `services/geoflow`：Laravel/PHP 內容引擎的獨立原始碼邊界，未來可負責提示詞、知識庫、RAG、模型任務、草稿與審核，以及多站分發。

GEOFlow 有自己的 PHP/Composer 與 Node/Vite 相依、環境設定、資料庫 migration、queue、scheduler 和部署方式。它不會因為被放進同一個 Repository，就自動與 Astro 或 Nuxt 共用 process、資料庫、身份、job 或發布流程。

## 本輪刻意沒有做的事

- 沒有修改或取代 `public-site`、`nuxt-app`。
- 沒有建立 DiscoveryStack 與 GEOFlow 的 runtime API 串接。
- 沒有建立假的 integration route、mock API、假資料或 Dashboard。
- 沒有設定任何 provider key，也沒有呼叫模型、embedding、crawler、WordPress、Generic HTTP、GEOFlow Agent 或客戶網站。
- 沒有安裝 GEOFlow、執行 migration/seed、啟動 app/queue/scheduler/reverb/container、啟用 telemetry 或部署。
- 沒有品牌替換；GEOFlow 仍明確標示為第三方 Apache-2.0 元件。

## 下一階段邊界

下一階段才會設計 DiscoveryStack 到 GEOFlow 的內部簽名 API，並明確定義身份、job 與 evidence mapping。任何資料庫、RAG runtime、模型供應商、發布通道或 production deployment 都需要另案設計、審查與驗證，不能由這次原始碼導入推定已完成。
