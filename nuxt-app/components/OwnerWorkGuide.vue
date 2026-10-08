<script setup lang="ts">
const tasks = [
  { title: '先看客戶需求', description: '有人留下合作需求時，先確認聯絡與服務範圍。', to: '/leads', action: '開啟客戶名單' },
  { title: '安排內容工作', description: '選擇正在服務的客戶，整理網站、文章題目與發文規則。', to: '/audit-lab/content-operations', action: '開啟內容工作台' },
  { title: '查看文章送審', description: '查看 LINE 綁定、待確認的文章與需要修改的稿件。', to: '/audit-lab/weekly-content', action: '開啟文章送審與 LINE' },
  { title: '追蹤發布成效', description: '發文後確認量測紀錄，再決定下一次要改善什麼。', to: '/audit-lab/measurement-operations', action: '開啟成效觀察' },
]
const steps = [
  { title: '整理客戶與可用資料', description: '先核對網站、品牌說明、可引用資料及服務範圍。', to: '/audit-lab/content-operations/strategy', action: '內容策略' },
  { title: '安排文章並請客戶確認', description: '先完成發文設定，再透過 LINE 請客戶確認確切稿件。', to: '/audit-lab/weekly-content', action: '文章送審與 LINE' },
  { title: '確認發布紀錄與成效', description: '客戶按確認不等於已發布；先查發布結果，再查搜尋與流量資料。', to: '/audit-lab/interventions', action: '改善追蹤' },
  { title: '另外審核學習資料', description: '發布同意不等於訓練同意。資料與模型都需要獨立核准。', to: '/audit-lab/learning-loop', action: '資料授權與模型學習' },
]
</script>

<template>
  <div class="work-guide">
    <section class="work-guide__section" aria-labelledby="daily-work-title">
      <div class="work-guide__heading"><div><p class="work-guide__eyebrow">日常工作</p><h2 id="daily-work-title">今天要處理什麼？</h2></div><p>選一項工作開始，不用先理解模型或工程設定。</p></div>
      <div class="work-guide__tasks">
        <article v-for="task in tasks" :key="task.to" class="work-guide__task">
          <h3>{{ task.title }}</h3><p>{{ task.description }}</p><NuxtLink :to="task.to">{{ task.action }} <span aria-hidden="true">→</span></NuxtLink>
        </article>
      </div>
      <p class="work-guide__note">這裡是工作入口，不是待辦數量或執行結果。客戶與文章的實際狀態，請進入對應工作台確認。</p>
    </section>

    <section class="work-guide__section work-guide__flow" aria-labelledby="work-order-title">
      <div class="work-guide__heading"><div><p class="work-guide__eyebrow">第一次使用</p><h2 id="work-order-title">服務一位客戶，照這個順序</h2></div></div>
      <ol>
        <li v-for="(step, index) in steps" :key="step.to"><span class="work-guide__number" aria-hidden="true">{{ index + 1 }}</span><div><h3>{{ step.title }}</h3><p>{{ step.description }}</p><NuxtLink :to="step.to">前往{{ step.action }}</NuxtLink></div></li>
      </ol>
    </section>

    <section class="work-guide__pilot" aria-labelledby="alignment-pilot-title">
      <div><p class="work-guide__eyebrow">第一個試跑網站</p><h2 id="alignment-pilot-title">Do Alignment</h2><p>用預約服務與部落格驗證文章流程。先完成本機測試，再逐步核對 LINE、網站接收端與量測；不要拿真實預約、學員或會員資料做測試。</p></div>
      <div class="work-guide__pilot-actions"><span>正式串接仍待核對</span><NuxtLink to="/audit-lab/weekly-content">核對客戶與文章設定 →</NuxtLink><small>開啟這個入口不會建立客戶、綁定 LINE 或發布文章；需要各頁的明確操作與授權。</small></div>
    </section>

    <details class="work-guide__help">
      <summary>不知道功能放在哪裡？</summary>
      <dl><div><dt>客戶與內容</dt><dd>客戶需求、品牌與選題、文章安排和 LINE 送審。</dd></div><div><dt>成效與改善</dt><dd>搜尋與流量觀察、AI 搜尋觀測、發布改動的追蹤。</dd></div><div><dt>知識與資料</dt><dd>公司知識、可引用的資料與網站來源檢查。</dd></div><div><dt>系統與設定</dt><dd>系統郵件紀錄；有錯誤時交由管理者處理。</dd></div><div><dt>進階工具</dt><dd>資料審核、模型、建站及系統建置。日常工作不必先操作這些工具。</dd></div></dl>
      <p>分組是操作指引，不是員工權限管理。目前仍沿用擁有人登入，尚未新增員工帳號或放寬資料存取權限。</p>
    </details>
  </div>
</template>

<style scoped>
.work-guide { color:#17253d; font-size:1rem; line-height:1.65; }
.work-guide__section { margin:0 0 1.8rem; }
.work-guide__heading { display:flex; align-items:flex-end; justify-content:space-between; flex-wrap:wrap; gap:.6rem 1.5rem; margin-bottom:1rem; }
.work-guide__heading > p { max-width:30rem; margin:0; color:#627084; font-size:.9rem; }
.work-guide__eyebrow { margin:0 0 .3rem; color:#466c7a; font-size:.73rem; font-weight:800; letter-spacing:.1em; }
.work-guide h2 { margin:0; font-size:clamp(1.35rem,2vw,1.8rem); line-height:1.35; }
.work-guide h3 { margin:0; font-size:1.03rem; }
.work-guide__tasks { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem; }
.work-guide__task { display:flex; flex-direction:column; min-width:0; padding:1.35rem; border:1px solid #dce3eb; border-radius:1rem; background:#fff; }
.work-guide__task p { flex:1; margin:.55rem 0 1rem; color:#627084; font-size:.91rem; }
.work-guide a { color:#285e70; font-weight:750; text-decoration:none; overflow-wrap:anywhere; }
.work-guide a:hover { text-decoration:underline; }
.work-guide a:focus-visible,.work-guide summary:focus-visible { outline:3px solid #70a0b2; outline-offset:4px; border-radius:3px; }
.work-guide__note { margin:.7rem 0 0; color:#627084; font-size:.78rem; }
.work-guide__flow { padding:1.5rem; border:1px solid #dce3eb; border-radius:1rem; background:#fff; }
.work-guide__flow ol { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1.5rem; margin:1.2rem 0 0; padding:0; list-style:none; }
.work-guide__flow li { display:flex; align-items:flex-start; gap:.75rem; min-width:0; }
.work-guide__number { display:inline-flex; flex:0 0 1.7rem; justify-content:center; align-items:center; width:1.7rem; height:1.7rem; border-radius:50%; background:#e7eff2; color:#285e70; font-size:.8rem; font-weight:800; }
.work-guide__flow li p { margin:.4rem 0; color:#627084; font-size:.86rem; }
.work-guide__flow li a { font-size:.86rem; }
.work-guide__pilot { display:grid; grid-template-columns:minmax(0,1.6fr) minmax(0,1fr); gap:1.4rem; margin-bottom:1.8rem; padding:1.5rem; border:1px solid #ccdcd6; border-radius:1rem; background:#eaf2ee; }
.work-guide__pilot p:not(.work-guide__eyebrow) { margin:.6rem 0 0; color:#425e55; font-size:.9rem; }
.work-guide__pilot-actions { display:flex; flex-direction:column; align-items:flex-start; justify-content:center; gap:.6rem; }
.work-guide__pilot-actions > span { padding:.2rem .6rem; border:1px solid #c8d4c4; border-radius:2rem; background:#f6f8ef; color:#536538; font-size:.75rem; font-weight:750; }
.work-guide__pilot-actions small { color:#526d62; font-size:.76rem; }
.work-guide__help { padding:1rem 1.2rem; border:1px solid #dce3eb; border-radius:.8rem; background:#fff; }
.work-guide__help summary { cursor:pointer; font-weight:750; }
.work-guide__help dl { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem; margin:1.2rem 0; }
.work-guide__help dt { font-weight:750; font-size:.9rem; }
.work-guide__help dd { margin:.25rem 0 0; color:#627084; font-size:.85rem; }
.work-guide__help > p { margin:.7rem 0 0; color:#627084; font-size:.78rem; }
@media(max-width:760px) { .work-guide__tasks,.work-guide__flow ol,.work-guide__pilot,.work-guide__help dl { grid-template-columns:minmax(0,1fr); }.work-guide__task,.work-guide__flow,.work-guide__pilot { padding:1.1rem; }.work-guide__flow ol { gap:1.15rem; }.work-guide__heading > p { font-size:.85rem; } }
</style>
