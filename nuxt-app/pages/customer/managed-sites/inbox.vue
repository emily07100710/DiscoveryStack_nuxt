<script setup lang="ts">
useHead({ title: '網站詢問｜DiscoveryStack', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })
type Message = { id: number; name: string; email: string; phone: string | null; message: string; status: string; deliveryNote: string; createdAt: string }
type Inbox = { messages: Message[]; nextBeforeId: number | null }
const fetchInbox = $fetch as unknown as <T>(path: string) => Promise<T>
const messages = ref<Message[]>([])
const nextBeforeId = ref<number | null>(null)
const loading = ref(false)
const errorMessage = ref('')
const reaccess = ref(false)
const displayDate = (value: string) => new Intl.DateTimeFormat('zh-Hant-TW', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
async function load(append = false) {
  if (loading.value) return
  loading.value = true; errorMessage.value = ''; reaccess.value = false
  if (!append) { messages.value = []; nextBeforeId.value = null }
  try {
    const result = await fetchInbox<Inbox>(`/api/managed-sites/customer/contact-messages${append && nextBeforeId.value ? `?beforeId=${nextBeforeId.value}` : ''}`)
    messages.value = append ? [...messages.value, ...result.messages] : result.messages
    nextBeforeId.value = result.nextBeforeId
  } catch (error: any) {
    const status = error?.statusCode || error?.status || error?.response?.status
    if (status === 401 || status === 403) { messages.value = []; nextBeforeId.value = null }
    reaccess.value = status === 401
    errorMessage.value = status === 401 ? '登入已到期，請重新登入。' : status === 403 ? '只有網站管理員可以查看訪客聯絡資料，請向專案擁有人確認角色權限。' : '目前無法載入網站詢問，請稍後再試。'
  } finally { loading.value = false }
}
onMounted(() => load())
</script>

<template>
  <main class="inbox">
    <header><div><p class="eyebrow">CUSTOMER PORTAL / INBOX</p><h1>網站詢問</h1><p>只顯示你所屬網站的聯絡表單訊息。通知信寄送失敗時，訊息仍可在這裡查看。</p></div><nav><NuxtLink to="/customer/managed-sites">回到網站管理</NuxtLink><button type="button" :disabled="loading" @click="load()">重新整理</button></nav></header>
    <p class="privacy">訪客聯絡資料僅供回覆本次詢問。這個頁面不會自動回信或將訪客加入行銷名單。</p>
    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }} <NuxtLink v-if="reaccess" to="/managed-site-access">重新登入</NuxtLink></p>
    <p v-if="loading" role="status">正在載入…</p>
    <p v-if="!loading && !errorMessage && !messages.length" class="empty">目前尚未收到網站詢問。</p>
    <section aria-label="聯絡表單訊息">
      <article v-for="item in messages" :key="item.id">
        <div class="message-heading"><h2>{{ item.name }}</h2><time :datetime="item.createdAt">{{ displayDate(item.createdAt) }}</time></div>
        <p class="contact">Email：{{ item.email }}<span v-if="item.phone">　電話：{{ item.phone }}</span></p>
        <p class="body">{{ item.message }}</p>
        <p class="delivery" :class="{ pending: item.status !== 'forwarded' }">{{ item.deliveryNote }}</p>
      </article>
    </section>
    <button v-if="nextBeforeId" type="button" :disabled="loading" @click="load(true)">載入較早的訊息</button>
  </main>
</template>

<style scoped>
.inbox{max-width:1040px;margin:0 auto;padding:clamp(1.2rem,4vw,3rem);color:#192a40}header,.message-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem}h1{font-size:clamp(2rem,4vw,3rem);margin:.4rem 0}header p,.privacy,.contact,time{color:#5e6c7d;font-size:.85rem;line-height:1.7}.eyebrow{font-size:.7rem;letter-spacing:.12em;font-weight:800}nav{display:flex;gap:.7rem;flex-wrap:wrap}nav a,button{padding:.7rem 1rem;border:1px solid #ccd5df;border-radius:.6rem;background:#fff;color:#224a73;text-decoration:none;font:inherit;cursor:pointer}button:disabled{opacity:.6;cursor:wait}article{border:1px solid #dbe2eb;border-radius:.8rem;padding:1.3rem;margin:1rem 0;background:#fff}h2{font-size:1.1rem;margin:0}.body{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.8}.delivery{color:#267143;font-size:.8rem}.delivery.pending{color:#8c571a}.error{background:#fff0ee;color:#9a3429;padding:1rem;border-radius:.6rem}.empty{padding:2rem;text-align:center;color:#5e6c7d}@media(max-width:680px){header,.message-heading{display:block}nav{margin:1rem 0}}
</style>
