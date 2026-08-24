import { glob } from 'astro/loaders'
import { defineCollection, z } from 'astro:content'

const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    locale: z.enum(['en', 'zh-hant']),
    translationKey: z.string(),
    route: z.string(),
    primaryIntent: z.string(),
    cluster: z.string(),
    contentRole: z.string(),
    updatedAt: z.union([z.string(), z.date()]).transform(value => value instanceof Date ? value.toISOString().slice(0, 10) : value),
    authorStatus: z.string(),
    evidenceStatus: z.string(),
    summaryAnswer: z.string(),
    relatedRoutes: z.array(z.string()).optional(),
    noindex: z.boolean().default(false),
  }),
})

export const collections = { pages }
