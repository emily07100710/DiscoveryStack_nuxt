<script setup lang="ts">
const props = defineProps<{ locale: 'en' | 'zh-hant' }>()
const emit = defineEmits<{ selected: [url: string] }>()
const isZh = computed(() => props.locale === 'zh-hant')
const website = ref('')
const preparedHost = ref('')
const error = ref('')
const status = ref<'idle' | 'scanning' | 'score' | 'submitting' | 'report'>('idle')
const activeStage = ref(0)
const leadError = ref('')
const timers: ReturnType<typeof setTimeout>[] = []
const lead = reactive({ name: '', email: '', company: '', industry: '', role: '', phone: '', budget: '', timeline: '', privacyConsent: false, recontactConsent: true, modelImprovementConsent: false, companyFax: '' })

const copy = computed(() => isZh.value ? {
  eyebrow: '免費 AI 網站分析', title: '花下一筆預算前，先找出網站漏掉的訂單。',
  intro: '輸入網址，先檢查 SEO／GEO、品牌、內容與使用體驗。公開網站看不出的事，我們不假裝知道。',
  label: '你的網站網址', placeholder: 'https://example.com', submit: '開始免費分析', scanning: '五個部門正在整理公開訊號', invalid: '請輸入完整的 http:// 或 https:// 公開網址。',
  demo: 'UI 示範', demoNote: '公開模型 API 尚未接線；以下數字只用來確認介面與轉換流程，不是這個網址的真實分析。',
  total: '網站獲客基礎分數', maturity: '成長基礎', unlockTitle: '分數只是起點。免費解鎖完整問題與部門建議。',
  unlockDeck: '留下基本資料時，系統會在背景準備完整報告。正式版本會把實際模型結果交給適合的部門。',
  name: '姓名', email: '工作 Email', company: '公司／品牌', industry: '產業', role: '職位', phone: '電話', budget: '預算範圍', timeline: '希望完成時間',
  privacy: '我同意 DiscoveryStack 為提供分析報告與合作建議而處理這些資料。', followup: '可以寄送完整報告與相關後續資訊給我。',
  modelImprovement: '我同意將去識別化的網站分析結果，用於改善 DiscoveryStack 的模型。（選填）',
  modelImprovementNote: '不包含姓名、Email、電話或預算；僅使用網站特徵及你對分析結果的確認或修正。',
  unlock: '免費解鎖完整報告', submitting: '正在建立你的報告…', required: '請完成必填資料與資料處理同意。', failed: '目前無法儲存資料，請稍後再試。',
  reportTitle: '你的跨部門行動路徑', reportDeck: '正式模型接線後，這裡會依真實證據排序。現在呈現的是報告結構示範。', next: '帶著分析結果預約顧問',
  stages: ['技術與索引', '答案可引用性', '品牌與內容', '使用體驗'],
  scores: [{ label: 'SEO', value: 68, note: '索引、結構與頁面訊號' }, { label: 'GEO', value: 54, note: '實體、證據與答案可引用性' }, { label: '品牌／內容', value: 72, note: '定位、層級與可信度' }, { label: 'UX', value: 61, note: '行動入口與閱讀摩擦' }],
  recommendations: [{ dept: 'SEO／GEO 部', title: '先修復能否被找到與引用的基礎' }, { dept: '網站設計部', title: '重新整理第一屏承諾與主要行動' }, { dept: '行銷部', title: '把搜尋意圖接到清楚的轉換路徑' }],
} : {
  eyebrow: 'Free AI website analysis', title: 'Before spending again, find the orders your site is losing.',
  intro: 'Enter a URL to review SEO/GEO, brand, content and user experience. If a public site cannot prove it, we do not pretend to know it.',
  label: 'Your website URL', placeholder: 'https://example.com', submit: 'Start free analysis', scanning: 'Five departments are structuring public signals', invalid: 'Enter a complete public http:// or https:// URL.',
  demo: 'UI demo', demoNote: 'The public model API is not connected yet. These numbers test the interface and conversion flow; they are not a real assessment of this URL.',
  total: 'Acquisition foundation score', maturity: 'Growth foundation', unlockTitle: 'A score is only the start. Unlock the full issues and department plan for free.',
  unlockDeck: 'While you leave the essentials, the system prepares the full report in the background. The production flow will pass real model evidence to the right departments.',
  name: 'Name', email: 'Work email', company: 'Company / brand', industry: 'Industry', role: 'Role', phone: 'Phone', budget: 'Budget range', timeline: 'Target timeline',
  privacy: 'I agree that DiscoveryStack may process these details to provide the analysis report and service recommendations.', followup: 'You may email the full report and relevant follow-up information to me.',
  modelImprovement: 'I agree that de-identified website analysis results may be used to improve DiscoveryStack’s model. (Optional)',
  modelImprovementNote: 'This excludes your name, email, phone number and budget; only website features and your confirmation or correction of the analysis may be used.',
  unlock: 'Unlock the full report for free', submitting: 'Preparing your report…', required: 'Complete the required details and data-processing consent.', failed: 'We could not save this right now. Please try again shortly.',
  reportTitle: 'Your cross-department action route', reportDeck: 'Once the production model is connected, this will be ordered by real evidence. This is the report structure preview.', next: 'Book a strategist with this analysis',
  stages: ['Technical and index', 'Answer readiness', 'Brand and content', 'User experience'],
  scores: [{ label: 'SEO', value: 68, note: 'Index, architecture and page signals' }, { label: 'GEO', value: 54, note: 'Entities, evidence and answer readiness' }, { label: 'Brand / content', value: 72, note: 'Positioning, hierarchy and trust' }, { label: 'UX', value: 61, note: 'Action routes and reading friction' }],
  recommendations: [{ dept: 'SEO / GEO', title: 'Fix the foundations of discovery and citation first' }, { dept: 'Web Design', title: 'Clarify the opening promise and primary action' }, { dept: 'Marketing', title: 'Connect search intent to a conversion route' }],
})

function clearTimers() { timers.splice(0).forEach(clearTimeout) }
function startAnalysis() {
  error.value = ''; leadError.value = ''; clearTimers()
  let parsed: URL
  try { parsed = new URL(website.value.trim()); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported') } catch { status.value = 'idle'; error.value = copy.value.invalid; return }
  website.value = parsed.toString(); preparedHost.value = parsed.hostname.replace(/^www\./, ''); emit('selected', website.value); activeStage.value = 0; status.value = 'scanning'
  copy.value.stages.slice(1).forEach((_, index) => timers.push(setTimeout(() => { activeStage.value = index + 1 }, (index + 1) * 650)))
  timers.push(setTimeout(() => { status.value = 'score' }, 2900))
}
async function unlockReport() {
  leadError.value = ''
  if (!lead.name.trim() || !lead.email.trim() || !lead.company.trim() || !lead.industry.trim() || !lead.role.trim() || !lead.phone.trim() || !lead.budget || !lead.timeline || !lead.privacyConsent) { leadError.value = copy.value.required; return }
  status.value = 'submitting'
  try {
    await $fetch('/api/leads', { method: 'POST', body: { name: lead.name, email: lead.email, company: lead.company, website: website.value, packageInterest: 'discover', language: props.locale, message: `Industry: ${lead.industry}\nRole: ${lead.role}\nPhone: ${lead.phone}\nBudget: ${lead.budget}\nTimeline: ${lead.timeline}\nSource: free-analysis`, privacyConsent: lead.privacyConsent, recontactConsent: lead.recontactConsent, modelImprovementConsent: lead.modelImprovementConsent, companyFax: lead.companyFax } })
    status.value = 'report'
  } catch { status.value = 'score'; leadError.value = copy.value.failed }
}
onBeforeUnmount(clearTimers)
</script>

<template>
  <section id="analysis" class="section automatic-analysis">
    <div class="shell analysis-shell">
      <header class="analysis-intro reveal"><p class="eyebrow">{{ copy.eyebrow }}</p><h2>{{ copy.title }}</h2><p>{{ copy.intro }}</p></header>
      <div class="analysis-workspace">
        <form v-if="status === 'idle'" class="analysis-url-form" novalidate @submit.prevent="startAnalysis">
          <label for="analysis-url">{{ copy.label }}</label><div><input id="analysis-url" v-model="website" type="url" inputmode="url" autocomplete="url" :placeholder="copy.placeholder"><button type="submit">{{ copy.submit }} <span aria-hidden="true">↘</span></button></div><p v-if="error" role="alert">{{ error }}</p>
        </form>
        <div v-else-if="status === 'scanning'" class="analysis-scanning" role="status" aria-live="polite">
          <div class="analysis-scanning-meta"><span>{{ preparedHost }}</span><span>{{ activeStage + 1 }}/{{ copy.stages.length }}</span></div><strong>{{ copy.scanning }}</strong>
          <ol><li v-for="(stage, index) in copy.stages" :key="stage" :class="{ 'is-active': activeStage === index, 'is-done': activeStage > index }"><span>{{ String(index + 1).padStart(2, '0') }}</span>{{ stage }}</li></ol>
        </div>
        <template v-else>
          <div class="analysis-demo-notice"><strong>{{ copy.demo }}</strong><p>{{ copy.demoNote }}</p></div>
          <div class="analysis-score-head"><div><p>{{ preparedHost }}</p><strong>64</strong><span>/ 100 · {{ copy.maturity }}</span></div><p>{{ copy.total }}</p></div>
          <div class="analysis-scores"><article v-for="score in copy.scores" :key="score.label"><div><h3>{{ score.label }}</h3><strong>{{ score.value }}</strong></div><div class="score-track" aria-hidden="true"><i :style="{ width: `${score.value}%` }"></i></div><p>{{ score.note }}</p></article></div>
          <form v-if="status === 'score' || status === 'submitting'" class="analysis-unlock" @submit.prevent="unlockReport">
            <div class="analysis-unlock-intro"><h3>{{ copy.unlockTitle }}</h3><p>{{ copy.unlockDeck }}</p></div>
            <div class="analysis-field-grid">
              <label><span>{{ copy.name }}</span><input v-model="lead.name" autocomplete="name" required></label><label><span>{{ copy.email }}</span><input v-model="lead.email" type="email" autocomplete="email" required></label>
              <label><span>{{ copy.company }}</span><input v-model="lead.company" autocomplete="organization" required></label><label><span>{{ copy.industry }}</span><input v-model="lead.industry" required></label>
              <label><span>{{ copy.role }}</span><input v-model="lead.role" autocomplete="organization-title" required></label><label><span>{{ copy.phone }}</span><input v-model="lead.phone" type="tel" autocomplete="tel" required></label>
              <label><span>{{ copy.budget }}</span><select v-model="lead.budget" required><option value="" disabled>—</option><option value="under-100k">NT$100k ↓</option><option value="100k-300k">NT$100k–300k</option><option value="300k-plus">NT$300k ↑</option></select></label>
              <label><span>{{ copy.timeline }}</span><select v-model="lead.timeline" required><option value="" disabled>—</option><option value="1-2-months">1–2 months</option><option value="3-6-months">3–6 months</option><option value="planning">Planning</option></select></label>
            </div>
            <label class="analysis-consent"><input v-model="lead.privacyConsent" type="checkbox" required><span>{{ copy.privacy }}</span></label><label class="analysis-consent"><input v-model="lead.recontactConsent" type="checkbox"><span>{{ copy.followup }}</span></label>
            <label class="analysis-consent analysis-consent-model"><input v-model="lead.modelImprovementConsent" type="checkbox"><span><strong>{{ copy.modelImprovement }}</strong><small>{{ copy.modelImprovementNote }}</small></span></label>
            <label class="analysis-honeypot" aria-hidden="true"><span>Company fax</span><input v-model="lead.companyFax" tabindex="-1" autocomplete="off"></label>
            <div class="analysis-unlock-action"><button type="submit" :disabled="status === 'submitting'">{{ status === 'submitting' ? copy.submitting : copy.unlock }} <span aria-hidden="true">↗</span></button><p role="status" aria-live="polite">{{ leadError }}</p></div>
          </form>
          <div v-else class="analysis-report"><div><p class="eyebrow">{{ copy.demo }}</p><h3>{{ copy.reportTitle }}</h3><p>{{ copy.reportDeck }}</p></div><ol><li v-for="(item, index) in copy.recommendations" :key="item.dept"><span>{{ String(index + 1).padStart(2, '0') }}</span><div><small>{{ item.dept }}</small><strong>{{ item.title }}</strong></div></li></ol><a href="#fit">{{ copy.next }} <span aria-hidden="true">↗</span></a></div>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.automatic-analysis{background:var(--paper)}.analysis-shell{display:grid;gap:clamp(3rem,7vw,6rem)}.analysis-intro{display:grid;grid-template-columns:minmax(10rem,.42fr) minmax(0,1fr);gap:1.25rem clamp(2rem,7vw,7rem);align-items:start}.analysis-intro h2{max-width:18ch;font-size:clamp(2rem,4.2vw,3.9rem);line-height:1.12}.analysis-intro>p:last-child{grid-column:2;max-width:42rem;color:var(--ink-mid)}.analysis-workspace{border:1px solid var(--line);background:var(--sand)}.analysis-url-form{padding:clamp(1.5rem,4vw,3rem)}.analysis-url-form>label,.analysis-field-grid span{font:500 .67rem/1.3 var(--font-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft)}.analysis-url-form>div{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.8rem;margin-top:.8rem}.analysis-url-form input{min-width:0;border:0;border-bottom:1px solid var(--ink);border-radius:0;background:transparent;padding:.8rem 0;color:var(--ink);font:400 clamp(1.05rem,2vw,1.4rem)/1.3 var(--font-body)}.analysis-url-form button,.analysis-unlock-action button{border:0;border-radius:.25rem;background:var(--cobalt);color:var(--paper);padding:1rem 1.3rem;font:500 .7rem/1.2 var(--font-mono);letter-spacing:.08em;cursor:pointer}.analysis-url-form>p,.analysis-unlock-action p{margin-top:.7rem;color:#9b332c;font-size:.85rem}.analysis-scanning{display:grid;gap:2rem;padding:clamp(2rem,5vw,4rem);background:var(--cobalt);color:var(--paper)}.analysis-scanning-meta{display:flex;justify-content:space-between;font:500 .66rem/1 var(--font-mono);letter-spacing:.1em;text-transform:uppercase;opacity:.7}.analysis-scanning>strong{max-width:18ch;font:700 clamp(2rem,4vw,3.6rem)/1.15 var(--font-display)}.analysis-scanning ol{display:grid;grid-template-columns:repeat(4,1fr);gap:1rem;margin:0;padding:0;list-style:none}.analysis-scanning li{display:grid;gap:.75rem;padding-top:1rem;border-top:1px solid rgba(250,247,241,.28);opacity:.38;font-size:.88rem}.analysis-scanning li span{font-family:var(--font-mono)}.analysis-scanning li.is-active,.analysis-scanning li.is-done{opacity:1}.analysis-demo-notice{display:grid;grid-template-columns:auto minmax(0,1fr);gap:1rem;padding:1rem 1.25rem;background:#f2dba9;color:#4f3c20}.analysis-demo-notice strong{font:600 .65rem/1.4 var(--font-mono);letter-spacing:.1em;text-transform:uppercase}.analysis-demo-notice p{font-size:.82rem;line-height:1.5}.analysis-score-head{display:flex;justify-content:space-between;gap:2rem;align-items:end;padding:clamp(1.5rem,4vw,3rem);border-bottom:1px solid var(--line)}.analysis-score-head>div p,.analysis-score-head>p{font:500 .67rem/1.4 var(--font-mono);letter-spacing:.08em;color:var(--ink-soft)}.analysis-score-head strong{font:700 clamp(4rem,10vw,8rem)/.85 var(--font-display);color:var(--cobalt)}.analysis-score-head span{color:var(--ink-soft)}.analysis-scores{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));padding:clamp(1rem,2vw,1.5rem)}.analysis-scores article{padding:1.25rem}.analysis-scores article>div:first-child{display:flex;justify-content:space-between;align-items:baseline}.analysis-scores h3{font-size:1.2rem}.analysis-scores strong{font:600 1.4rem/1 var(--font-mono);color:var(--cobalt)}.score-track{height:2px;margin:1rem 0;background:var(--line)}.score-track i{display:block;height:100%;background:var(--cobalt)}.analysis-scores p{color:var(--ink-soft);font-size:.82rem}.analysis-unlock{display:grid;gap:1.5rem;padding:clamp(1.5rem,4vw,3rem);border-top:1px solid var(--line);background:var(--sand-deep)}.analysis-unlock-intro{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2rem}.analysis-unlock-intro h3{font-size:clamp(1.5rem,3vw,2.5rem);line-height:1.25}.analysis-unlock-intro p{color:var(--ink-mid)}.analysis-field-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.analysis-field-grid label{display:grid;gap:.45rem}.analysis-field-grid input,.analysis-field-grid select{width:100%;border:1px solid var(--line);border-radius:0;background:var(--paper);padding:.75rem;color:var(--ink);font:400 1rem/1.3 var(--font-body)}.analysis-consent{display:grid;grid-template-columns:auto minmax(0,1fr);gap:.7rem;align-items:start;color:var(--ink-mid);font-size:.86rem}.analysis-consent input{margin-top:.35rem;accent-color:var(--cobalt)}.analysis-honeypot{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}.analysis-unlock-action{display:flex;flex-wrap:wrap;align-items:center;gap:1rem}.analysis-unlock-action button:disabled{opacity:.65;cursor:wait}.analysis-report{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr);gap:clamp(2rem,5vw,5rem);padding:clamp(1.5rem,4vw,3rem);border-top:1px solid var(--line);background:var(--sand-deep)}.analysis-report h3{margin-block:1rem;font-size:clamp(1.8rem,3.5vw,3rem);line-height:1.2}.analysis-report>div>p:last-child{color:var(--ink-mid)}.analysis-report ol{margin:0;padding:0;list-style:none}.analysis-report li{display:grid;grid-template-columns:2.5rem minmax(0,1fr);gap:1rem;padding:1.1rem 0;border-top:1px solid var(--line)}.analysis-report li>span,.analysis-report small{font:500 .65rem/1.3 var(--font-mono);color:var(--cobalt)}.analysis-report li div{display:grid;gap:.4rem}.analysis-report li strong{font-family:var(--font-display);font-size:1.15rem}.analysis-report>a{grid-column:2;width:fit-content;color:var(--cobalt);font:500 .7rem/1.4 var(--font-mono);text-decoration:none;border-bottom:1px solid currentColor}@media(max-width:52rem){.analysis-intro,.analysis-unlock-intro,.analysis-report{grid-template-columns:1fr}.analysis-intro>p:last-child,.analysis-report>a{grid-column:auto}.analysis-url-form>div,.analysis-field-grid{grid-template-columns:1fr}.analysis-scanning ol,.analysis-scores{grid-template-columns:repeat(2,1fr)}.analysis-score-head{align-items:start;flex-direction:column}}@media(max-width:34rem){.analysis-scanning ol,.analysis-scores{grid-template-columns:1fr}}
.analysis-consent-model{padding:.9rem;border:1px solid var(--line);background:rgba(255,255,255,.34)}
.analysis-consent-model span{display:grid;gap:.3rem}
.analysis-consent-model strong{color:var(--ink);font:500 .82rem/1.45 var(--font-body)}
.analysis-consent-model small{color:var(--ink-soft);font-size:.72rem;line-height:1.5}
</style>
