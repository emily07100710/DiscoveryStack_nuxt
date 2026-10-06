import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { fail, id, text } from './errors.mjs'
import { transaction } from './store.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const MAX_ANONYMOUS_SESSIONS = 2_048
const MAX_SESSIONS_PER_PRINCIPAL = 20
const MAX_ACTIVE_SESSIONS = 10_000
const ACTION_TOKEN_TTL_MS = 30 * 60 * 1_000
const recoveryReceipt = () => ({ accepted: true, message: '如果資料符合，系統將寄出下一步說明。' })
export function hashPassword(value) {
  const password = text(value, '密碼', 256)
  if (password.length < 12) fail(422, '密碼至少需要 12 字')
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`
}
function matches(value, stored) {
  if (typeof value !== 'string' || value.length > 256) return false
  const [salt, hash] = stored.split(':')
  const actual = scryptSync(value, salt, 32)
  const expected = Buffer.from(hash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
export function createAuth(db, { adminPassword, sessionSecret, mode }) {
  if (typeof sessionSecret !== 'string' || sessionSecret.length < 32) fail(503, '網站登入金鑰尚未設定', 'SESSION_NOT_CONFIGURED')
  if (mode === 'production' && (!adminPassword || adminPassword.length < 14)) fail(503, '正式網站須設定至少 14 字的獨立管理密碼', 'ADMIN_NOT_CONFIGURED')
  const adminHash = adminPassword ? hashPassword(adminPassword) : null
  // Unknown accounts still pay the same scrypt cost, reducing email/account timing signals.
  const dummyHash = hashPassword(`unavailable-${randomBytes(24).toString('hex')}`)
  db.exec(`CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL,email_verified INTEGER NOT NULL DEFAULT 0 CHECK(email_verified IN (0,1)));
    CREATE TABLE IF NOT EXISTS site_sessions (token_hash TEXT PRIMARY KEY,member_id TEXT,role TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS auth_throttle (key_hash TEXT PRIMARY KEY,attempts INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_action_tokens (
      token_hash TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('email_verification','password_reset')),
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_action_member ON auth_action_tokens(member_id,kind,created_at);`)
  const memberColumns = db.prepare('PRAGMA table_info(members)').all()
  if (!memberColumns.some(column => column.name === 'email_verified')) db.exec('ALTER TABLE members ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0 CHECK(email_verified IN (0,1))')
  const sessionColumns = db.prepare('PRAGMA table_info(site_sessions)').all()
  if (!sessionColumns.some(column => column.name === 'created_at')) db.exec('ALTER TABLE site_sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0')
  const csrf = token => createHmac('sha256', sessionSecret).update(`csrf:${token}`).digest('hex')
  const publicMember = row => row ? { id: row.id, name: row.name, email: row.email, createdAt: row.createdAt, emailVerified: Boolean(row.emailVerified) } : undefined
  const member = memberId => publicMember(db.prepare('SELECT id,name,email,created_at AS createdAt,email_verified AS emailVerified FROM members WHERE id=?').get(memberId))
  function session(token) {
    if (!token || !/^[a-f0-9]{64}$/u.test(token)) return null
    const row = db.prepare('SELECT * FROM site_sessions WHERE token_hash=? AND expires_at>?').get(digest(token), Date.now())
    return row ? { actor: row.role === 'admin' ? { role: 'admin', name: '網站管理者' } : row.member_id ? { ...member(row.member_id), role: 'member' } : null, role: row.role, csrfToken: csrf(token) } : null
  }
  function issue(role = 'anonymous', memberId = null) {
    if (!['anonymous', 'member', 'admin'].includes(role)) fail(500, '登入狀態不正確', 'SESSION_ROLE_INVALID')
    const token = randomBytes(32).toString('hex')
    const createdAt = Date.now()
    transaction(db, () => {
      db.prepare('DELETE FROM site_sessions WHERE expires_at<=?').run(createdAt)
      if (role === 'anonymous') {
        const count = db.prepare("SELECT count(*) AS count FROM site_sessions WHERE role='anonymous'").get().count
        const remove = count - MAX_ANONYMOUS_SESSIONS + 1
        if (remove > 0) db.prepare(`DELETE FROM site_sessions WHERE token_hash IN (
          SELECT token_hash FROM site_sessions WHERE role='anonymous' ORDER BY created_at,token_hash LIMIT ?
        )`).run(remove)
      } else {
        const count = role === 'member'
          ? db.prepare("SELECT count(*) AS count FROM site_sessions WHERE role='member' AND member_id=?").get(memberId).count
          : db.prepare("SELECT count(*) AS count FROM site_sessions WHERE role='admin'").get().count
        const remove = count - MAX_SESSIONS_PER_PRINCIPAL + 1
        if (remove > 0) {
          const rows = role === 'member'
            ? db.prepare("SELECT token_hash FROM site_sessions WHERE role='member' AND member_id=? ORDER BY created_at,token_hash LIMIT ?").all(memberId, remove)
            : db.prepare("SELECT token_hash FROM site_sessions WHERE role='admin' ORDER BY created_at,token_hash LIMIT ?").all(remove)
          const removeSession = db.prepare('DELETE FROM site_sessions WHERE token_hash=?')
          for (const row of rows) removeSession.run(row.token_hash)
        }
      }
      if (db.prepare('SELECT count(*) AS count FROM site_sessions').get().count >= MAX_ACTIVE_SESSIONS) fail(503, '登入服務暫時繁忙，請稍後再試', 'SESSION_CAPACITY')
      db.prepare('INSERT INTO site_sessions(token_hash,member_id,role,expires_at,created_at) VALUES(?,?,?,?,?)')
        .run(digest(token), memberId, role, createdAt + 8 * 60 * 60 * 1000, createdAt)
    })
    return { token, ...session(token) }
  }
  function throttle(key) {
    const hashed = digest(key)
    transaction(db, () => {
      db.prepare('DELETE FROM auth_throttle WHERE expires_at<=?').run(Date.now())
      const existing = db.prepare('SELECT attempts FROM auth_throttle WHERE key_hash=?').get(hashed)
      if (existing?.attempts >= 8) fail(429, '嘗試次數過多，請 15 分鐘後再試', 'LOGIN_THROTTLED')
      db.prepare('INSERT INTO auth_throttle VALUES(?,1,?) ON CONFLICT(key_hash) DO UPDATE SET attempts=attempts+1').run(hashed, Date.now() + 15 * 60 * 1000)
    })
  }
  function register(input, address) {
    throttle(`register:${address}`)
    const name = text(input.name, '姓名', 120)
    const email = text(input.email, 'Email', 320).toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) fail(422, 'Email 格式不正確')
    const passwordHash = hashPassword(input.password)
    if (input.consent !== true) fail(422, '請先同意隱私說明')
    const memberId = id()
    try { db.prepare('INSERT INTO members(id,name,email,password_hash,created_at) VALUES(?,?,?,?,?)').run(memberId, name, email, passwordHash, new Date().toISOString()) }
    catch (error) { if (error.code?.includes('CONSTRAINT')) fail(409, '無法建立帳號，請確認資料或改用登入'); throw error }
    return issue('member', memberId)
  }
  function login(input, address, admin = false) {
    const email = admin ? 'admin' : String(input.email || '').trim().toLowerCase()
    throttle(`login:${address}:${email}`)
    const row = admin ? null : db.prepare('SELECT id,password_hash FROM members WHERE email=?').get(email)
    const validPassword = matches(input.password, admin ? (adminHash || dummyHash) : (row?.password_hash || dummyHash))
    const valid = admin ? Boolean(adminHash) && validPassword : Boolean(row) && validPassword
    if (!valid) { if (!adminHash && admin) fail(503, '管理登入尚未設定'); fail(401, '登入資料不正確，請重新確認', 'LOGIN_FAILED') }
    return issue(admin ? 'admin' : 'member', row?.id || null)
  }
  function verifyCsrf(token, supplied) {
    if (!session(token) || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/u.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrf(token)))) fail(403, '操作驗證已失效，請重新整理後再試', 'CSRF_FAILED')
  }

  function createActionToken(memberId, kind) {
    const createdAt = Date.now()
    const token = randomBytes(32).toString('base64url')
    transaction(db, () => {
      db.prepare('DELETE FROM auth_action_tokens WHERE expires_at<=? OR (consumed_at IS NOT NULL AND consumed_at<=?)').run(createdAt, createdAt - 24 * 60 * 60 * 1_000)
      db.prepare('UPDATE auth_action_tokens SET consumed_at=? WHERE member_id=? AND kind=? AND consumed_at IS NULL').run(createdAt, memberId, kind)
      db.prepare('INSERT INTO auth_action_tokens(token_hash,member_id,kind,expires_at,consumed_at,created_at) VALUES(?,?,?,?,NULL,?)')
        .run(digest(token), memberId, kind, createdAt + ACTION_TOKEN_TTL_MS, createdAt)
    })
    return token
  }

  function requestVerification(memberId) {
    const target = member(memberId)
    if (!target) fail(404, '找不到會員', 'MEMBER_NOT_FOUND')
    throttle(`verification:${target.email}`)
    const receipt = recoveryReceipt()
    if (target.emailVerified) return { receipt, delivery: null }
    return { receipt, delivery: { to: target.email, token: createActionToken(target.id, 'email_verification'), kind: 'email_verification' } }
  }

  function actionToken(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{40,100}$/u.test(value)) fail(410, '連結已失效，請重新申請', 'ACTION_TOKEN_INVALID')
    return value
  }

  function consumeActionToken(tokenValue, kind, work) {
    const tokenHash = digest(actionToken(tokenValue))
    return transaction(db, () => {
      const consumedAt = Date.now()
      const row = db.prepare(`SELECT member_id FROM auth_action_tokens
        WHERE token_hash=? AND kind=? AND consumed_at IS NULL AND expires_at>?`).get(tokenHash, kind, consumedAt)
      if (!row) fail(410, '連結已失效，請重新申請', 'ACTION_TOKEN_INVALID')
      const consumed = db.prepare(`UPDATE auth_action_tokens SET consumed_at=?
        WHERE token_hash=? AND kind=? AND consumed_at IS NULL AND expires_at>?`).run(consumedAt, tokenHash, kind, consumedAt)
      if (consumed.changes !== 1) fail(410, '連結已失效，請重新申請', 'ACTION_TOKEN_INVALID')
      return work(row.member_id, consumedAt)
    })
  }

  function confirmVerification(input) {
    return consumeActionToken(input?.token, 'email_verification', memberId => {
      const changed = db.prepare('UPDATE members SET email_verified=1 WHERE id=?').run(memberId)
      if (changed.changes !== 1) fail(410, '連結已失效，請重新申請', 'ACTION_TOKEN_INVALID')
      db.prepare("UPDATE auth_action_tokens SET consumed_at=COALESCE(consumed_at,?) WHERE member_id=? AND kind='email_verification'").run(Date.now(), memberId)
      return { emailVerified: true }
    })
  }

  function requestPasswordReset(input) {
    const receipt = recoveryReceipt()
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(422, 'Email 格式不正確')
    const email = text(input.email, 'Email', 320).toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) fail(422, 'Email 格式不正確')
    throttle(`password-reset:${email}`)
    const row = db.prepare('SELECT id,email FROM members WHERE email=?').get(email)
    if (!row) return { receipt, delivery: null }
    return { receipt, delivery: { to: row.email, token: createActionToken(row.id, 'password_reset'), kind: 'password_reset' } }
  }

  function resetPassword(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(422, '重設資料格式不正確')
    const token = actionToken(input.token)
    const passwordHash = hashPassword(input.password)
    return consumeActionToken(token, 'password_reset', (memberId, consumedAt) => {
      const changed = db.prepare('UPDATE members SET password_hash=? WHERE id=?').run(passwordHash, memberId)
      if (changed.changes !== 1) fail(410, '連結已失效，請重新申請', 'ACTION_TOKEN_INVALID')
      db.prepare('DELETE FROM site_sessions WHERE member_id=?').run(memberId)
      db.prepare("UPDATE auth_action_tokens SET consumed_at=COALESCE(consumed_at,?) WHERE member_id=? AND kind='password_reset'").run(consumedAt, memberId)
      return { reset: true }
    })
  }

  return {
    session,
    issue,
    register,
    login,
    verifyCsrf,
    member,
    requestVerification,
    confirmVerification,
    requestPasswordReset,
    resetPassword,
    listMembers: () => db.prepare('SELECT id,name,email,created_at AS createdAt,email_verified AS emailVerified FROM members ORDER BY created_at DESC LIMIT 500').all().map(publicMember),
    logout: token => { db.prepare('DELETE FROM site_sessions WHERE token_hash=?').run(digest(token || '')) },
  }
}
