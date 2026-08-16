# 正式 Scroll-Story 驗證

正式英文首頁以 CDP 在中段 scene 實測。畫面顯示 `02 / 04` 進度、左側連續路徑與標記節點、黃銅訊號點與核心，同時在右側呈現對應的 Clarity 文字場景。這確認 scroll position 會同步驅動敘事狀態，而非只切換靜態內容。

現有實作以連續 progress、pointer parallax 與 CSS `--scene-turn` 進行可逆場景變形；`prefers-reduced-motion` 與 touch fallback 仍由既有回歸／可及性驗收保護。速度傾斜與連續 wipe 屬可選視覺提升，未把它們誤報為已完成。
