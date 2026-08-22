<!-- The public form is intentionally modest: it captures only what a human needs to begin a qualified conversation. -->
<script setup lang="ts">
const props = defineProps<{ locale: 'en' | 'zh-hant' }>()
const isZh = computed(() => props.locale === 'zh-hant')
const status = ref<'idle' | 'submitting' | 'success' | 'error'>('idle')
const feedback = ref('')
const form = reactive({
  name: '', email: '', company: '', website: '', packageInterest: 'unsure' as 'discover' | 'clarify' | 'grow' | 'unsure',
  message: '', privacyConsent: false, recontactConsent: false, growthResearchConsent: false, companyFax: '',
})

const copy = computed(() => isZh.value ? {
  eyebrow: '03 / Fit review', title: '把現在卡住的地方交給我們看。',
  deck: '留下最少但足夠的背景。我們會以人類判斷回覆，不以自動化承諾取代策略。',
  name: '你的姓名', email: '工作 Email', company: '公司／品牌', website: '網站（選填）',
  focus: '你想先釐清什麼？', message: '背景或目前卡住的問題（選填）', privacy: '我同意 DiscoveryStack 為回覆本次合作諮詢而處理這些資料。',
  recontact: '可以在這次諮詢以外，寄送後續相關資訊給我。', growthResearch: '我同意 DiscoveryStack 使用我指定網站的公開內容與去識別化成效資料，進行 SEO／GEO 改寫研究與模型改善。不包含姓名、Email、電話或諮詢訊息，且可以隨時撤回。', submit: '送出合作諮詢', submitting: '正在送出…',
  success: '已收到。下一步會由真人依你的背景回覆。', error: '目前無法送出，請稍後再試或直接重新整理頁面。',
  options: { unsure: '還在釐清', discover: '讓需求找到我', clarify: '讓服務更容易被理解', grow: '找出下一步的摩擦' },
} : {
  eyebrow: '03 / Fit review', title: 'Show us where the path is breaking.',
  deck: 'Leave the minimum useful context. A human will respond; automation will not substitute for commercial judgment.',
  name: 'Your name', email: 'Work email', company: 'Company / brand', website: 'Website (optional)',
  focus: 'What needs attention first?', message: 'Context or the problem you are seeing (optional)', privacy: 'I agree that DiscoveryStack may process these details to respond to this fit-review request.',
  recontact: 'You may send relevant follow-up information beyond this enquiry.', growthResearch: 'I agree that DiscoveryStack may use public content from the website I provide and de-identified performance measurements for SEO/GEO rewrite research and model improvement. This excludes my name, email, phone number and enquiry message, and I may withdraw consent at any time.', submit: 'Send fit-review request', submitting: 'Sending…',
  success: 'Received. A human will respond from the context you shared.', error: 'We could not submit this right now. Please try again shortly or refresh the page.',
  options: { unsure: 'I am still mapping it', discover: 'Help demand find us', clarify: 'Make the service easier to understand', grow: 'Find the next-step friction' },
})

async function submit() {
  status.value = 'submitting'
  feedback.value = ''
  try {
    await $fetch('/api/leads', { method: 'POST', body: { ...form, language: props.locale } })
    status.value = 'success'
    feedback.value = copy.value.success
  } catch {
    status.value = 'error'
    feedback.value = copy.value.error
  }
}
</script>

<template>
  <section id="fit-review" class="fit-review" aria-labelledby="fit-review-title">
    <div class="fit-review-intro">
      <p class="eyebrow">{{ copy.eyebrow }}</p>
      <h2 id="fit-review-title">{{ copy.title }}</h2>
      <p>{{ copy.deck }}</p>
    </div>
    <form class="fit-review-form" @submit.prevent="submit">
      <div class="fit-field-grid">
        <label><span>{{ copy.name }}</span><input v-model="form.name" name="name" autocomplete="name" required minlength="2" maxlength="120"></label>
        <label><span>{{ copy.email }}</span><input v-model="form.email" name="email" type="email" autocomplete="email" required maxlength="320"></label>
        <label><span>{{ copy.company }}</span><input v-model="form.company" name="company" autocomplete="organization" required minlength="2" maxlength="160"></label>
        <label><span>{{ copy.website }}</span><input v-model="form.website" name="website" type="url" inputmode="url" autocomplete="url" maxlength="2048"></label>
      </div>
      <label class="fit-select"><span>{{ copy.focus }}</span><select v-model="form.packageInterest" name="packageInterest"><option value="unsure">{{ copy.options.unsure }}</option><option value="discover">{{ copy.options.discover }}</option><option value="clarify">{{ copy.options.clarify }}</option><option value="grow">{{ copy.options.grow }}</option></select></label>
      <label><span>{{ copy.message }}</span><textarea v-model="form.message" name="message" rows="4" maxlength="2000"></textarea></label>
      <label class="bot-field" aria-hidden="true"><span>Company fax</span><input v-model="form.companyFax" name="companyFax" tabindex="-1" autocomplete="off"></label>
      <div class="fit-consents">
        <label><input v-model="form.privacyConsent" type="checkbox" required><span>{{ copy.privacy }}</span></label>
        <label><input v-model="form.recontactConsent" type="checkbox"><span>{{ copy.recontact }}</span></label>
        <label><input v-model="form.growthResearchConsent" type="checkbox"><span>{{ copy.growthResearch }}</span></label>
      </div>
      <div class="fit-actions">
        <button type="submit" :disabled="status === 'submitting'">{{ status === 'submitting' ? copy.submitting : copy.submit }} <span aria-hidden="true">↗</span></button>
        <p class="fit-feedback" :class="`is-${status}`" aria-live="polite">{{ feedback }}</p>
      </div>
    </form>
  </section>
</template>
