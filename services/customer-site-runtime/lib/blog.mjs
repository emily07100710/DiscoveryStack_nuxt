import { fail, id, integer, iso, text } from './errors.mjs'
import { mediaUrl } from './config.mjs'
import { transaction } from './store.mjs'

function normalizeSlug(value) {
  const slug = text(value, '文章網址', 120).toLowerCase()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
    fail(422, '文章網址只能使用小寫英數字與單一連字號', 'INVALID_SLUG')
  }
  return slug
}

function normalizeCover(value) {
  if (value === undefined || value === null || value === '') return null
  return mediaUrl(value)
}

function boolean(value, label) {
  if (typeof value !== 'boolean') fail(422, `${label}格式不正確`)
  return value
}

export function escapeBlogHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function renderBlogBody(value) {
  const normalized = String(value).replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim()
  if (!normalized) return ''
  return normalized
    .split(/\n{2,}/u)
    .map(paragraph => `<p>${escapeBlogHtml(paragraph).replaceAll('\n', '<br>')}</p>`)
    .join('\n')
}

function draftView(row) {
  const published = Boolean(row.is_published)
  const hasDraft = Boolean(row.draft_pending)
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    summary: row.summary,
    excerpt: row.summary,
    body: row.body,
    renderedBody: renderBlogBody(row.body),
    cover: row.cover,
    image: row.cover,
    draft: hasDraft,
    status: hasDraft ? 'draft' : (published ? 'published' : 'draft'),
    published,
    version: row.version,
    slugLocked: Boolean(row.slug_locked),
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function publicView(row) {
  return {
    id: row.id,
    title: row.published_title,
    slug: row.published_slug,
    summary: row.published_summary,
    excerpt: row.published_summary,
    body: row.published_body,
    renderedBody: renderBlogBody(row.published_body),
    cover: row.published_cover,
    image: row.published_cover,
    draft: false,
    status: 'published',
    published: true,
    version: row.published_version,
    slugLocked: true,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.published_at,
  }
}

function revisionView(row) {
  return {
    id: row.id,
    postId: row.post_id,
    version: row.version,
    title: row.title,
    slug: row.slug,
    summary: row.summary,
    excerpt: row.summary,
    body: row.body,
    renderedBody: renderBlogBody(row.body),
    cover: row.cover,
    image: row.cover,
    status: row.status,
    cause: row.cause,
    createdAt: row.created_at,
  }
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS blog_posts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      summary TEXT NOT NULL,
      body TEXT NOT NULL,
      cover TEXT,
      version INTEGER NOT NULL CHECK(version >= 1),
      draft_pending INTEGER NOT NULL CHECK(draft_pending IN (0, 1)),
      is_published INTEGER NOT NULL CHECK(is_published IN (0, 1)),
      slug_locked INTEGER NOT NULL CHECK(slug_locked IN (0, 1)),
      published_title TEXT,
      published_slug TEXT UNIQUE,
      published_summary TEXT,
      published_body TEXT,
      published_cover TEXT,
      published_version INTEGER,
      published_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK((is_published = 0)
        OR (published_title IS NOT NULL AND published_slug IS NOT NULL
          AND published_summary IS NOT NULL AND published_body IS NOT NULL
          AND published_version IS NOT NULL AND published_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS blog_posts_publication ON blog_posts(is_published, published_at, updated_at);

    CREATE TABLE IF NOT EXISTS blog_revisions (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL REFERENCES blog_posts(id),
      version INTEGER NOT NULL CHECK(version >= 1),
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      summary TEXT NOT NULL,
      body TEXT NOT NULL,
      cover TEXT,
      status TEXT NOT NULL CHECK(status IN ('draft', 'published', 'unpublished')),
      cause TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(post_id, version)
    );
    CREATE INDEX IF NOT EXISTS blog_revisions_history ON blog_revisions(post_id, version DESC);
  `)
}

export function createBlog(db, config = {}) {
  const nowProvider = typeof config.now === 'function' ? config.now : () => new Date()

  const currentDate = () => {
    const value = new Date(nowProvider())
    if (!Number.isFinite(value.getTime())) fail(500, '伺服器時間設定不正確', 'INVALID_SERVER_TIME')
    return value
  }

  ensureSchema(db)

  const postById = db.prepare('SELECT * FROM blog_posts WHERE id = ?')
  const draftBySlug = db.prepare('SELECT * FROM blog_posts WHERE slug = ?')
  const publishedBySlug = db.prepare('SELECT * FROM blog_posts WHERE published_slug = ? AND is_published = 1')

  function loadPost(postId) {
    const post = postById.get(postId)
    if (!post) fail(404, '找不到文章', 'POST_NOT_FOUND')
    return post
  }

  function ensureSlugAvailable(slug, excludingId = null) {
    const draftMatch = draftBySlug.get(slug)
    const publishedMatch = db.prepare('SELECT id FROM blog_posts WHERE published_slug = ?').get(slug)
    if ((draftMatch && draftMatch.id !== excludingId) || (publishedMatch && publishedMatch.id !== excludingId)) {
      fail(409, '文章網址已被使用', 'SLUG_CONFLICT')
    }
  }

  function addRevision(post, cause, status, nowIso) {
    db.prepare(`
      INSERT INTO blog_revisions(
        id, post_id, version, title, slug, summary, body, cover, status, cause, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id(), post.id, post.version, post.title, post.slug, post.summary, post.body,
      post.cover, status, cause, nowIso,
    )
  }

  function list({ admin = false } = {}) {
    if (typeof admin !== 'boolean') fail(422, '文章查詢模式不正確')
    const rows = admin
      ? db.prepare('SELECT * FROM blog_posts ORDER BY updated_at DESC, id').all()
      : db.prepare('SELECT * FROM blog_posts WHERE is_published = 1 ORDER BY published_at DESC, id').all()
    return rows.map(row => admin ? draftView(row) : publicView(row))
  }

  function get(slug, { admin = false } = {}) {
    if (typeof admin !== 'boolean') fail(422, '文章查詢模式不正確')
    const normalizedSlug = normalizeSlug(slug)
    const row = admin ? draftBySlug.get(normalizedSlug) : publishedBySlug.get(normalizedSlug)
    if (!row) fail(404, '找不到文章', 'POST_NOT_FOUND')
    return admin ? draftView(row) : publicView(row)
  }

  function save(input) {
    if (!input || typeof input !== 'object') fail(422, '文章資料格式不正確')
    const title = text(input.title, '文章標題', 200)
    const slug = normalizeSlug(input.slug)
    const summary = text(input.summary, '文章摘要', 500)
    const body = text(input.body, '文章內容', 100000)
    const cover = normalizeCover(input.cover)
    const publishImmediately = input.draft === undefined ? false : !boolean(input.draft, '草稿狀態')
    const nowIso = iso(currentDate())

    return transaction(db, () => {
      if (input.id === undefined) {
        if (input.version !== undefined) fail(409, '新文章不可指定舊版本', 'VERSION_CONFLICT')
        ensureSlugAvailable(slug)
        const postId = id()
        db.prepare(`
          INSERT INTO blog_posts(
            id, title, slug, summary, body, cover, version, draft_pending, is_published, slug_locked,
            published_title, published_slug, published_summary, published_body, published_cover,
            published_version, published_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          postId, title, slug, summary, body, cover,
          publishImmediately ? 0 : 1,
          publishImmediately ? 1 : 0,
          publishImmediately ? 1 : 0,
          publishImmediately ? title : null,
          publishImmediately ? slug : null,
          publishImmediately ? summary : null,
          publishImmediately ? body : null,
          publishImmediately ? cover : null,
          publishImmediately ? 1 : null,
          publishImmediately ? nowIso : null,
          nowIso,
          nowIso,
        )
        const created = loadPost(postId)
        addRevision(created, publishImmediately ? 'created_published' : 'created_draft', publishImmediately ? 'published' : 'draft', nowIso)
        return draftView(created)
      }

      const postId = text(input.id, '文章識別', 100)
      const current = loadPost(postId)
      const version = integer(input.version, '文章版本', 1, Number.MAX_SAFE_INTEGER)
      if (current.version !== version) fail(409, '文章已被其他人更新，請重新載入', 'VERSION_CONFLICT')
      if (current.slug_locked && current.slug !== slug) {
        fail(409, '文章發布後網址永久保留，不能再變更', 'PUBLISHED_SLUG_LOCKED')
      }
      ensureSlugAvailable(slug, postId)
      const nextVersion = version + 1
      const result = publishImmediately
        ? db.prepare(`
          UPDATE blog_posts
          SET title = ?, slug = ?, summary = ?, body = ?, cover = ?, version = ?,
            draft_pending = 0, is_published = 1, slug_locked = 1,
            published_title = ?, published_slug = ?, published_summary = ?, published_body = ?,
            published_cover = ?, published_version = ?, published_at = ?, updated_at = ?
          WHERE id = ? AND version = ?
        `).run(
          title, slug, summary, body, cover, nextVersion,
          title, slug, summary, body, cover, nextVersion, nowIso, nowIso, postId, version,
        )
        : db.prepare(`
          UPDATE blog_posts
          SET title = ?, slug = ?, summary = ?, body = ?, cover = ?, version = ?,
            draft_pending = 1, updated_at = ?
          WHERE id = ? AND version = ?
        `).run(title, slug, summary, body, cover, nextVersion, nowIso, postId, version)
      if (!result.changes) fail(409, '文章已被其他人更新，請重新載入', 'VERSION_CONFLICT')
      const saved = loadPost(postId)
      addRevision(
        saved,
        publishImmediately ? 'saved_and_published' : 'saved_draft',
        publishImmediately ? 'published' : 'draft',
        nowIso,
      )
      return draftView(saved)
    })
  }

  function publish(postId, version) {
    const normalizedId = text(postId, '文章識別', 100)
    const expectedVersion = integer(version, '文章版本', 1, Number.MAX_SAFE_INTEGER)
    const nowIso = iso(currentDate())
    return transaction(db, () => {
      const current = loadPost(normalizedId)
      if (current.version !== expectedVersion) fail(409, '文章已被其他人更新，請重新載入', 'VERSION_CONFLICT')
      if (current.is_published && !current.draft_pending) return draftView(current)
      ensureSlugAvailable(current.slug, current.id)
      const nextVersion = expectedVersion + 1
      const result = db.prepare(`
        UPDATE blog_posts
        SET version = ?, draft_pending = 0, is_published = 1, slug_locked = 1,
          published_title = title, published_slug = slug, published_summary = summary,
          published_body = body, published_cover = cover, published_version = ?,
          published_at = ?, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(nextVersion, nextVersion, nowIso, nowIso, normalizedId, expectedVersion)
      if (!result.changes) fail(409, '文章已被其他人更新，請重新載入', 'VERSION_CONFLICT')
      const published = loadPost(normalizedId)
      addRevision(published, 'published', 'published', nowIso)
      return draftView(published)
    })
  }

  function unpublish(postId, version) {
    const normalizedId = text(postId, '文章識別', 100)
    const expectedVersion = integer(version, '文章版本', 1, Number.MAX_SAFE_INTEGER)
    const nowIso = iso(currentDate())
    return transaction(db, () => {
      const current = loadPost(normalizedId)
      if (current.version !== expectedVersion) fail(409, '文章已被其他人更新，請重新載入', 'VERSION_CONFLICT')
      if (!current.is_published) return draftView(current)
      const nextVersion = expectedVersion + 1
      const result = db.prepare(`
        UPDATE blog_posts
        SET version = ?, is_published = 0, draft_pending = 1, slug_locked = 1, updated_at = ?
        WHERE id = ? AND version = ? AND is_published = 1
      `).run(nextVersion, nowIso, normalizedId, expectedVersion)
      if (!result.changes) fail(409, '文章已被其他人更新，請重新載入', 'VERSION_CONFLICT')
      const unpublished = loadPost(normalizedId)
      addRevision(unpublished, 'unpublished', 'unpublished', nowIso)
      return draftView(unpublished)
    })
  }

  function restore(postId, revisionId, version) {
    const normalizedId = text(postId, '文章識別', 100)
    const normalizedRevisionId = text(revisionId, '修訂識別', 100)
    const expectedVersion = integer(version, '文章版本', 1, Number.MAX_SAFE_INTEGER)
    const nowIso = iso(currentDate())
    return transaction(db, () => {
      const current = loadPost(normalizedId)
      if (current.version !== expectedVersion) fail(409, '文章已被其他人更新，請重新載入', 'VERSION_CONFLICT')
      const revision = db.prepare('SELECT * FROM blog_revisions WHERE id = ? AND post_id = ?')
        .get(normalizedRevisionId, normalizedId)
      if (!revision) fail(404, '找不到修訂版本', 'REVISION_NOT_FOUND')
      const restoredSlug = current.slug_locked ? current.slug : revision.slug
      ensureSlugAvailable(restoredSlug, normalizedId)
      const result = db.prepare(`
        UPDATE blog_posts
        SET title = ?, slug = ?, summary = ?, body = ?, cover = ?, version = version + 1,
          draft_pending = 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(
        revision.title, restoredSlug, revision.summary, revision.body, revision.cover,
        nowIso, normalizedId, expectedVersion,
      )
      if (!result.changes) fail(409, '文章已被其他人更新，請重新載入', 'VERSION_CONFLICT')
      const restored = loadPost(normalizedId)
      addRevision(restored, `restored:${revision.id}`, 'draft', nowIso)
      return draftView(restored)
    })
  }

  function revisions(postId) {
    const normalizedId = text(postId, '文章識別', 100)
    loadPost(normalizedId)
    return db.prepare('SELECT * FROM blog_revisions WHERE post_id = ? ORDER BY version DESC')
      .all(normalizedId)
      .map(revisionView)
  }

  return { list, get, save, publish, unpublish, restore, revisions }
}
