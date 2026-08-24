<!-- Every scene is present in SSR HTML; client scroll state only choreographs the visual presentation. -->
<script setup lang="ts">
import { defineProps, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{ locale: 'en' | 'zh-hant' }>()
const storyStage = ref<HTMLElement | null>(null)
const activeIndex = ref(0)
const progress = ref(0)
const pointerMotionEnabled = ref(false)

const panels = [
  { number: '01', coordinate: ['17%', '76%'], en: ['DISCOVERY', 'The work begins before the click.', 'Build intent-led pages that give a real question a real place to land.'], zh: ['被找到', '工作在點擊之前就開始。', '以意圖為起點建立頁面，讓真正的問題有一個真正能抵達的位置。'] },
  { number: '02', coordinate: ['39%', '42%'], en: ['CLARITY', 'If they cannot explain it, they cannot choose it.', 'Give people and answer engines a plain-language promise, visible method and enough evidence to judge fit.'], zh: ['被理解', '說不清楚，就很難被選擇。', '用白話說明承諾、方法與足夠證據，讓人與答案引擎能判斷是否適合。'] },
  { number: '03', coordinate: ['68%', '58%'], en: ['EVIDENCE', 'Make the decision easy to trust.', 'Structure the proof, terminology and responsible boundaries that let people judge fit without guesswork.'], zh: ['被相信', '讓決策更值得相信。', '整理證據、術語與負責任的邊界，讓人不必猜測就能判斷是否適合。'] },
  { number: '04', coordinate: ['84%', '20%'], en: ['MOMENTUM', 'Attention needs a human next move.', 'Connect useful content, a bounded AI answer and a human conversation into one clear handoff.'], zh: ['被推進', '注意力需要一個真人的下一步。', '把有用內容、有邊界的 AI 回答與真人對談接成一條清楚的交接路徑。'] },
]

const copyFor = (panel: typeof panels[number]) => props.locale === 'zh-hant' ? panel.zh : panel.en

const updatePointer = (event: PointerEvent) => {
  if (!pointerMotionEnabled.value) return
  const canvas = event.currentTarget as HTMLElement
  const rect = canvas.getBoundingClientRect()
  canvas.style.setProperty('--pointer-x', String(((event.clientX - rect.left) / rect.width - 0.5) * 2))
  canvas.style.setProperty('--pointer-y', String(((event.clientY - rect.top) / rect.height - 0.5) * 2))
}

const resetPointer = (event: PointerEvent) => {
  const canvas = event.currentTarget as HTMLElement
  canvas.style.setProperty('--pointer-x', '0')
  canvas.style.setProperty('--pointer-y', '0')
}

onMounted(() => {
  pointerMotionEnabled.value = window.matchMedia('(pointer: fine)').matches && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  let frame = 0
  const updateStory = () => {
    if (!storyStage.value) return
    const rect = storyStage.value.getBoundingClientRect()
    const travel = Math.max(storyStage.value.offsetHeight - window.innerHeight, 1)
    const nextProgress = Math.min(1, Math.max(0, -rect.top / travel))
    progress.value = nextProgress
    activeIndex.value = Math.min(panels.length - 1, Math.floor(nextProgress * panels.length))
  }
  const onScroll = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(updateStory)
  }
  updateStory()
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll)
  onBeforeUnmount(() => {
    cancelAnimationFrame(frame)
    window.removeEventListener('scroll', onScroll)
    window.removeEventListener('resize', onScroll)
  })
})
</script>

<template>
  <section ref="storyStage" class="journey-sequence journey-story" :style="{ '--story-progress': progress, '--scene-turn': progress * 1 }" :aria-label="locale === 'zh-hant' ? '需求推進路徑' : 'Demand momentum path'">
    <div class="journey-intro">
      <p class="eyebrow">{{ locale === 'zh-hant' ? '不是流量漏斗，是需求推進系統。' : 'Not a traffic funnel. A momentum system.' }}</p>
      <h2>{{ locale === 'zh-hant' ? '每一步都必須替下一步留下理由。' : 'Each move must earn the right to the next.' }}</h2>
    </div>
    <div class="story-sticky">
      <div class="story-canvas" aria-hidden="true" @pointermove="updatePointer" @pointerleave="resetPointer">
        <p class="story-index">{{ String(activeIndex + 1).padStart(2, '0') }} / {{ String(panels.length).padStart(2, '0') }}</p>
        <svg class="story-wire" viewBox="0 0 1000 620" preserveAspectRatio="none">
          <defs><linearGradient id="story-gradient" x1="0" x2="1"><stop stop-color="#4d5dad" /><stop offset="1" stop-color="#b9ca50" /></linearGradient></defs>
          <path class="story-wire-base" d="M-30 540C120 512 118 394 270 380C418 366 452 490 620 430C764 379 724 174 1030 90" />
          <path pathLength="1" class="story-wire-progress" d="M-30 540C120 512 118 394 270 380C418 366 452 490 620 430C764 379 724 174 1030 90" />
        </svg>
        <span v-for="(panel, index) in panels" :key="panel.number" class="story-node" :class="{ 'is-passed': index <= activeIndex, 'is-current': index === activeIndex }" :style="{ '--node-x': panel.coordinate[0], '--node-y': panel.coordinate[1] }"><i></i><b>{{ panel.number }}</b></span>
        <div class="story-core" :class="`is-scene-${activeIndex + 1}`"><span></span><span></span><span></span><span></span></div>
        <p class="story-ambient">{{ locale === 'zh-hant' ? '從被找到，到被選擇。' : 'From being found to being chosen.' }}</p>
      </div>
      <div class="story-copybook">
        <article v-for="(panel, index) in panels" :key="panel.number" class="story-step" :class="{ 'is-active': index === activeIndex }">
          <p class="journey-number">{{ panel.number }} / {{ copyFor(panel)[0] }}</p>
          <h3>{{ copyFor(panel)[1] }}</h3>
          <p>{{ copyFor(panel)[2] }}</p>
          <span class="story-step-rule" aria-hidden="true"></span>
        </article>
      </div>
    </div>
  </section>
</template>
