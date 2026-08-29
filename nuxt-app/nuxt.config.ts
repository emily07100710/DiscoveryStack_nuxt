const faviconLink = [{ rel: 'icon' as const, type: 'image/svg+xml', href: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%226%22 fill=%22%234d5dad%22/%3E%3Cpath d=%22M8 23V16h4v7H8Zm6 0V10h4v13h-4Zm6 0V6h4v17h-4Z%22 fill=%22%23f5f2eb%22/%3E%3C/svg%3E' }]
const modelImprovementCron = process.env.MODEL_IMPROVEMENT_CRON || '0 18 * * *'
const geoModelOpsCron = process.env.GEO_MODELOPS_CRON || '*/15 * * * *'
const managedSiteEditorCron = process.env.MANAGED_SITE_EDITOR_CRON || '*/5 * * * *'
const systemFactoryCron = process.env.SYSTEM_FACTORY_CRON || '*/5 * * * *'

export default defineNuxtConfig({
  compatibilityDate: '2026-08-16',
  buildDir: process.env.NUXT_BUILD_DIR || '.nuxt',
  devtools: { enabled: true },
  modules: [],
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
    experimental: { tasks: true },
    scheduledTasks: { [modelImprovementCron]: ['model-improvement:collect'], [geoModelOpsCron]: ['content-operations:geo-modelops-tick'], [managedSiteEditorCron]: ['managed-sites:editor-tick'], [systemFactoryCron]: ['system-factory:provisioning-tick'] },
  },
  routeRules: {
    '/': { redirect: { to: '/audit-lab', statusCode: 302 } },
    '/audit-lab': { headers: { 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Cache-Control': 'private, no-store, max-age=0' } },
    '/audit-lab/**': { headers: { 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Cache-Control': 'private, no-store, max-age=0' } },
    '/ml-lab-preview': { headers: { 'X-Robots-Tag': 'noindex, nofollow, noarchive' } },
    '/leads': { headers: { 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Cache-Control': 'private, no-store, max-age=0' } },
    '/training-pipeline': { headers: { 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Cache-Control': 'private, no-store, max-age=0' } },
    '/customer/managed-sites/editor': { headers: { 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Cache-Control': 'private, no-store, max-age=0' } },
    '/en/audit-lab': { headers: { 'X-Robots-Tag': 'noindex, nofollow, noarchive' } },
    '/zh-hant/audit-lab': { headers: { 'X-Robots-Tag': 'noindex, nofollow, noarchive' } },
    '/api/**': { headers: { 'X-Robots-Tag': 'noindex, nofollow, noarchive' } },
  },
  runtimeConfig: {
    discoveryStackPublicSiteOrigin: process.env.DISCOVERYSTACK_PUBLIC_SITE_ORIGIN || '',
    discoveryStackPrivateOrigin: process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN || '',
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
    // Server-only content/AutoGEO provider configuration. Values are intentionally not
    // exposed under `public`, and the adapter validates the endpoint before use.
    contentDraftProvider: process.env.NUXT_CONTENT_DRAFT_PROVIDER || '',
    autoGeoGeminiApiKey: process.env.NUXT_AUTOGEO_GEMINI_API_KEY || '',
    autoGeoBailianApiKey: process.env.NUXT_AUTOGEO_BAILIAN_API_KEY || '',
    autoGeoBailianEndpoint: process.env.NUXT_AUTOGEO_BAILIAN_ENDPOINT || '',
    autoGeoBailianModel: process.env.NUXT_AUTOGEO_BAILIAN_MODEL || 'qwen-plus',
    modelImprovementAutoTrain: process.env.NUXT_MODEL_IMPROVEMENT_AUTO_TRAIN || 'false',
    pageEditorPreviewSecret: process.env.NUXT_PAGE_EDITOR_PREVIEW_SECRET || '',
    public: {
      discoveryStackPublicSiteOrigin: process.env.DISCOVERYSTACK_PUBLIC_SITE_ORIGIN || 'https://www.example.com',
    },
  },
  // `pnpm typecheck` remains authoritative; CI/build can opt out of duplicate checker work only after it passes.
  typescript: { typeCheck: process.env.NUXT_BUILD_TYPECHECK !== 'false' },
  // Nuxt 4.5 emits `vue-router/volar/sfc-route-blocks` for typed pages. The
  // installed Vue Router 4.x package no longer exports that Volar-only path,
  // while runtime routing remains unaffected. Keep type checking enabled and
  // disable only the optional generated typed-route declarations.
  experimental: { typedPages: false },
})
