<script setup lang="ts">
useHead({ meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })
</script>

<template>
  <main class="checkout" aria-labelledby="checkout-title">
    <section class="card">
      <p class="eyebrow">網站訂購流程</p>
      <h1 id="checkout-title">付款已取消</h1>
      <p>這次沒有扣款，你剛才填寫的回答仍會保留。</p>
      <NuxtLink class="button" to="/customer/managed-sites/start">回到網站訂購流程繼續填寫</NuxtLink>
    </section>
  </main>
</template>

<style scoped>
.checkout { display: grid; min-height: 100vh; place-items: center; padding: 1.25rem 1rem; background: #f7f5ef; color: #1b2236; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.card { display: grid; width: min(100%, 38rem); gap: 1.15rem; padding: 1.5rem; border: 1px solid #e7e2d8; border-radius: .9rem; background: white; box-shadow: 0 1rem 2.5rem rgba(45, 51, 72, .06); }
.eyebrow { margin: 0; color: #4d5dad; font: 700 .72rem/1.2 ui-monospace, SFMono-Regular, monospace; letter-spacing: .12em; }
h1 { margin: 0; font: 900 clamp(2rem, 10vw, 3.2rem)/1.02 Georgia, serif; }
p { margin: 0; color: #5e6575; line-height: 1.65; }
.button { display: inline-flex; min-height: 44px; align-items: center; justify-content: center; border-radius: .6rem; padding: .8rem 1.1rem; background: #4d5dad; color: white; font-weight: 800; text-align: center; text-decoration: none; }
@media (min-width: 48rem) { .checkout { padding: 3rem 2rem; } .card { padding: 2rem; } }
</style>
