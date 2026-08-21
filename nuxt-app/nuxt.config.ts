const faviconLink = [{ rel: 'icon' as const, type: 'image/svg+xml', href: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%226%22 fill=%22%234d5dad%22/%3E%3Cpath d=%22M8 23V16h4v7H8Zm6 0V10h4v13h-4Zm6 0V6h4v17h-4Z%22 fill=%22%23f5f2eb%22/%3E%3C/svg%3E' }]
const isManagedPreviewSsr = process.env.DISCOVERYSTACK_MANAGED_PREVIEW_SSR === '1'
const isFastPreviewGenerate = process.env.DISCOVERYSTACK_FAST_PREVIEW_GENERATE === '1'
// The managed production container serves the public routes through Nitro SSR.
// This keeps SEO metadata while avoiding build-time crawling in the container.
const isServerOnlyProductionBuild = process.env.DISCOVERYSTACK_SKIP_PRERENDER === '1'
const shouldPrerenderPublicRoutes = !(isManagedPreviewSsr || isServerOnlyProductionBuild)
const publicPrerenderRoutes = [
  '/robots.txt', '/llms.txt', '/sitemap.xml',
  '/ml-lab-preview',
  '/en', '/zh-hant',
  '/en/services/seo-geo-growth-system', '/zh-hant/services/seo-geo-growth-system',
  '/en/methodology/journey-intelligence', '/zh-hant/methodology/journey-intelligence',
  '/en/methodology/bounded-ai-assistant', '/zh-hant/methodology/bounded-ai-assistant',
  '/en/glossary/seo', '/zh-hant/glossary/seo',
  '/en/glossary/geo', '/zh-hant/glossary/geo',
  '/en/glossary/journey-intelligence', '/zh-hant/glossary/journey-intelligence',
  '/en/publications/what-a-public-website-can-tell-you', '/zh-hant/publications/what-a-public-website-can-tell-you',
]

export default defineNuxtConfig({
  compatibilityDate: '2026-08-16',
  buildDir: process.env.NUXT_BUILD_DIR || '.nuxt',
  devtools: { enabled: true },
  modules: ['@nuxt/content', '@nuxtjs/i18n', '@nuxt/image'],
  css: ['~/assets/css/redesign.css', '~/assets/css/immersive.css', '~/assets/css/hybrid-refresh.css'],
  app: {
    head: {
      htmlAttrs: { lang: 'en-US', dir: 'ltr' },
      titleTemplate: '%s — DiscoveryStack',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'theme-color', content: '#4d5dad' },
        { name: 'format-detection', content: 'telephone=no' },
      ],
      link: [
        ...faviconLink,
        { rel: 'preconnect' as const, href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect' as const, href: 'https://fonts.gstatic.com', crossorigin: 'anonymous' },
        { rel: 'stylesheet' as const, href: 'https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Noto+Sans+TC:wght@400;500;700&family=Noto+Serif+TC:wght@600;700;900&display=swap' },
      ],
    },
  },
  nitro: {
    prerender: {
      // Nuxt always invokes the Nitro prerender runner after a production build.
      // With an empty route set and crawlLinks disabled it returns immediately,
      // so the deployed Node server is fully SSR rather than a static export.
      crawlLinks: false,
      ignore: [],
      routes: shouldPrerenderPublicRoutes ? publicPrerenderRoutes : [],
    },
  },
  routeRules: {
    '/': { redirect: { to: '/en', statusCode: 302 } },
    '/audit-lab': { headers: { 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Cache-Control': 'private, no-store, max-age=0' } },
    '/audit-lab/**': { headers: { 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Cache-Control': 'private, no-store, max-age=0' } },
    '/ml-lab-preview': { headers: { 'X-Robots-Tag': 'noindex, nofollow, noarchive' } },
    '/en/audit-lab': { headers: { 'X-Robots-Tag': 'noindex, nofollow, noarchive' } },
    '/zh-hant/audit-lab': { headers: { 'X-Robots-Tag': 'noindex, nofollow, noarchive' } },
    '/api/**': { headers: { 'X-Robots-Tag': 'noindex, nofollow, noarchive' } },
    ...(shouldPrerenderPublicRoutes ? {
      '/en/**': { prerender: true },
      '/zh-hant/**': { prerender: true },
    } : {}),
  },
  i18n: {
    strategy: 'prefix',
    defaultLocale: 'en',
    detectBrowserLanguage: false,
    baseUrl: process.env.NUXT_PUBLIC_DISCOVERY_STACK_SITE_URL || process.env.NUXT_PUBLIC_SITE_URL || 'https://discoverystack.example',
    locales: [
      { code: 'en', language: 'en-US', file: 'en.json', name: 'English' },
      { code: 'zh-hant', language: 'zh-Hant', file: 'zh-hant.json', name: '繁體中文' },
    ],
  },
  runtimeConfig: {
    oauthServerUrl: process.env.OAUTH_SERVER_URL || '',
    oauthPortalUrl: process.env.VITE_OAUTH_PORTAL_URL || '',
    oauthAppId: process.env.VITE_APP_ID || '',
    discoveryStackOauthAllowedOrigin: process.env.NUXT_DISCOVERY_STACK_OAUTH_ALLOWED_ORIGIN || process.env.OAUTH_ALLOWED_ORIGIN || '',
    sessionSecret: process.env.JWT_SECRET || '',
    ownerOpenId: process.env.OWNER_OPEN_ID || '',
    firecrawlApiKey: process.env.FIRECRAWL_API_KEY || '',
    firecrawlApiBaseUrl: process.env.FIRECRAWL_API_BASE_URL || 'https://api.firecrawl.dev/v2',
    huggingFaceApiToken: process.env.HUGGINGFACE_API_TOKEN || '',
    huggingFaceNamespace: process.env.HUGGINGFACE_NAMESPACE || '',
    huggingFaceBaseModelId: process.env.HUGGINGFACE_BASE_MODEL_ID || 'distilbert/distilbert-base-multilingual-cased',
    huggingFaceJobFlavor: process.env.HUGGINGFACE_JOB_FLAVOR || 'a10g-small',
    public: {
      discoveryStackSiteUrl: process.env.NUXT_PUBLIC_DISCOVERY_STACK_SITE_URL || process.env.NUXT_PUBLIC_SITE_URL || 'https://discoverystack.example',
    },
  },
  // `pnpm typecheck` remains the authoritative check. The managed preview
  // starts a production SSR build under a short process-start budget, so it
  // skips the duplicate Vite checker only in that isolated preview branch.
  typescript: { typeCheck: !(isManagedPreviewSsr || isFastPreviewGenerate) },
  // Nuxt 4.5 emits `vue-router/volar/sfc-route-blocks` for typed pages. The
  // installed Vue Router 4.x package no longer exports that Volar-only path,
  // while runtime routing remains unaffected. Keep type checking enabled and
  // disable only the optional generated typed-route declarations.
  experimental: { typedPages: false },
})
