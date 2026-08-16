# Scroll-Story 速度傾斜評估

目前場景已有 progress 驅動的節點推進、路徑 reveal、核心 `--scene-turn` 變形與 pointer parallax；正式 runtime 已證實它可前進與回捲同步。額外加入依滾動速度變化的傾斜或 full-screen wipe，會使右側的長標題與左側核心在使用者快速滑動時產生不可預測的視覺抖動。

本專案採取的結論是 **不新增速度傾斜與額外 wipe**。保留使用者停下時穩定、可閱讀的畫面，比追求更多瞬時運動更符合首頁的策略性閱讀與私人銀行式節奏。現有 transform／opacity 主導的動態和 reduced-motion／touch 回退仍能提供明確互動感，且不新增持續 scroll 工作量。
