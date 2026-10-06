import { fail } from './errors.mjs'

/** Synthetic fixtures only: never called automatically by the production server. */
export function seedPreview(runtime) {
  if (runtime.config.mode !== 'preview') fail(409, '正式網站不可載入示範商品與預約資料')
  if (!runtime.commerce.listProducts({ admin: true }).length && runtime.config.siteType === 'commerce') {
    for (const [name, slug, category, price, description] of [
      ['日常的柔軟輪廓', 'soft-everyday', '日常選品', 168000, '示範商品，展示品牌敘事、規格與購買流程。正式交付請換成自己的商品。'],
      ['留白・經典系列', 'quiet-classic', '經典系列', 248000, '以舒服的比例與細節，陪伴生活裡每個值得珍惜的片刻。'],
      ['一份溫柔的禮物', 'gentle-gift', '禮物提案', 98000, '示範禮物系列。照片、售價、庫存與政策都由商家自行確認。'],
    ]) runtime.commerce.saveProduct({ name, slug, category, description, priceMinor: price, stock: 12, active: true, images: [], variants: [] })
  }
  if (!runtime.booking.listServices({ admin: true }).length && runtime.config.siteType === 'booking_blog') {
    const service = runtime.booking.saveService({ name: '一對一練習', description: '依照自己的節奏，找回舒服的身體與日常。這是示範服務。', durationMinutes: 60, creditCost: 1, active: true })
    for (let day = 2; day < 9; day++) {
      const start = new Date(); start.setDate(start.getDate() + day); start.setHours(10, 0, 0, 0)
      runtime.booking.saveSlot({ serviceId: service.id, startsAt: start.toISOString(), resourceId: 'preview-studio', active: true })
    }
  }
  if (!runtime.blog.list({ admin: true }).length) {
    for (const [title, slug, summary, body] of [
      ['讓生活，留一點空白', 'room-for-life', '從一個小小的選擇開始，重新看見自己的生活。', '這是一篇示範文章，讓你預覽內容網站的排版與閱讀體驗。\n\n正式上線前，請在品牌後台換成自己的照片、故事與正確資訊。'],
      ['慢慢開始，也是一種前進', 'start-slow', '把注意力放回當下，以自己的節奏前進。', '文章後台支援草稿、發布與版本還原。\n\n儲存草稿不會直接改動訪客正在閱讀的版本。'],
    ]) { const post = runtime.blog.save({ title, slug, summary, body }); runtime.blog.publish(post.id, post.version) }
  }
}
