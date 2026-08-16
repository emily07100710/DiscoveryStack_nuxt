export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event)
  const hasSessionSecret = Boolean(
    (typeof config.sessionSecret === 'string' && config.sessionSecret)
    || process.env.NUXT_SESSION_SECRET
    || process.env.JWT_SECRET,
  )
  const hasOwnerOpenId = Boolean(
    (typeof config.ownerOpenId === 'string' && config.ownerOpenId)
    || process.env.NUXT_OWNER_OPEN_ID
    || process.env.OWNER_OPEN_ID,
  )

  setHeader(event, 'Cache-Control', 'no-store, max-age=0')
  setHeader(event, 'X-Robots-Tag', 'noindex, nofollow, noarchive')
  setHeader(event, 'X-DiscoveryStack-Private-Config', hasSessionSecret && hasOwnerOpenId ? 'ready' : 'missing')
  return { status: hasSessionSecret && hasOwnerOpenId ? 'ready' : 'missing' }
})
