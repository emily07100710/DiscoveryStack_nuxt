<!-- Quiet Intelligence: headline is a real SSR h1; visual rhythm does not replace semantic hierarchy. -->
<script setup lang="ts">
import JourneySequence from '~/components/landing/JourneySequence.vue'
import AiQaDock from '~/components/landing/AiQaDock.vue'
import FitReviewForm from '~/components/lead/FitReviewForm.vue'

const route = useRoute()
const isZh = computed(() => route.path.startsWith('/zh-hant'))

const copy = computed(() => isZh.value
  ? {
      title: '你的客戶正在搜尋你在做的事。',
      accent: '問題是，他們最後找到誰。',
      description: '我們把搜尋、理解與下一步之間的斷點，做成可以被看見、被改善、被推進的客戶系統。',
      kicker: 'DiscoveryStack / Demand is a route, not a hope.',
      action: '先看你的需求路徑',
      proof: '先取得注意力，再把它推進成下一步。',
    }
  : {
      title: 'Your customers are already searching for what you do.',
      accent: 'The question is who they find.',
      description: 'We turn the break between search, understanding and a clear next step into a customer system you can see, improve and move forward.',
      kicker: 'DiscoveryStack / Demand is a route, not a hope.',
      action: 'Review your demand path',
      proof: 'Earn attention. Then give it a next move.',
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

const locale = computed(() => isZh.value ? 'zh-hant' : 'en')
</script>

<template>
  <article>
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero-constellation" aria-hidden="true">
        <svg viewBox="0 0 800 600" fill="none" preserveAspectRatio="xMidYMid slice">
          <path class="hero-constellation-path" d="M-40 470C120 380 184 494 312 370C440 246 536 324 670 164C724 100 778 100 842 42" />
          <path class="hero-constellation-path is-soft" d="M4 90C154 172 236 64 376 162C528 268 588 126 804 208" />
          <circle cx="312" cy="370" r="8" /><circle cx="670" cy="164" r="12" /><circle cx="376" cy="162" r="5" />
        </svg>
      </div>
      <p class="eyebrow">{{ copy.kicker }}</p>
      <h1 id="hero-title">{{ copy.title }} <em>{{ copy.accent }}</em></h1>
      <div class="hero-bottom">
        <p>{{ copy.description }}</p>
        <a class="signal-link" href="#fit-review">{{ copy.action }} <span aria-hidden="true">↘</span></a>
      </div>
      <div class="hero-orbit" aria-hidden="true"><span></span><span></span><span></span></div>
    </section>

    <section id="approach" class="approach-section" aria-labelledby="approach-title">
      <p class="eyebrow">01 / Journey intelligence</p>
      <h2 id="approach-title">{{ copy.proof }}</h2>
      <div class="approach-grid">
        <p>{{ isZh ? '網站不是裝飾品。它是人、搜尋引擎與答案引擎共同閱讀的一套證據與決策系統。' : 'A website is not decoration. It is a system of evidence and decisions read by people, search engines and answer engines.' }}</p>
        <ol>
          <li><span>01</span>{{ isZh ? '讓需求找到正確頁面。' : 'Let demand land on the right page.' }}</li>
          <li><span>02</span>{{ isZh ? '讓承諾被清楚理解。' : 'Make the promise easy to understand.' }}</li>
          <li><span>03</span>{{ isZh ? '讓下一步毫不含糊。' : 'Make the next step unmistakable.' }}</li>
        </ol>
      </div>
    </section>

    <JourneySequence :locale="locale" />

    <section id="qa" class="qa-section" aria-labelledby="qa-title">
      <p class="eyebrow">02 / AI QA assistant</p>
      <h2 id="qa-title">{{ isZh ? '有問題時，我們陪你把下一步說清楚。' : 'When a question appears, we can make the next step clearer.' }}</h2>
      <p class="qa-section-note">{{ isZh ? '右下角的 AI QA 會先給你一個可靠的起點；需要更多脈絡時，再和真人一起確認。' : 'The AI QA in the lower corner offers a grounded starting point, then brings a person into the conversation when more context is useful.' }}</p>
      <AiQaDock :locale="locale" />
    </section>
    <FitReviewForm :locale="locale" />
  </article>
</template>
