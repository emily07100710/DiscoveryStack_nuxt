import { defineCollection, defineContentConfig, z } from '@nuxt/content'

const publicPageSchema = z.object({
  title: z.string(),
  description: z.string(),
  locale: z.enum(['en', 'zh-hant']),
  translationKey: z.string(),
  route: z.string(),
  primaryIntent: z.string(),
  cluster: z.string(),
  contentRole: z.enum(['pillar', 'cluster', 'spoke', 'utility']),
  updatedAt: z.string(),
  authorStatus: z.enum(['editorial-team', 'named-author']),
  evidenceStatus: z.enum(['approved-knowledge', 'source-cited', 'editorial-opinion']),
  summaryAnswer: z.string(),
  relatedRoutes: z.array(z.string()).default([]),
  noindex: z.boolean().default(false),
})

export default defineContentConfig({
  collections: {
    pages: defineCollection({ type: 'page', source: 'pages/**', schema: publicPageSchema }),
  },
})
