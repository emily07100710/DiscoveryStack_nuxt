<script setup lang="ts">
import type { ArticleDocument, ArticleMedia } from './types'
import { safeArticleUrl } from './types'
const props = defineProps<{ document: ArticleDocument; media: ArticleMedia[]; imageUrls?: Record<string, string>; compact?: boolean }>()
const imageUrl = (id: string | null) => id ? props.imageUrls?.[id] || safeArticleUrl(props.media.find(item => item.id === id)?.url) : null
const textStyle = (color: string | undefined) => /^#[0-9a-f]{6}$/i.test(color || '') ? { color } : undefined
</script>
<template>
  <article class="article-preview" :class="{ compact }" aria-label="文章預覽">
    <p class="category">{{ document.category || '品牌文章' }}</p>
    <h1>{{ document.title || '尚未填寫標題' }}</h1>
    <p v-if="document.summary" class="summary">{{ document.summary }}</p>
    <img v-if="imageUrl(document.coverMediaId)" class="cover" :src="imageUrl(document.coverMediaId)!" alt="文章封面" loading="lazy" referrerpolicy="no-referrer">
    <aside v-if="document.takeaways.length" class="takeaways"><h2>文章重點</h2><ul><li v-for="(point, index) in document.takeaways" :key="index">{{ point }}</li></ul></aside>
    <template v-for="block in document.blocks" :key="block.id">
      <figure v-if="block.type === 'image'" :class="{ wide: block.layout === 'wide' }">
        <img v-if="imageUrl(block.mediaId)" :src="imageUrl(block.mediaId)!" :alt="block.alt" loading="lazy" referrerpolicy="no-referrer">
        <div v-else class="missing-image">圖片目前無法預覽；請更新進度後再確認。</div>
        <figcaption v-if="block.caption">{{ block.caption }}</figcaption>
      </figure>
      <component :is="block.type === 'heading' ? 'h2' : block.type === 'quote' ? 'blockquote' : 'p'" v-else>
        <span v-for="(run, index) in block.runs" :key="index" :class="{ bold: run.bold, italic: run.italic }" :style="textStyle(run.color)">{{ run.text }}</span>
      </component>
    </template>
  </article>
</template>
<style scoped>
.article-preview{max-width:720px;margin:auto;color:#23322e;overflow-wrap:anywhere}.category{font-size:13px;letter-spacing:.14em;color:#5d7b6e;font-weight:700}.article-preview h1{font-size:clamp(27px,4vw,40px);line-height:1.35;letter-spacing:-.025em;margin:18px 0}.summary{font-size:18px;line-height:1.85;color:#67726b}.cover{width:100%;max-height:460px;object-fit:cover;border-radius:16px;margin:14px 0 28px}.article-preview h2{font-size:23px;line-height:1.5;margin:32px 0 16px}.article-preview p,.article-preview blockquote{font-size:17px;line-height:1.95;white-space:pre-wrap;margin:20px 0}.article-preview blockquote{border-left:3px solid #9fb6a8;margin-left:0;padding:8px 22px;color:#5a6d62;background:#f3f6f3;border-radius:0 10px 10px 0}.bold{font-weight:700}.italic{font-style:italic}.takeaways{padding:18px 22px;background:#f2f5ef;border-radius:14px}.takeaways h2{font-size:16px;margin:0 0 10px}.takeaways ul{padding-left:20px;margin:0;line-height:1.8}figure{margin:28px 0}figure img{display:block;max-width:100%;max-height:660px;margin:auto;border-radius:12px;object-fit:contain}.wide img{width:100%}figcaption{font-size:13px;text-align:center;color:#748077;margin-top:10px;line-height:1.6}.missing-image{padding:28px;background:#f7f0ea;color:#7e604c;border-radius:12px}.compact{max-width:390px;border:1px solid #dce2da;border-radius:24px;padding:25px 20px;box-shadow:0 12px 35px #263a2510}.compact h1{font-size:28px}.compact p{font-size:16px}@media(max-width:600px){.article-preview h1{font-size:28px}.article-preview p,.article-preview blockquote{font-size:16px}.compact{padding:18px 14px}}
</style>
