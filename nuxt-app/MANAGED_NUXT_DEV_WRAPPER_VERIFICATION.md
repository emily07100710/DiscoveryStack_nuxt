# 受管 Nuxt Dev Wrapper 驗證

驗證日期：2026-08-16

## 目的

此環境會讓原生 `nuxt dev` 在成功啟動後以 exit code 0 結束。專案因此保留兩個清楚分工的指令：

| 指令 | 用途 |
| --- | --- |
| `pnpm dev` | 受管 3000 preview 的穩定預設；由最新完整 `.output/public` 提供靜態可檢視頁面。 |
| `pnpm dev:nuxt` | `scripts/managed-nuxt-dev.mjs` 啟動的 Nuxt 開發 runner；子程序非預期結束時等待一秒並重啟。 |

## 實測

在不干擾 3000 preview 的 3101 埠執行下列 12 秒受限測試：

```bash
timeout --signal=TERM 12s env PORT=3101 pnpm dev:nuxt
```

輸出先顯示 `Local: http://0.0.0.0:3101/`，接著偵測到 Nuxt child `exited (0)` 並記錄 `restarting in 1000ms.`，其後再次輸出相同 Local URL。最終 `timeout-status=124` 代表外部測試時限主動終止**仍在常駐的 wrapper**，而不是 runner 自行結束。

> 驗收結論：Nuxt child 在此平台仍可能 exit 0；但 `dev:nuxt` wrapper 不會隨之退出，會重啟 child。受管 UI 的預設仍採 `pnpm dev` static preview，以確保使用者可穩定開啟 3000 預覽；這兩者的互動／API 範圍差異已在既有 preview 文件中說明。

## Build／Generate 邊界

`dev:nuxt` runner 只由 `dev:nuxt` script 呼叫，並不改寫 `build`、`generate` 或 `preview` 指令。於本機驗收時，`pnpm generate` 成功重建 40 條路由，重新確認 `.output/public` 有 16 個公開 EN／ZH-Hant HTML 入口，且 3000 `/en` 回應 200。

兩次直接 `pnpm build` 嘗試皆在「Building Nuxt Nitro server」階段被 sandbox 以訊號終止（一次 exit 137、一次 exit 143）；這不是 dev wrapper 的 child exit 0 現象，且無法在此記憶體／時間受限的 sandbox 宣稱為本機 build 成功。本專案既有 Docker 化 production deployment 已成功運作；未來若需要重跑完整本機 server bundle，應在具有足夠 build budget 的環境執行。 
