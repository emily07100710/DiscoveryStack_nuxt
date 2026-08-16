/** Quiet Intelligence SEO: every public page has a self-canonical URL, alternate locale and schema matching visible content. */
type SeoContext = {
  baseUrl: string
  absolute: (path: string) => string
}

type SeoInput = {
  title: () => string
  description: () => string
  type?: 'website' | 'article'
  jsonLd?: (context: SeoContext) => Record<string, unknown> | Array<Record<string, unknown>>
}

function alternateFor(path: string, locale: 'en' | 'zh-hant') {
  const suffix = path.replace(/^\/(en|zh-hant)/, '') || ''
  return `/${locale}${suffix}`
}

export function usePageSeo(input: SeoInput) {
  const route = useRoute()
  const config = useRuntimeConfig()
  const baseUrl = String(config.public.siteUrl).replace(/\/$/, '')
  const isPlaceholder = baseUrl.includes('discoverystack.example')
  const canonicalPath = computed(() => route.path.replace(/\/$/, '') || '/')
  const absolute = (path: string) => `${baseUrl}${path}`

  useSeoMeta({
    title: input.title,
    description: input.description,
    ogTitle: input.title,
    ogDescription: input.description,
    ogType: input.type || 'website',
    twitterCard: 'summary_large_image',
    robots: () => isPlaceholder ? 'noindex,nofollow,noarchive' : 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1',
  })

  const pageHead = computed(() => {
    const enPath = alternateFor(canonicalPath.value, 'en')
    const zhPath = alternateFor(canonicalPath.value, 'zh-hant')
    const graph = input.jsonLd?.({ baseUrl, absolute })
    return {
      link: [
        { rel: 'canonical' as const, href: absolute(canonicalPath.value) },
        { rel: 'alternate' as const, hreflang: 'en', href: absolute(enPath) },
        { rel: 'alternate' as const, hreflang: 'zh-Hant', href: absolute(zhPath) },
        { rel: 'alternate' as const, hreflang: 'x-default', href: absolute(enPath) },
      ],
      script: graph ? [{ key: 'jsonld', type: 'application/ld+json' as const, innerHTML: JSON.stringify(graph).replace(/</g, '\\u003c') }] : [],
    }
  })
  useHead(pageHead)

  return { baseUrl, canonicalPath, absolute, isPlaceholder }
}
