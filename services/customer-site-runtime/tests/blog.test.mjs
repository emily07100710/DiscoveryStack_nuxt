import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createBlog, escapeBlogHtml, renderBlogBody } from '../lib/blog.mjs'

function fixture(start = '2026-10-01T00:00:00.000Z') {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  let now = new Date(start)
  const blog = createBlog(db, { now: () => now })
  return {
    db,
    blog,
    setNow(value) { now = new Date(value) },
  }
}

function article(overrides = {}) {
  return {
    title: '第一篇文章',
    slug: 'first-story',
    summary: '一段安全的摘要',
    body: '第一段\n\n第二段',
    cover: `/media/${'a'.repeat(64)}.webp`,
    draft: true,
    ...overrides,
  }
}

function assertError(error, status, code) {
  assert.equal(error?.status, status)
  assert.equal(error?.code, code)
  return true
}

test('drafts remain admin-only and the renderer escapes stored plain text', t => {
  const { db, blog } = fixture()
  t.after(() => db.close())

  const draft = blog.save(article({ body: '<script>alert("x")</script>\n\nTea & cake' }))
  assert.equal(draft.draft, true)
  assert.equal(draft.body, '<script>alert("x")</script>\n\nTea & cake')
  assert.equal(draft.renderedBody, '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>\n<p>Tea &amp; cake</p>')
  assert.deepEqual(blog.list(), [])
  assert.equal(blog.list({ admin: true }).length, 1)
  assert.equal(blog.get('first-story', { admin: true }).id, draft.id)
  assert.throws(
    () => blog.get('first-story'),
    error => assertError(error, 404, 'POST_NOT_FOUND'),
  )
  assert.equal(escapeBlogHtml(`<a title="x">O'Reilly & tea</a>`), '&lt;a title=&quot;x&quot;&gt;O&#39;Reilly &amp; tea&lt;/a&gt;')
  assert.equal(renderBlogBody('A\nB'), '<p>A<br>B</p>')
})

test('publishing locks the slug, while later draft edits do not change the live snapshot', t => {
  const { db, blog, setNow } = fixture()
  t.after(() => db.close())
  const draft = blog.save(article())

  setNow('2026-10-01T01:00:00.000Z')
  const published = blog.publish(draft.id, draft.version)
  assert.equal(published.status, 'published')
  assert.equal(published.slugLocked, true)
  assert.equal(published.version, 2)
  assert.equal(blog.get('first-story').id, draft.id)

  const edited = blog.save(article({
    id: draft.id,
    version: published.version,
    title: '更新後標題',
    body: '更新後內容',
    draft: true,
  }))
  assert.equal(edited.status, 'draft')
  assert.equal(edited.published, true)
  assert.equal(edited.draft, true)
  assert.equal(edited.version, 3)
  assert.equal(blog.get('first-story').title, '第一篇文章')
  assert.throws(
    () => blog.save(article({
      id: draft.id,
      version: edited.version,
      slug: 'changed-after-publish',
    })),
    error => assertError(error, 409, 'PUBLISHED_SLUG_LOCKED'),
  )

  const republishedDraft = blog.publish(draft.id, edited.version)
  assert.equal(republishedDraft.status, 'published')
  assert.equal(republishedDraft.draft, false)
  assert.equal(blog.get('first-story').title, '更新後標題')

  const unpublished = blog.unpublish(draft.id, republishedDraft.version)
  assert.equal(unpublished.status, 'draft')
  assert.equal(unpublished.slug, 'first-story')
  assert.equal(unpublished.slugLocked, true)
  assert.deepEqual(blog.list(), [])
  assert.equal(blog.get('first-story', { admin: true }).id, draft.id)
  const republished = blog.publish(draft.id, unpublished.version)
  assert.equal(republished.status, 'published')
  assert.equal(republished.slug, 'first-story')
})

test('optimistic versions reject stale writes and every successful state stores an immutable revision', t => {
  const { db, blog } = fixture()
  t.after(() => db.close())
  const created = blog.save(article())
  const saved = blog.save(article({
    id: created.id,
    version: created.version,
    title: '第二版',
    body: '第二版內容',
  }))
  assert.equal(saved.version, 2)
  assert.throws(
    () => blog.save(article({ id: created.id, version: 1, title: '過期寫入' })),
    error => assertError(error, 409, 'VERSION_CONFLICT'),
  )
  assert.throws(
    () => blog.publish(created.id, 1),
    error => assertError(error, 409, 'VERSION_CONFLICT'),
  )

  const revisions = blog.revisions(created.id)
  assert.deepEqual(revisions.map(row => row.version), [2, 1])
  assert.equal(revisions[0].title, '第二版')
  assert.equal(revisions[1].title, '第一篇文章')
  assert.equal(revisions[1].body, '第一段\n\n第二段')
})

test('restoring an old revision creates a draft, preserves the locked slug, and leaves the live snapshot intact', t => {
  const { db, blog } = fixture()
  t.after(() => db.close())
  const first = blog.save(article({ title: '原始標題', body: '原始內容' }))
  const second = blog.save(article({
    id: first.id,
    version: first.version,
    slug: 'second-slug',
    title: '第二版標題',
    body: '第二版內容',
  }))
  const published = blog.publish(first.id, second.version)
  const latest = blog.save(article({
    id: first.id,
    version: published.version,
    slug: 'second-slug',
    title: '目前標題',
    body: '目前內容',
    draft: false,
  }))
  const originalRevision = blog.revisions(first.id).find(row => row.version === 1)

  const restored = blog.restore(first.id, originalRevision.id, latest.version)
  assert.equal(restored.version, latest.version + 1)
  assert.equal(restored.title, '原始標題')
  assert.equal(restored.body, '原始內容')
  assert.equal(restored.slug, 'second-slug')
  assert.equal(restored.slugLocked, true)
  assert.equal(restored.status, 'draft')
  assert.equal(restored.published, true)
  assert.equal(blog.get('second-slug').title, '目前標題')
  assert.match(blog.revisions(first.id)[0].cause, /^restored:/u)
})

test('slug uniqueness and cover URL validation are enforced across drafts and published posts', t => {
  const { db, blog } = fixture()
  t.after(() => db.close())
  const first = blog.save(article())
  assert.ok(first.id)
  assert.throws(
    () => blog.save(article({ title: '另一篇', body: '另一篇內容' })),
    error => assertError(error, 409, 'SLUG_CONFLICT'),
  )
  assert.throws(
    () => blog.save(article({ slug: 'Bad Slug' })),
    error => assertError(error, 422, 'INVALID_SLUG'),
  )
  assert.throws(
    () => blog.save(article({ slug: 'unsafe-cover', cover: 'javascript:alert(1)' })),
    error => assertError(error, 422, 'INVALID_INPUT'),
  )
  const publishedAtCreation = blog.save(article({
    slug: 'already-live',
    title: '直接發布',
    cover: 'https://cdn.example.com/cover.webp',
    draft: false,
  }))
  assert.equal(publishedAtCreation.status, 'published')
  assert.equal(publishedAtCreation.slugLocked, true)
  assert.equal(blog.get('already-live').cover, 'https://cdn.example.com/cover.webp')
})
