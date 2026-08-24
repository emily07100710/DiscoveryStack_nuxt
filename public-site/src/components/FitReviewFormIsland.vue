<script setup lang="ts">
import { computed, defineProps, reactive, ref } from 'vue'
import { publicApiFetch } from '../lib/publicApi'

const props = defineProps<{ locale: 'en' | 'zh-hant' }>()
const isZh = computed(() => props.locale === 'zh-hant')
const formData = reactive({ name: '', email: '', company: '', website: '', intent: 'unsure', context: '', companyFax: '', privacy: false, followup: false })
const formStatus = ref('')

async function submitForm() {
  if (formData.companyFax) return
  if (!formData.name || !formData.email || !formData.company || !formData.privacy) {
    formStatus.value = isZh.value ? '請填寫姓名、Email、公司，並勾選資料處理同意。' : 'Please fill in name, email, company, and check privacy consent.'
    return
  }
  formStatus.value = isZh.value ? '正在送出…' : 'Sending…'
  try {
    await publicApiFetch('/api/leads', { body: { name: formData.name, email: formData.email, company: formData.company, website: formData.website, packageInterest: formData.intent, language: props.locale, message: formData.context, privacyConsent: formData.privacy, recontactConsent: formData.followup, companyFax: formData.companyFax } })
    formStatus.value = isZh.value ? '已收到。我們會帶著你的背景，由適合的部門接手。' : 'Received. The right department will follow up with your context.'
  } catch {
    formStatus.value = isZh.value ? '目前無法送出，請稍後再試。' : 'We could not send this right now. Please try again shortly.'
  }
}
</script>

<template>
  <form id="fitForm" novalidate @submit.prevent="submitForm">
    <div class="field-row"><div class="field"><label for="f-name">{{ isZh ? '你的姓名' : 'Your name' }}</label><input id="f-name" v-model="formData.name" name="name" type="text" autocomplete="name" required></div><div class="field"><label for="f-email">{{ isZh ? '工作 Email' : 'Work email' }}</label><input id="f-email" v-model="formData.email" name="email" type="email" autocomplete="email" required></div></div>
    <div class="field-row"><div class="field"><label for="f-company">{{ isZh ? '公司／品牌' : 'Company / Brand' }}</label><input id="f-company" v-model="formData.company" name="company" type="text" autocomplete="organization" required></div><div class="field"><label for="f-site">{{ isZh ? '網站（選填）' : 'Website (optional)' }}</label><input id="f-site" v-model="formData.website" name="website" type="url" inputmode="url" placeholder="https://"></div></div>
    <div class="field"><label for="f-intent">{{ isZh ? '你想先釐清什麼？' : 'What do you want to clarify first?' }}</label><select id="f-intent" v-model="formData.intent" name="intent"><option value="unsure">{{ isZh ? '還在釐清' : 'Still clarifying' }}</option><option value="discover">{{ isZh ? '讓需求找到我' : 'Let demand find me' }}</option><option value="clarify">{{ isZh ? '讓服務更容易被理解' : 'Make service easier to understand' }}</option><option value="grow">{{ isZh ? '把流量推進成訂單' : 'Turn traffic into orders' }}</option></select></div>
    <div class="field"><label for="f-context">{{ isZh ? '背景或目前卡住的問題（選填）' : 'Background or current stuck point (optional)' }}</label><textarea id="f-context" v-model="formData.context" name="context" rows="4"></textarea></div>
    <div class="honeypot" aria-hidden="true"><label for="f-fax">{{ isZh ? '公司傳真' : 'Company fax' }}</label><input id="f-fax" v-model="formData.companyFax" name="companyFax" type="text" tabindex="-1" autocomplete="off"></div>
    <div class="consents"><label class="consent"><input v-model="formData.privacy" type="checkbox" name="privacy" required><span>{{ isZh ? '我同意 DiscoveryStack 為回覆本次合作諮詢而處理這些資料。' : 'I agree that DiscoveryStack may process this data to respond to this inquiry.' }}</span></label><label class="consent"><input v-model="formData.followup" type="checkbox" name="followup"><span>{{ isZh ? '可以在這次諮詢以外，寄送後續相關資訊給我。' : 'You may send me relevant follow-up information beyond this inquiry.' }}</span></label></div>
    <div class="form-actions"><button class="cta" type="submit">{{ isZh ? '送出合作諮詢' : 'Submit inquiry' }} <span class="arrow" aria-hidden="true">↗</span></button><span class="form-status" id="formStatus" role="status" aria-live="polite">{{ formStatus }}</span></div>
  </form>
</template>
