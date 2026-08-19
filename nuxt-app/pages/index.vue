<!-- Quiet Intelligence: headline is a real SSR h1; visual rhythm does not replace semantic hierarchy. -->
<script setup lang="ts">
import AiQaDock from '~/components/landing/AiQaDock.vue'
import AutomaticSiteAnalysis from '~/components/landing/AutomaticSiteAnalysis.vue'

const route = useRoute()
const isZh = computed(() => route.path.startsWith('/zh-hant'))
const locale = computed<'en' | 'zh-hant'>(() => isZh.value ? 'zh-hant' : 'en')

const copy = computed(() => isZh.value
  ? {
      title: '客戶正在搜尋。',
      accent: '別再讓答案指向別人。',
      description: 'DiscoveryStack 是由自研機器學習模型驅動的一站式行銷公司。五個專業部門，從品牌官網、系統與資料庫、AI 導入到 SEO／GEO 與轉換，全部負責到底。',
      kicker: 'DiscoveryStack',
      subkicker: '一間公司 · 五個部門 · 一條獲客路徑',
      action: '免費分析你的網站',
      secondaryAction: '選擇你遇到的問題',
    }
  : {
      title: 'Customers are searching.',
      accent: 'Stop letting the answer point elsewhere.',
      description: 'DiscoveryStack is an end-to-end marketing company powered by our own trained machine-learning model. Five specialist departments take responsibility from brand and web to systems, data, AI, SEO/GEO and conversion.',
      kicker: 'DiscoveryStack',
      subkicker: 'One company · Five departments · One acquisition route',
      action: 'Analyse your website for free',
      secondaryAction: 'Choose the problem first',
    })

const homeTitle = () => isZh.value ? '一站式行銷、網站、系統、AI 與 SEO／GEO 公司' : 'End-to-end marketing, web, systems, AI and SEO/GEO'
const homeDescription = () => isZh.value ? 'DiscoveryStack 以自研機器學習模型與五個專業部門，整合行銷、網站設計、系統規劃、AI 導入與 SEO／GEO。' : 'DiscoveryStack combines marketing, web design, systems, AI adoption and SEO/GEO through five specialist departments and our own trained ML model.'
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
      { num: '01', tag: '診斷', label: '看清問題', title: '先找出真正阻礙訂單的地方。', desc: '從網站、搜尋、AI 能見度、內容、資料與轉換訊號建立共同基準，不急著先賣你某一項服務。' },
      { num: '02', tag: '組隊', label: '組成解法', title: '只讓需要的部門進場。', desc: '依問題組成行銷、網站、系統、AI 與 SEO／GEO 的執行路徑，定義優先序、責任與可驗證成果。' },
      { num: '03', tag: '落地', label: '整合執行', title: '策略、介面與系統一起落地。', desc: '同一份需求脈絡貫穿內容、設計、開發、資料與自動化，避免五間廠商各自完成卻彼此接不起來。' },
      { num: '04', tag: '成長', label: '持續改善', title: '用真實訊號決定下一輪。', desc: '追蹤搜尋、AI 引用、有效詢問、成交來源與營運效率，把結果重新帶回模型、內容與流程改善。' },
    ]
  : [
      { num: '01', tag: 'Diagnose', label: 'See the problem', title: 'Find what is really blocking the order.', desc: 'Build a shared baseline across web, search, AI visibility, content, data and conversion before prescribing a service.' },
      { num: '02', tag: 'Assemble', label: 'Build the route', title: 'Bring in only the departments the problem needs.', desc: 'Define priorities, ownership and inspectable outcomes across Marketing, Web, Systems, AI and SEO/GEO.' },
      { num: '03', tag: 'Deliver', label: 'Execute together', title: 'Strategy, interface and systems land together.', desc: 'Keep one demand context across content, design, development, data and automation so the parts actually connect.' },
      { num: '04', tag: 'Improve', label: 'Keep learning', title: 'Let real signals decide the next cycle.', desc: 'Feed search, AI citations, qualified enquiries, revenue source and operational efficiency back into the next improvements.' },
    ])

const departments = computed(() => isZh.value
  ? [
      { number: '01', name: '行銷部', english: 'Growth Strategy', promise: '不是多做幾則貼文，而是先決定每一分預算要把誰推向哪一步。', services: ['品牌定位與市場研究', '整體行銷策略與轉換漏斗', '廣告、社群與內容行銷', '數據追蹤與轉換優化'] },
      { number: '02', name: '網站設計部', english: 'Brand Experience', promise: '做的不只是好看的網站，而是一個能被找到、理解並採取行動的品牌入口。', services: ['企業官網與品牌網站', '電商、預約與會員網站', 'Landing Page 與銷售頁', 'UX／UI、改版與維護'] },
      { number: '03', name: '系統規劃部', english: 'Digital Systems', promise: '把散落的資料、流程與工具接起來，讓成長不再靠人工搬運。', services: ['CRM、CMS 與管理後台', '資料庫、API 與第三方串接', '自動化工作流程', '企業客製系統'] },
      { number: '04', name: 'AI 導入部', english: 'AI Applications', promise: '不只是接上通用聊天工具，而是把 AI 放進真正需要加速的工作流程。', services: ['官網 Chatbot 與知識庫', 'AI 助理與流程自動化', 'RAG、LLM 與系統整合', '機器學習與客製模型'] },
      { number: '05', name: 'SEO／GEO 部', english: 'Search Growth', promise: '讓搜尋引擎找得到，也讓答案引擎知道為什麼應該引用你。', services: ['技術 SEO 與網站結構', '內容、實體與 Schema', 'GEO／AEO 與 AI 搜尋', '排名、引用與流量監測'] },
    ]
  : [
      { number: '01', name: 'Marketing', english: 'Growth Strategy', promise: 'Not more activity for its own sake—a decision about who each dollar should move, and where.', services: ['Positioning and market research', 'Marketing strategy and funnels', 'Paid, social and content', 'Tracking and conversion optimisation'] },
      { number: '02', name: 'Web Design', english: 'Brand Experience', promise: 'Not just a better-looking site, but a brand entry point built to be found, understood and acted on.', services: ['Corporate and brand websites', 'Commerce, booking and membership', 'Landing and sales pages', 'UX/UI, redesign and care'] },
      { number: '03', name: 'Systems', english: 'Digital Systems', promise: 'Connect fragmented data, workflows and tools so growth no longer depends on manual hand-offs.', services: ['CRM, CMS and operations', 'Database, API and integrations', 'Workflow automation', 'Custom business systems'] },
      { number: '04', name: 'AI Adoption', english: 'AI Applications', promise: 'More than attaching a generic chat tool—we place AI inside the work that genuinely needs acceleration.', services: ['Website chatbot and knowledge base', 'AI assistants and automation', 'RAG, LLM and system integration', 'Machine learning and custom models'] },
      { number: '05', name: 'SEO / GEO', english: 'Search Growth', promise: 'Make the site discoverable to search engines and worth citing for answer engines.', services: ['Technical SEO and architecture', 'Content, entities and schema', 'GEO/AEO and AI search', 'Ranking, citation and traffic tracking'] },
    ])

const activeDepartmentIndex = ref(0)
const activeDepartment = computed(() => departments.value[activeDepartmentIndex.value] || departments.value[0]!)

const modelLayers = computed(() => isZh.value
  ? [
      { code: '01 / SIGNAL CONTRACT', title: '先把網站轉成可計算的訊號。', stack: 'page_manifest · entity_map · topic_map · technical_seo', desc: '將抓取、索引、內容實體、主題群與技術 SEO 統一成版本化 Feature Contract，避免模型只讀一堆沒有結構的文字。' },
      { code: '02 / RETRIEVAL BASELINE', title: '建立語意檢索與相似度基線。', stack: 'BGE-M3 · embeddings · de-identified aggregates', desc: '用去識別後的特徵聚合建立向量表徵與 retrieval baseline；原始頁面內容不會未經治理就直接進入訓練資料。' },
      { code: '03 / SUPERVISED MULTI-TASK', title: '共享編碼器，同時學九種判斷。', stack: 'multilingual DistilBERT · shared encoder · 9 task heads', desc: '在多語基礎模型上進行 supervised fine-tuning，同步預測旅程階段、搜尋意圖、引用準備度、摩擦訊號與行動優先序。' },
      { code: '04 / DECISION ORCHESTRATION', title: '模型輸出，最後仍由策略負責。', stack: 'friction signals · action priority · human-in-the-loop', desc: '把預測轉成可執行的 SEO／GEO 與轉換工作；策略師覆核證據、風險與商業脈絡後，才進入客戶決策。' },
    ]
  : [
      { code: '01 / SIGNAL CONTRACT', title: 'Turn the website into computable signals.', stack: 'page_manifest · entity_map · topic_map · technical_seo', desc: 'Crawl, indexation, entities, topic clusters and technical SEO become a versioned feature contract—not an unstructured pile of text.' },
      { code: '02 / RETRIEVAL BASELINE', title: 'Establish semantic retrieval baselines.', stack: 'BGE-M3 · embeddings · de-identified aggregates', desc: 'De-identified feature aggregates form embeddings and retrieval baselines; raw page content does not enter training without governance.' },
      { code: '03 / SUPERVISED MULTI-TASK', title: 'One shared encoder, nine concurrent judgements.', stack: 'multilingual DistilBERT · shared encoder · 9 task heads', desc: 'Supervised fine-tuning predicts journey stage, search intent, citation readiness, friction signals and action priority together.' },
      { code: '04 / DECISION ORCHESTRATION', title: 'The model informs; strategists remain accountable.', stack: 'friction signals · action priority · human-in-the-loop', desc: 'Predictions become executable SEO/GEO and conversion work only after evidence, risk and commercial context are reviewed.' },
    ])

const modelGovernance = computed(() => isZh.value
  ? [
      { term: 'DATASET LINEAGE', value: 'Approved manifest', detail: 'manifestHash / datasetDigest' },
      { term: 'VERSION CONTROL', value: '三層契約版本', detail: 'feature / taxonomy / split' },
      { term: 'EVALUATION', value: '獨立驗證與測試集', detail: 'accuracy / macro-F1' },
      { term: 'MODEL REGISTRY', value: 'Private artifact', detail: 'job status / version history' },
      { term: 'GOVERNANCE GATES', value: '五道資料閘門', detail: 'consent / quality / PII / policy / review' },
    ]
  : [
      { term: 'DATASET LINEAGE', value: 'Approved manifest', detail: 'manifestHash / datasetDigest' },
      { term: 'VERSION CONTROL', value: 'Three versioned contracts', detail: 'feature / taxonomy / split' },
      { term: 'EVALUATION', value: 'Held-out validation and test', detail: 'accuracy / macro-F1' },
      { term: 'MODEL REGISTRY', value: 'Private artifact', detail: 'job status / version history' },
      { term: 'GOVERNANCE GATES', value: 'Five data gates', detail: 'consent / quality / PII / policy / review' },
    ])

const modelTaskHeads = computed(() => isZh.value
  ? ['旅程階段', '搜尋意圖', '內容型態', '受眾角色', 'GEO 訊號', '引用準備度', '技術 SEO', '摩擦訊號', '行動優先序']
  : ['Journey stage', 'Search intent', 'Content type', 'Audience role', 'GEO signals', 'Citation readiness', 'Technical SEO', 'Friction signals', 'Action priority'])

const modelTerms = ['ENTITY MAP', 'CITATION READINESS', 'MULTI-TASK LEARNING', 'MACRO-F1', 'DATASET LINEAGE', 'HUMAN-IN-THE-LOOP']

const demandQuestions = computed(() => isZh.value
  ? ['台灣 SEO／GEO 公司怎麼選？', '誰能把網站、系統與行銷一起做好？', '我的品牌為什麼沒有出現在 AI 回答？', '有流量卻沒有詢問，問題在哪裡？', '如何把客服與公司知識接進 AI？']
  : ['How do I choose an SEO/GEO agency?', 'Who can connect web, systems and marketing?', 'Why is my brand absent from AI answers?', 'We have traffic but no enquiries—why?', 'How do we connect company knowledge to AI?'])

const visibilityServices = computed(() => isZh.value
  ? [
      { num: '01', tag: 'Discover', title: '先知道市場正在問什麼。', body: '盤點品牌、品類、競品與高意圖問題，建立提示詞地圖與搜尋需求地圖；不是拿一張關鍵字表就開始寫文章。', output: '交付：需求地圖／競品差距／AI 能見度基準' },
      { num: '02', tag: 'Structure', title: '讓網站成為機器讀得懂的事實來源。', body: '整理抓取、索引、網站架構、內部連結、Schema 與品牌實體，讓搜尋引擎和答案引擎能辨認你是誰、做什麼、憑什麼。', output: '交付：技術稽核／實體架構／Schema 規格' },
      { num: '03', tag: 'Answer', title: '把專業變成可以被引用的答案。', body: '重整服務頁、比較頁、FAQ、案例與知識內容，補上明確主張、來源、作者與更新紀錄，讓內容既能說服人，也方便 AI 正確擷取。', output: '交付：內容藍圖／答案模組／編輯規範' },
      { num: '04', tag: 'Authority', title: '只在自己網站說自己好，還不夠。', body: '建立一致的品牌資料、評論、媒體與產業引用訊號，修正網路上互相矛盾的資訊，讓答案背後有可交叉驗證的證據。', output: '交付：權威訊號清單／外部資料修正／數位公關方向' },
      { num: '05', tag: 'Measure', title: '不只看排名，也看誰正在引用你。', body: '持續追蹤 Google 搜尋、AI Overview、ChatGPT、Gemini、Perplexity 等環境中的提示詞覆蓋、品牌描述、引用來源與競品差距。', output: '交付：排名與引用監測／月度變化／優化優先序' },
      { num: '06', tag: 'Convert', title: '被看見之後，必須接得住訂單。', body: '把高意圖流量接到對的頁面、表單、AI QA、CRM 與真人跟進，讓行銷部、網站部、系統部和 AI 部共同對轉換負責。', output: '交付：轉換路徑／追蹤事件／跨部門執行清單' },
    ]
  : [
      { num: '01', tag: 'Discover', title: 'Start with what the market is actually asking.', body: 'Map brand, category, competitor and high-intent questions into a prompt and demand landscape—not a keyword spreadsheet without context.', output: 'Deliverables: demand map / competitor gaps / AI visibility baseline' },
      { num: '02', tag: 'Structure', title: 'Turn the site into a machine-readable source of truth.', body: 'Fix crawl, indexation, architecture, internal links, schema and entities so search and answer engines can identify who you are and why you are credible.', output: 'Deliverables: technical audit / entity architecture / schema specification' },
      { num: '03', tag: 'Answer', title: 'Make expertise quotable.', body: 'Restructure services, comparisons, FAQs, cases and knowledge content with clear claims, sources, authors and update history.', output: 'Deliverables: content blueprint / answer modules / editorial rules' },
      { num: '04', tag: 'Authority', title: 'Your own website cannot be the only proof.', body: 'Build consistent brand data, reviews, media and industry references while correcting conflicting information across the web.', output: 'Deliverables: authority signal plan / data corrections / digital PR direction' },
      { num: '05', tag: 'Measure', title: 'Track who cites you—not rankings alone.', body: 'Monitor prompt coverage, brand descriptions, citations and competitor gaps across Google, AI Overviews, ChatGPT, Gemini and Perplexity.', output: 'Deliverables: rank and citation tracking / monthly shifts / priorities' },
      { num: '06', tag: 'Convert', title: 'Visibility still has to become revenue.', body: 'Connect intent to the right page, form, AI QA, CRM and human follow-up so every department shares responsibility for conversion.', output: 'Deliverables: conversion route / tracked events / cross-team execution plan' },
    ])

const activeVisibilityIndex = ref(0)
const activeVisibility = computed(() => visibilityServices.value[activeVisibilityIndex.value] || visibilityServices.value[0]!)

const measurementSignals = computed(() => isZh.value
  ? [
      { code: 'SEARCH', title: '搜尋需求', detail: '曝光、排名、非品牌字與自然流量品質' },
      { code: 'ANSWER', title: 'AI 能見度', detail: '提示詞覆蓋、品牌提及、引用來源與描述準確度' },
      { code: 'ACTION', title: '轉換行為', detail: '有效詢問、表單完成、預約與成交來源' },
      { code: 'SYSTEM', title: '營運效率', detail: '資料完整度、自動化覆蓋與人工交接時間' },
    ]
  : [
      { code: 'SEARCH', title: 'Search demand', detail: 'Impressions, rankings, non-brand terms and organic traffic quality' },
      { code: 'ANSWER', title: 'AI visibility', detail: 'Prompt coverage, mentions, citation sources and description accuracy' },
      { code: 'ACTION', title: 'Conversion', detail: 'Qualified enquiries, form completion, bookings and revenue source' },
      { code: 'SYSTEM', title: 'Operations', detail: 'Data completeness, automation coverage and hand-off time' },
    ])

const faqs = computed(() => isZh.value
  ? [
      { q: 'SEO、GEO 和 AEO 到底差在哪裡？', a: 'SEO 處理網站被搜尋引擎抓取、理解與排名的基礎；GEO 關注品牌是否會被生成式 AI 檢索、描述與引用；AEO 則讓內容更容易成為直接答案。三者共享技術、內容與權威基礎，不應拆成互不相干的三包服務。' },
      { q: '只做 GEO，不改網站也可以嗎？', a: '通常不行。若網站抓取、架構、品牌實體或內容證據不完整，AI 沒有可靠來源可引用。DiscoveryStack 會先判斷缺口是在技術、內容、外部權威，還是整個網站與系統需要一起調整。' },
      { q: '你們真的會做網站、系統和資料庫嗎？', a: '會。網站設計部負責品牌與轉換介面；系統規劃部處理 CMS、CRM、會員、資料庫、API 與後台；行銷、AI 和 SEO／GEO 部門在同一份需求路徑上共同工作。' },
      { q: 'AI Chatbot 是接一個通用模型就結束嗎？', a: '不是。我們會先定義知識來源、權限、不可回答範圍、真人轉接與資料回寫，再決定使用 RAG、工作流程、自研模型或其他模型組合。' },
      { q: '多久可以看到結果？', a: '網站與追蹤修正可以較快驗證；搜尋排名、外部權威與 AI 引用需要依網站基礎、競爭程度與平台更新週期累積。我們不承諾固定天數，而是先給基準、優先序和每一階段可驗證的訊號。' },
      { q: '不知道該買哪一項服務，也能詢問嗎？', a: '可以。先使用免費網站分析或合作諮詢，我們會把問題分到正確部門，再組成一條跨部門執行路徑，不要求你先替自己診斷。' },
    ]
  : [
      { q: 'What is the difference between SEO, GEO and AEO?', a: 'SEO builds crawl, understanding and ranking foundations. GEO focuses on whether generative AI retrieves, describes and cites the brand. AEO structures content to become a direct answer. They share technical, content and authority foundations and should not be sold as disconnected packages.' },
      { q: 'Can we do GEO without changing the website?', a: 'Usually not. If crawlability, architecture, entities or evidence are weak, AI systems have no reliable source to cite. We first locate the gap across technical, content, authority, web and systems.' },
      { q: 'Do you really build websites, systems and databases?', a: 'Yes. Web owns brand and conversion interfaces; Systems owns CMS, CRM, memberships, databases, APIs and operations; Marketing, AI and SEO/GEO work against the same demand route.' },
      { q: 'Is an AI chatbot just a generic model connection?', a: 'No. We define knowledge, permissions, refusal boundaries, human hand-off and data write-back before choosing RAG, workflows, our own model or another model mix.' },
      { q: 'How quickly will we see results?', a: 'Site and tracking fixes can be validated sooner. Rankings, authority and AI citations depend on the starting point, competition and platform cycles. We provide baselines and stage-level signals rather than a fixed-day promise.' },
      { q: 'Can we ask for help if we do not know which service to buy?', a: 'Yes. Start with the free analysis or fit review. We route the problem to the right departments instead of asking you to diagnose it first.' },
    ])

let visibilityObserver: IntersectionObserver | undefined
onMounted(() => {
  if (!('IntersectionObserver' in window)) return
  const visibilitySteps = Array.from(document.querySelectorAll<HTMLElement>('.visibility-step'))
  visibilityObserver = new IntersectionObserver((entries) => {
    const visible = entries
      .filter(entry => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
    if (visible) activeVisibilityIndex.value = Number((visible.target as HTMLElement).dataset.visibilityIndex || 0)
  }, { rootMargin: '-28% 0px -42% 0px', threshold: [0, .25, .6] })
  visibilitySteps.forEach(step => visibilityObserver?.observe(step))
})
onBeforeUnmount(() => visibilityObserver?.disconnect())

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
  intent: 'unsure',
  context: '',
  companyFax: '',
  privacy: false,
  followup: false,
})
const formStatus = ref('')
const submitForm = async () => {
  if (formData.companyFax) return // honeypot
  if (!formData.name || !formData.email || !formData.company || !formData.privacy) {
    formStatus.value = isZh.value ? '請填寫姓名、Email、公司，並勾選資料處理同意。' : 'Please fill in name, email, company, and check privacy consent.'
    return
  }
  formStatus.value = isZh.value ? '正在送出…' : 'Sending…'
  try {
    await $fetch('/api/leads', {
      method: 'POST',
      body: {
        name: formData.name,
        email: formData.email,
        company: formData.company,
        website: formData.website,
        packageInterest: formData.intent,
        language: locale.value,
        message: formData.context,
        privacyConsent: formData.privacy,
        recontactConsent: formData.followup,
        companyFax: formData.companyFax,
      },
    })
    formStatus.value = isZh.value ? '已收到。我們會帶著你的背景，由適合的部門接手。' : 'Received. The right department will follow up with your context.'
  } catch {
    formStatus.value = isZh.value ? '目前無法送出，請稍後再試。' : 'We could not send this right now. Please try again shortly.'
  }
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
        <div class="hero-actions">
          <a class="cta" href="#analysis">{{ copy.action }} <span class="arrow" aria-hidden="true">↘</span></a>
          <a class="text-link" href="#departments">{{ copy.secondaryAction }} <span aria-hidden="true">→</span></a>
        </div>
      </div>
    </section>

    <!-- ============ 搜尋需求動態帶 ============ -->
    <section class="demand-ribbon" :aria-label="isZh ? '客戶正在提出的問題' : 'Questions customers are asking'">
      <div class="demand-track">
        <span v-for="(question, index) in [...demandQuestions, ...demandQuestions]" :key="index">
          <b>{{ isZh ? '正在搜尋' : 'Searching' }}</b>{{ question }}
        </span>
      </div>
    </section>

    <!-- ============ 五個專業部門 ============ -->
    <section class="section departments" id="departments">
      <div class="shell">
        <div class="section-head reveal">
          <p class="eyebrow">{{ isZh ? '一間公司／五個部門' : 'One company / Five departments' }}</p>
          <h2>{{ isZh ? '問題不分部門；解法必須跨部門。' : 'The problem does not respect departments. The solution has to cross them.' }}</h2>
        </div>

        <div class="department-system">
          <div class="department-tabs" role="tablist" :aria-label="isZh ? '選擇專業部門' : 'Choose a specialist department'">
            <button
              v-for="(department, index) in departments"
              :id="`department-tab-${index}`"
              :key="department.number"
              type="button"
              role="tab"
              :aria-selected="activeDepartmentIndex === index"
              :aria-controls="`department-panel-${index}`"
              :class="{ 'is-active': activeDepartmentIndex === index }"
              @click="activeDepartmentIndex = index"
              @mouseenter="activeDepartmentIndex = index"
              @focus="activeDepartmentIndex = index"
            >
              <span>{{ department.number }}</span>
              <strong>{{ department.name }}</strong>
              <small>{{ department.english }}</small>
            </button>
          </div>

          <article
            :key="activeDepartment.number"
            :id="`department-panel-${activeDepartmentIndex}`"
            class="department-panel"
            role="tabpanel"
            :aria-labelledby="`department-tab-${activeDepartmentIndex}`"
          >
            <p class="department-code">{{ activeDepartment.number }} / {{ activeDepartment.english }}</p>
            <h3>{{ activeDepartment.promise }}</h3>
            <ul>
              <li v-for="service in activeDepartment.services" :key="service">{{ service }}</li>
            </ul>
          </article>
        </div>
      </div>
    </section>

    <!-- 第四區：先理解服務能力，再用低門檻分析進入轉換 -->
    <AutomaticSiteAnalysis :locale="locale" @selected="formData.website = $event" />

    <!-- ============ 自研模型 ============ -->
    <section id="model" class="section model-proof">
      <div class="shell">
        <header class="model-proof-head reveal">
          <div>
            <p class="eyebrow">{{ isZh ? '台灣第一間 · OWNED SEARCH INTELLIGENCE MODEL' : 'TAIWAN’S FIRST · OWNED SEARCH INTELLIGENCE MODEL' }}</p>
            <h2>
              <span>{{ isZh ? '不是把 AI 接上網站；' : 'Not an AI wrapper;' }}</span>
              <span>{{ isZh ? '是把市場訊號訓練成決策系統。' : 'a market-signal decision system.' }}</span>
            </h2>
          </div>
          <div class="model-proof-intro">
            <p class="model-proof-position">{{ isZh ? '依目前公開可查資料與自研紀錄，DiscoveryStack 是台灣第一間以自研機器學習模型驅動的整合行銷公司。' : 'Based on currently available public information and our development record, DiscoveryStack positions itself as Taiwan’s first integrated marketing company powered by its own trained machine-learning model.' }}</p>
            <p>{{ isZh ? '我們不是把通用模型的回覆重新包裝成顧問報告，而是從 Feature Contract、training manifest、multi-task learning 到 model registry，建立可訓練、可評估、可追溯的 Search Intelligence Stack。' : 'We do not repackage generic model output as consulting. From feature contracts and training manifests to multi-task learning and a model registry, we operate an accountable Search Intelligence Stack.' }}</p>
            <div class="model-proof-stamps" aria-label="Model operating principles">
              <span>OWN TRAINING PIPELINE</span>
              <span>PRIVATE MODEL REGISTRY</span>
              <span>HUMAN-IN-THE-LOOP</span>
            </div>
          </div>
        </header>

        <div class="model-proof-board">
          <section class="model-pipeline" :aria-label="isZh ? '模型處理管線' : 'Model pipeline'">
            <header class="model-board-title">
              <div>
                <span>ARCHITECTURE / 04 LAYERS</span>
                <h3>{{ isZh ? '搜尋情報模型管線' : 'Search intelligence pipeline' }}</h3>
              </div>
              <p><i aria-hidden="true"></i>{{ isZh ? '版本化架構' : 'Versioned architecture' }}</p>
            </header>
            <ol>
              <li v-for="layer in modelLayers" :key="layer.code" class="model-pipeline-layer">
                <div class="model-layer-index">{{ layer.code.slice(0, 2) }}</div>
                <div class="model-layer-copy">
                  <p>{{ layer.code.slice(5) }}</p>
                  <h4>{{ layer.title }}</h4>
                  <span>{{ layer.desc }}</span>
                </div>
                <code>{{ layer.stack }}</code>
              </li>
            </ol>
          </section>

          <aside class="model-governance" :aria-label="isZh ? '模型治理與評估' : 'Model governance and evaluation'">
            <header class="model-board-title">
              <div>
                <span>MLOPS / GOVERNANCE</span>
                <h3>{{ isZh ? '不是黑盒子；每一步都有紀錄。' : 'Not a black box. Every step is recorded.' }}</h3>
              </div>
            </header>
            <dl>
              <div v-for="item in modelGovernance" :key="item.term">
                <dt>{{ item.term }}</dt>
                <dd>
                  <strong>{{ item.value }}</strong>
                  <code>{{ item.detail }}</code>
                </dd>
              </div>
            </dl>
            <div class="model-task-heads">
              <p>SHARED ENCODER / 9 TASK HEADS</p>
              <ul>
                <li v-for="task in modelTaskHeads" :key="task">{{ task }}</li>
              </ul>
            </div>
            <p class="model-governance-note">{{ isZh ? '模型負責縮小未知；人類負責承擔判斷。任何改善建議仍需通過資料同意、去識別、政策檢查與策略覆核。' : 'The model narrows uncertainty; people remain accountable. Recommendations still pass consent, de-identification, policy and strategy review.' }}</p>
          </aside>
        </div>

        <div class="model-proof-marquee" aria-hidden="true">
          <div v-for="repeat in 2" :key="repeat">
            <span v-for="term in modelTerms" :key="`${repeat}-${term}`">{{ term }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ SEO／GEO 完整服務場景 ============ -->
    <section class="section visibility-system" id="seo-geo">
      <div class="shell">
        <div class="section-head reveal">
          <p class="eyebrow">{{ isZh ? 'SEO／GEO／AEO · 從問題到訂單' : 'SEO / GEO / AEO · Question to revenue' }}</p>
          <h2>{{ isZh ? '不是把 GEO 三個字加進服務表。' : 'GEO is not three letters added to a service list.' }}</h2>
        </div>

        <div class="visibility-grid">
          <aside class="visibility-stage" aria-live="polite">
            <p class="visibility-stage-label">{{ isZh ? '目前處理階段' : 'Current layer' }} / {{ activeVisibility.num }}</p>
            <div class="visibility-query">
              <span>{{ activeVisibility.tag }}</span>
              <strong>{{ activeVisibility.title }}</strong>
            </div>
            <div class="visibility-output">
              <span>{{ isZh ? '可檢查的成果' : 'Inspectable output' }}</span>
              <p>{{ activeVisibility.output }}</p>
            </div>
            <div class="visibility-progress" aria-hidden="true">
              <i :style="{ width: `${((activeVisibilityIndex + 1) / visibilityServices.length) * 100}%` }"></i>
            </div>
            <p class="visibility-count">0{{ activeVisibilityIndex + 1 }} <span>/ 0{{ visibilityServices.length }}</span></p>
          </aside>

          <div class="visibility-steps">
            <article
              v-for="(service, index) in visibilityServices"
              :key="service.num"
              class="visibility-step"
              :class="{ 'is-active': activeVisibilityIndex === index }"
              :data-visibility-index="index"
            >
              <p><span>{{ service.num }}</span>{{ service.tag }}</p>
              <h3>{{ service.title }}</h3>
              <p>{{ service.body }}</p>
              <small>{{ service.output }}</small>
            </article>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ 合作交付流程（連續動畫核心） ============ -->
    <section class="section journey" id="journey">
      <div class="shell">
        <div class="section-head reveal">
          <p class="eyebrow">{{ isZh ? '合作不是轉包，是同一條交付路徑' : 'One delivery route, not a chain of subcontractors' }}</p>
          <h2>{{ isZh ? '從診斷到成長，始終只有一份共同目標。' : 'One shared objective from diagnosis through growth.' }}</h2>
        </div>

        <div class="journey-grid">
          <aside class="journey-rail" aria-hidden="true">
            <div class="rail-numbers" id="railNumbers">
              <b v-for="(step, i) in journeySteps" :key="i" :class="{ 'is-active': i === 0 }" :data-step="i">{{ step.num }}</b>
            </div>
            <p class="rail-label" id="railLabel">{{ journeySteps[0]?.label || '' }}</p>
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

    <!-- ============ 衡量訊號 ============ -->
    <section class="measurement-system">
      <div class="measurement-heading shell">
        <p class="eyebrow">{{ isZh ? '不交一份看完就忘的月報' : 'Not another report nobody acts on' }}</p>
        <h2>{{ isZh ? '我們追蹤的是「下一步有沒有發生」。' : 'We measure whether the next move happened.' }}</h2>
      </div>
      <div class="measurement-marquee" aria-hidden="true">
        <div>
          <span v-for="(signal, index) in [...measurementSignals, ...measurementSignals]" :key="index">{{ signal.code }} ↗</span>
        </div>
      </div>
      <div class="measurement-list shell">
        <article v-for="(signal, index) in measurementSignals" :key="signal.code">
          <p>0{{ index + 1 }} / {{ signal.code }}</p>
          <h3>{{ signal.title }}</h3>
          <span>{{ signal.detail }}</span>
        </article>
      </div>
    </section>

    <!-- ============ FAQ ============ -->
    <section class="section faq-system" id="faq">
      <div class="shell faq-grid">
        <div class="faq-intro">
          <p class="eyebrow">FAQ / {{ isZh ? '先把重要的說清楚' : 'Clarity before the call' }}</p>
          <h2>{{ isZh ? '你可能正在問。' : 'You may be asking.' }}</h2>
          <p>{{ isZh ? '不需要先學會所有術語，才有資格開始。' : 'You do not need to master the terminology before you start.' }}</p>
        </div>
        <div class="faq-list">
          <details v-for="(faq, index) in faqs" :key="faq.q" :open="index === 0">
            <summary><span>0{{ index + 1 }}</span>{{ faq.q }}<i aria-hidden="true">＋</i></summary>
            <p>{{ faq.a }}</p>
          </details>
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

        <form id="fitForm" novalidate @submit.prevent="submitForm">
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
              <input id="f-company" v-model="formData.company" name="company" type="text" autocomplete="organization" required>
            </div>
            <div class="field">
              <label for="f-site">{{ isZh ? '網站（選填）' : 'Website (optional)' }}</label>
              <input id="f-site" v-model="formData.website" name="website" type="url" inputmode="url" placeholder="https://">
            </div>
          </div>

          <div class="field">
            <label for="f-intent">{{ isZh ? '你想先釐清什麼？' : 'What do you want to clarify first?' }}</label>
            <select id="f-intent" v-model="formData.intent" name="intent">
              <option value="unsure">{{ isZh ? '還在釐清' : 'Still clarifying' }}</option>
              <option value="discover">{{ isZh ? '讓需求找到我' : 'Let demand find me' }}</option>
              <option value="clarify">{{ isZh ? '讓服務更容易被理解' : 'Make service easier to understand' }}</option>
              <option value="grow">{{ isZh ? '把流量推進成訂單' : 'Turn traffic into orders' }}</option>
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

    <AiQaDock :locale="locale" :proactive-delay="45_000" />
  </article>
</template>
