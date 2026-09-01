import { configuredSimpleLoginPassword, renderOwnerLoginPage } from '../utils/ownerSimpleLogin'

export default defineEventHandler((event) => {
  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  setHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  setHeader(event, 'X-Robots-Tag', 'noindex, nofollow, noarchive')
  if (!configuredSimpleLoginPassword()) {
    setResponseStatus(event, 503)
    return renderOwnerLoginPage({ message: 'Owner 登入尚未設定。請在伺服器設定 OWNER_SIMPLE_LOGIN_PASSWORD 後再試。' })
  }
  return renderOwnerLoginPage()
})
