<script setup lang="ts">
const props = defineProps<{ locale: 'en' | 'zh-hant' }>()

const isZh = computed(() => props.locale === 'zh-hant')
const copy = computed(() => isZh.value
  ? {
      eyebrow: '01 / 需求在哪裡消失',
      title: '客戶不是突然消失。他們在四個地方離開。',
      intro: '找不到、看不懂、不相信、走不下去。修對斷點，比增加更多行銷更重要。',
      points: [
        ['沒被找到', '搜尋與 AI 回答裡沒有你。'],
        ['沒被理解', '訪客看見了，卻說不出你有何不同。'],
        ['沒被相信', '缺少足以支持決策的證據。'],
        ['沒有下一步', '內容、表單與真人跟進沒有接上。'],
      ],
    }
  : {
      eyebrow: '01 / WHERE DEMAND DISAPPEARS',
      title: 'Customers do not suddenly vanish. They leave at four breaks.',
      intro: 'Not found, not understood, not trusted, no next step. Fixing the break matters more than adding more marketing.',
      points: [
        ['Not found', 'You are absent from search and AI answers.'],
        ['Not understood', 'People see you but cannot explain the difference.'],
        ['Not believed', 'The proof is too weak to support a decision.'],
        ['No next step', 'Content, forms and human follow-up never connect.'],
      ],
    })
</script>

<template>
  <section class="hybrid-wave" aria-labelledby="hybrid-wave-title">
    <div class="shell hybrid-wave-shell">
      <header class="hybrid-wave-head">
        <p class="eyebrow">{{ copy.eyebrow }}</p>
        <h2 id="hybrid-wave-title">{{ copy.title }}</h2>
        <p>{{ copy.intro }}</p>
      </header>

      <div class="hybrid-wave-route">
        <svg viewBox="0 0 1200 250" role="img" :aria-label="isZh ? '四個獲客斷點組成的連續路徑' : 'A continuous route across four acquisition breaks'">
          <path class="hybrid-wave-base" pathLength="1" d="M18 118 C150 58 260 194 390 138 S625 54 754 142 S1010 206 1182 74" />
          <path class="hybrid-wave-glow" pathLength="1" d="M18 118 C150 58 260 194 390 138 S625 54 754 142 S1010 206 1182 74" />
          <path class="hybrid-wave-progress" pathLength="1" d="M18 118 C150 58 260 194 390 138 S625 54 754 142 S1010 206 1182 74" />
        </svg>

        <ol>
          <li v-for="(point, index) in copy.points" :key="point[0]">
            <i aria-hidden="true"></i>
            <span>0{{ index + 1 }}</span>
            <strong>{{ point[0] }}</strong>
            <p>{{ point[1] }}</p>
          </li>
        </ol>
      </div>
    </div>
  </section>
</template>
