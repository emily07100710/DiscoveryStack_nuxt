export async function useContentPage() {
  const route = useRoute()
  const { data, error } = await useAsyncData(`page:${route.path}`, () =>
    queryCollection('pages').where('route', '=', route.path).first(),
  )

  if (error.value || !data.value) {
    throw createError({ statusCode: 404, statusMessage: 'Page not found' })
  }

  return computed(() => data.value!)
}
