import sitemap from '@astrojs/sitemap'
import vue from '@astrojs/vue'
import { defineConfig } from 'astro/config'
import { unified } from '@astrojs/markdown-remark'
import rehypeHeadingAnchors from './src/lib/rehypeHeadingAnchors.mjs'

const site = process.env.PUBLIC_SITE_URL || 'https://www.example.com'

export default defineConfig({
  site,
  output: 'static',
  integrations: [vue(), sitemap()],
  markdown: {
    processor: unified({ smartypants: false, rehypePlugins: [rehypeHeadingAnchors] }),
  },
  build: {
    format: 'directory',
  },
})
