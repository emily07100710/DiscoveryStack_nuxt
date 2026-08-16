<!-- Quiet Intelligence: calm editorial document rhythm, direct answers before supporting detail. -->
<script setup lang="ts">
const props = defineProps<{ page: any }>()
const isZh = computed(() => props.page.locale === 'zh-hant')

const schemaType = computed(() => {
  if (props.page.contentRole === 'pillar') return 'Service'
  if (String(props.page.route).includes('/glossary/')) return 'DefinedTerm'
  return 'Article'
})

const { baseUrl, absolute } = usePageSeo({
  title: () => props.page.title,
  description: () => props.page.description,
  type: 'article',
  jsonLd: ({ baseUrl, absolute }) => ({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': `${absolute(props.page.route)}#webpage`,
        url: absolute(props.page.route),
        name: props.page.title,
        description: props.page.description,
        isPartOf: { '@id': `${baseUrl}/#website` },
        about: { '@id': `${baseUrl}/#organization` },
        inLanguage: isZh.value ? 'zh-Hant' : 'en',
      },
      {
        '@type': schemaType.value,
        '@id': `${absolute(props.page.route)}#primary`,
        name: props.page.title,
        headline: props.page.title,
        description: props.page.description,
        url: absolute(props.page.route),
        dateModified: String(props.page.updatedAt),
        inLanguage: isZh.value ? 'zh-Hant' : 'en',
        mainEntityOfPage: { '@id': `${absolute(props.page.route)}#webpage` },
        publisher: { '@id': `${baseUrl}/#organization` },
        ...(schemaType.value === 'Service' ? { provider: { '@id': `${baseUrl}/#organization` } } : {}),
        ...(schemaType.value === 'DefinedTerm' ? { termCode: props.page.translationKey, inDefinedTermSet: `${baseUrl}/glossary` } : {}),
      },
    ],
  }),
})
</script>

<template>
  <article class="content-page">
    <header class="content-hero">
      <p class="eyebrow">{{ page.contentRole }} / {{ page.cluster }}</p>
      <h1>{{ page.title }}</h1>
      <p class="content-deck">{{ page.description }}</p>
      <aside class="answer-block" :aria-label="isZh ? '摘要答案' : 'Summary answer'">
        <span>{{ isZh ? '摘要答案' : 'Answer first' }}</span>
        <p>{{ page.summaryAnswer }}</p>
      </aside>
      <p class="content-meta">{{ isZh ? '最後更新' : 'Last updated' }} · {{ page.updatedAt }} · {{ page.evidenceStatus }}</p>
    </header>
    <div class="content-body"><ContentRenderer :value="page" /></div>
    <nav v-if="page.relatedRoutes?.length" class="related-links" :aria-label="isZh ? '相關閱讀' : 'Related reading'">
      <p class="eyebrow">{{ isZh ? '延伸閱讀' : 'Continue the path' }}</p>
      <NuxtLink v-for="item in page.relatedRoutes" :key="item" :to="item">{{ item.replace(/^\/(en|zh-hant)\//, '').replaceAll('-', ' ') }} <span aria-hidden="true">↗</span></NuxtLink>
    </nav>
  </article>
</template>
