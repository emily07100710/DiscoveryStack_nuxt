import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { startSiteRuntime } from '../server.mjs'
import { seedPreview } from '../lib/seed.mjs'

const preset = process.argv[2] || 'atelier'
const port = Number(process.env.PORT || 3002)
const folder = mkdtempSync(join(tmpdir(), 'ds-customer-preview-'))
const password = process.env.SITE_ADMIN_PASSWORD // no hardcoded or printed credentials
const instance = await startSiteRuntime({ config: { siteId: `preview-${preset}`, siteType: preset === 'alignment' ? 'booking_blog' : 'commerce', preset, mode: 'preview', brandName: preset === 'alignment' ? '日常練習室' : preset === 'bloom' ? '日子選品' : '光序・生活選品', tagline: '為你的品牌，留一個剛剛好的位置。', description: '獨立品牌網站示範，所有商品、服務與內容都是虛構測試資料。', hero: { eyebrow: 'YOUR BRAND, YOUR STORY', title: preset === 'alignment' ? '在日常裡，\n找回自己的節奏。' : '把喜歡的日常，\n放進生活裡。', description: '有溫度的設計，配上真正能操作的商品、預約與內容後台。' }, about: '我們相信，細節能讓日常變得不一樣。\n這是 DS 客戶網站的示範內容，不是實際品牌。', commerce: { paymentMode: 'manual', manualPaymentInstructions: '預覽不會扣款。示範訂單由後台人工確認。' }, contact: { email: 'hello@example.invalid' } }, origin: `http://127.0.0.1:${port}`, host: '127.0.0.1', port, databasePath: join(folder, 'site.sqlite'), uploadsPath: join(folder, 'uploads'), sessionSecret: randomBytes(32).toString('hex'), adminPassword: password, notifications: { enabled: false } })
seedPreview(instance)
console.log(`Local synthetic preview: http://127.0.0.1:${port} (${preset}). No real payment, email, or customer data.`)
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void instance.stop() })
