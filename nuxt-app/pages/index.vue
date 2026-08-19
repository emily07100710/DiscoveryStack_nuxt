<!-- Quiet Intelligence: headline is a real SSR h1; visual rhythm does not replace semantic hierarchy. -->
<script setup lang="ts">
const route = useRoute()
const isZh = computed(() => route.path.startsWith('/zh-hant'))

const copy = computed(() => isZh.value
  ? {
      title: '你的客戶正在搜尋你在做的事。',
      accent: '問題是，他們最後找到誰。',
      description: '我們把搜尋、理解與下一步之間的斷點，做成可以被看見、被改善、被推進的客戶系統。',
      kicker: 'DiscoveryStack',
      subkicker: '需求是一條路徑，不是一種期待',
      action: '先看你的需求路徑',
      proof: '先取得注意力，再把它推進成下一步。',
      approachLede: '網站不是裝飾品。它是人、搜尋引擎與答案引擎共同閱讀的一套證據與決策系統。我們不承諾排名，也不用自動化取代策略判斷——我們讓每一次抵達，都能自己解釋為什麼值得留下。',
      promise1: '讓需求找到正確頁面。',
      promise2: '讓承諾被清楚理解。',
      promise3: '讓下一步毫不含糊。',
    }
  : {
      title: 'Your customers are already searching for what you do.',
      accent: 'The question is who they find.',
      description: 'We turn the break between search, understanding and a clear next step into a customer system you can see, improve and move forward.',
      kicker: 'DiscoveryStack',
      subkicker: 'Demand is a route, not a hope',
      action: 'Review your demand path',
      proof: 'Earn attention. Then give it a next move.',
      approachLede: 'A website is not decoration. It is a system of evidence and decisions read by people, search engines and answer engines. We do not promise rankings or replace strategic judgment with automation—we let every arrival explain for itself why it is worth staying.',
      promise1: 'Let demand land on the right page.',
      promise2: 'Make the promise easy to understand.',
      promise3: 'Make the next step unmistakable.',
    })

const homeTitle = () => isZh.value ? '需求正在搜尋。確保它最後找到你。' : 'Demand is already searching. Make sure it finds you.'
const homeDescription = () => isZh.value ? 'DiscoveryStack 為服務型企業建立 SEO／GEO-first 客戶系統。' : 'DiscoveryStack builds SEO/GEO-first customer systems for service businesses.'
const { baseUrl } = usePageSeo({
  title: homeTitle,
  description: homeDescription,
  type: 'website',
  jsonLd: ({ baseUrl }) => ({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', '@id': `${baseUrl}/#organization`, name: 'DiscoveryStack', url: baseUrl, description: homeDescription() },
      { '@type': 'WebSite', '@id': `${baseUrl}/#website`, name: 'DiscoveryStack', url: baseUrl, publisher: { '@id': `${baseUrl}/#organization` } },
      { '@type': 'WebPage', '@id': `${baseUrl}/${isZh.value ? 'zh-hant' : 'en'}#webpage`, url: `${baseUrl}/${isZh.value ? 'zh-hant' : 'en'}`, name: homeTitle(), description: homeDescription(), isPartOf: { '@id': `${baseUrl}/#website` }, about: { '@id': `${baseUrl}/#organization` }, inLanguage: isZh.value ? 'zh-Hant' : 'en' },
    ],
  }),
})

// Hero 動畫
const heroTitle = ref<HTMLElement | null>(null)
onMounted(() => {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (heroTitle.value && !reduce) {
    setTimeout(() => heroTitle.value?.classList.add('is-in'), 80)
  }
  
  // 捲動揭露
  const revealables = document.querySelectorAll('.reveal')
  if (!reduce && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in')
          io.unobserve(entry.target)
        }
      })
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.15 })
    revealables.forEach((el) => io.observe(el))
  }

  // 路徑軌進度
  const rail = document.querySelector('.route-rail') as HTMLElement
  let ticking = false
  const onScroll = () => {
    const doc = document.documentElement
    const max = doc.scrollHeight - window.innerHeight
    const pct = max > 0 ? (window.scrollY / max) * 100 : 0
    if (rail) rail.style.setProperty('--route-progress', pct.toFixed(2) + '%')
    ticking = false
  }
  window.addEventListener('scroll', () => {
    if (!ticking) {
      ticking = true
      requestAnimationFrame(onScroll)
    }
  }, { passive: true })
  onScroll()
})

const journeySteps = computed(() => isZh.value
  ? [
      { num: '01', tag: '抵達', label: '被找到', title: '工作在點擊之前就開始。', desc: '以意圖為起點建立頁面，讓真正的問題有一個真正能抵達的位置。' },
      { num: '02', tag: '理解', label: '被理解', title: '說不清楚，就很難被選擇。', desc: '用白話說明承諾、方法與足夠證據，讓人與答案引擎能判斷是否適合。' },
      { num: '03', tag: '信任', label: '被相信', title: '讓決策更值得相信。', desc: '整理證據、術語與負責任的邊界，讓人不必猜測就能判斷是否適合。' },
      { num: '04', tag: '推進', label: '被推進', title: '注意力需要一個真人的下一步。', desc: '把有用內容、有邊界的 AI 回答與真人對談接成一條清楚的交接路徑。' },
    ]
  : [
      { num: '01', tag: 'Arrival', label: 'Discovery', title: 'The work begins before the click.', desc: 'Build intent-led pages that give a real question a real place to land.' },
      { num: '02', tag: 'Understanding', label: 'Clarity', title: 'If they cannot explain it, they cannot choose it.', desc: 'Give people and answer engines a plain-language promise, visible method and enough evidence to judge fit.' },
      { num: '03', tag: 'Trust', label: 'Evidence', title: 'Make the decision easy to trust.', desc: 'Structure the proof, terminology and responsible boundaries that let people judge fit without guesswork.' },
      { num: '04', tag: 'Momentum', label: 'Momentum', title: 'Attention needs a human next move.', desc: 'Connect useful content, a bounded AI answer and a human conversation into one clear handoff.' },
    ])

// 需求路徑互動
const activeStepIndex = ref(0)
const journeyProgress = ref(0)
onMounted(() => {
  const steps = Array.from(document.querySelectorAll('.step'))
  const numbers = Array.from(document.querySelectorAll('.rail-numbers b'))
  const railLabel = document.getElementById('railLabel')
  const railTrack = document.getElementById('railTrack')

  const setActiveStep = (index: number) => {
    activeStepIndex.value = index
    numbers.forEach((n, i) => n.classList.toggle('is-active', i === index))
    if (railLabel && steps[index]) {
      railLabel.textContent = (steps[index] as HTMLElement).dataset.label || ''
    }
    if (railTrack) {
      railTrack.style.width = `${((index + 1) / steps.length) * 100}%`
    }
  }

  if (steps.length && 'IntersectionObserver' in window) {
    const stepIO = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const stepEl = entry.target as HTMLElement
          setActiveStep(Number(stepEl.dataset.step))
        }
      })
    }, { rootMargin: '-35% 0px -45% 0px', threshold: 0 })
    steps.forEach((s) => stepIO.observe(s))
  }
  setActiveStep(0)
})

// 表單處理
const formData = reactive({
  name: '',
  email: '',
  company: '',
  website: '',
  intent: '還在釐清',
  context: '',
  companyFax: '',
  privacy: false,
  followup: false,
})
const formStatus = ref('')
const submitForm = (e: Event) => {
  e.preventDefault()
  if (formData.companyFax) return // honeypot
  if (!formData.name || !formData.email || !formData.privacy) {
    formStatus.value = isZh.value ? '請填寫姓名、Email，並勾選資料處理同意。' : 'Please fill in name, email, and check privacy consent.'
    return
  }
  formStatus.value = isZh.value ? '這是設計原型，尚未真的送出。' : 'This is a design prototype, not yet submitted.'
}
</script>

<template>
  <article>
    <!-- ============ HERO ============ -->
    <section class="hero shell">
      <div class="hero-meta">
        <p class="eyebrow">{{ copy.kicker }}</p>
        <span class="rule"></span>
        <p class="eyebrow">{{ copy.subkicker }}</p>
      </div>

      <h1 ref="heroTitle" id="heroTitle">
        <span class="line"><span>{{ copy.title.split('。')[0] }}</span></span>
        <span class="line"><span><em>{{ copy.accent }}</em></span></span>
      </h1>

      <div class="hero-foot">
        <p>{{ copy.description }}</p>
        <a class="cta" href="#fit">{{ copy.action }} <span class="arrow" aria-hidden="true">↘</span></a>
      </div>
    </section>

    <!-- ============ 方法 ============ -->
    <section class="section shell" id="approach">
      <div class="section-head reveal">
        <p class="eyebrow">{{ isZh ? '方法' : 'Approach' }}</p>
        <h2>{{ copy.proof }}</h2>
      </div>

      <div class="approach-grid">
        <p class="approach-lede reveal-item">{{ copy.approachLede }}</p>

        <ol class="promise-list">
          <li><span class="num">01</span><span class="txt">{{ copy.promise1 }}</span></li>
          <li><span class="num">02</span><span class="txt">{{ copy.promise2 }}</span></li>
          <li><span class="num">03</span><span class="txt">{{ copy.promise3 }}</span></li>
        </ol>
      </div>
    </section>

    <!-- ============ 需求路徑（連續動畫核心） ============ -->
    <section class="section journey" id="journey">
      <div class="shell">
        <div class="section-head reveal">
          <p class="eyebrow">{{ isZh ? '不是流量漏斗，是需求推進系統' : 'Not a traffic funnel, a momentum system' }}</p>
          <h2>{{ isZh ? '每一步都必須替下一步留下理由。' : 'Each move must earn the right to the next.' }}</h2>
        </div>

        <div class="journey-grid">
          <aside class="journey-rail" aria-hidden="true">
            <div class="rail-numbers" id="railNumbers">
              <b v-for="(step, i) in journeySteps" :key="i" :class="{ 'is-active': i === 0 }" :data-step="i">{{ step.num }}</b>
            </div>
            <p class="rail-label" id="railLabel">{{ journeySteps[0].label }}</p>
            <div class="rail-track"><i id="railTrack"></i></div>
          </aside>

          <div class="journey-steps" id="journeySteps">
            <article
              v-for="(step, i) in journeySteps"
              :key="i"
              class="step"
              :data-step="i"
              :data-label="step.label"
            >
              <p class="step-tag"><b>{{ step.num }}</b> {{ step.tag }}</p>
              <h3>{{ step.title }}</h3>
              <p>{{ step.desc }}</p>
            </article>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ AI QA ============ -->
    <section class="section shell" id="qa">
      <div class="qa-grid">
        <div class="reveal">
          <p class="eyebrow">{{ isZh ? 'AI QA 助理' : 'AI QA Assistant' }}</p>
          <h2 style="font-size:clamp(1.9rem,4.2vw,3.6rem); line-height:1.2; margin-top:1.25rem;">
            {{ isZh ? '有問題時，我們陪你把下一步說清楚。' : 'When a question appears, we can make the next step clearer.' }}
          </h2>
          <p style="margin-top:1.5rem; color:var(--ink-mid); max-width:var(--measure);">
            {{ isZh ? 'AI QA 會先給你一個可靠的起點；需要更多脈絡時，再和真人一起確認。它的回答有明確邊界——不做商業承諾，不假裝確定。' : 'AI QA offers a grounded starting point; when more context is needed, a person joins the conversation. Its answers have clear boundaries—no business promises, no false certainty.' }}
          </p>
          <p style="margin-top:1.75rem;">
            <a class="text-link" href="#fit">{{ isZh ? '看它怎麼運作' : 'See how it works' }} <span aria-hidden="true">→</span></a>
          </p>
        </div>

        <div class="qa-demo">
          <div class="qa-demo-top">
            <span><span class="qa-dot"></span>AI QA</span>
            <span>{{ isZh ? '有邊界的回答' : 'Bounded answers' }}</span>
          </div>
          <p class="bubble ask">{{ isZh ? '我可以先問 SEO／GEO 嗎？' : 'Can I ask about SEO/GEO first?' }}</p>
          <p class="bubble reply">{{ isZh ? '可以。SEO 是讓人在搜尋結果找到你；GEO 是讓答案引擎在生成回答時能正確引用你。兩者共用同一份證據，但要求的結構不同。' : 'Yes. SEO helps people find you in search results; GEO helps answer engines cite you correctly when generating responses. Both share the same evidence, but require different structures.' }}</p>
          <p class="bubble ask">{{ isZh ? '你們如何避免 AI 說得太滿？' : 'How do you prevent AI from overpromising?' }}</p>
          <p class="bubble reply">{{ isZh ? '回答會標示依據與邊界。涉及商業判斷、報價或成效預測時，一律轉給真人，而不是給你一個聽起來很確定的猜測。' : 'Answers indicate their basis and boundaries. When it involves business judgment, quotes, or performance predictions, we hand off to a person rather than offering a confident-sounding guess.' }}</p>
          <p class="qa-note">{{ isZh ? '先提供可靠方向；商業判斷仍由真人與你一起確認。' : 'Provides reliable direction first; business decisions are confirmed with a person.' }}</p>
        </div>
      </div>
    </section>

    <!-- ============ 合作諮詢 ============ -->
    <section class="section fit" id="fit">
      <div class="shell fit-grid">
        <div class="fit-intro reveal">
          <p class="eyebrow">{{ isZh ? '合作諮詢' : 'Fit Review' }}</p>
          <h2 style="margin-top:1.25rem;">{{ isZh ? '把現在卡住的地方交給我們看。' : 'Show us where you are stuck right now.' }}</h2>
          <p>{{ isZh ? '留下最少但足夠的背景。我們會以人類判斷回覆，不以自動化承諾取代策略。' : 'Share the minimum but sufficient background. We respond with human judgment, not automated promises that replace strategy.' }}</p>
        </div>

        <form id="fitForm" novalidate @submit="submitForm">
          <div class="field-row">
            <div class="field">
              <label for="f-name">{{ isZh ? '你的姓名' : 'Your name' }}</label>
              <input id="f-name" v-model="formData.name" name="name" type="text" autocomplete="name" required>
            </div>
            <div class="field">
              <label for="f-email">{{ isZh ? '工作 Email' : 'Work email' }}</label>
              <input id="f-email" v-model="formData.email" name="email" type="email" autocomplete="email" required>
            </div>
          </div>

          <div class="field-row">
            <div class="field">
              <label for="f-company">{{ isZh ? '公司／品牌' : 'Company / Brand' }}</label>
              <input id="f-company" v-model="formData.company" name="company" type="text" autocomplete="organization">
            </div>
            <div class="field">
              <label for="f-site">{{ isZh ? '網站（選填）' : 'Website (optional)' }}</label>
              <input id="f-site" v-model="formData.website" name="website" type="url" inputmode="url" placeholder="https://">
            </div>
          </div>

          <div class="field">
            <label for="f-intent">{{ isZh ? '你想先釐清什麼？' : 'What do you want to clarify first?' }}</label>
            <select id="f-intent" v-model="formData.intent" name="intent">
              <option>{{ isZh ? '還在釐清' : 'Still clarifying' }}</option>
              <option>{{ isZh ? '讓需求找到我' : 'Let demand find me' }}</option>
              <option>{{ isZh ? '讓服務更容易被理解' : 'Make service easier to understand' }}</option>
              <option>{{ isZh ? '找出下一步的摩擦' : 'Find friction in next step' }}</option>
            </select>
          </div>

          <div class="field">
            <label for="f-context">{{ isZh ? '背景或目前卡住的問題（選填）' : 'Background or current stuck point (optional)' }}</label>
            <textarea id="f-context" v-model="formData.context" name="context" rows="4"></textarea>
          </div>

          <div class="honeypot" aria-hidden="true">
            <label for="f-fax">{{ isZh ? '公司傳真' : 'Company fax' }}</label>
            <input id="f-fax" v-model="formData.companyFax" name="companyFax" type="text" tabindex="-1" autocomplete="off">
          </div>

          <div class="consents">
            <label class="consent">
              <input v-model="formData.privacy" type="checkbox" name="privacy" required>
              <span>{{ isZh ? '我同意 DiscoveryStack 為回覆本次合作諮詢而處理這些資料。' : 'I agree that DiscoveryStack may process this data to respond to this inquiry.' }}</span>
            </label>
            <label class="consent">
              <input v-model="formData.followup" type="checkbox" name="followup">
              <span>{{ isZh ? '可以在這次諮詢以外，寄送後續相關資訊給我。' : 'You may send me relevant follow-up information beyond this inquiry.' }}</span>
            </label>
          </div>

          <div class="form-actions">
            <button class="cta" type="submit">{{ isZh ? '送出合作諮詢' : 'Submit inquiry' }} <span class="arrow" aria-hidden="true">↗</span></button>
            <span class="form-status" id="formStatus" role="status" aria-live="polite">{{ formStatus }}</span>
          </div>
        </form>
      </div>
    </section>
  </article>
</template>
