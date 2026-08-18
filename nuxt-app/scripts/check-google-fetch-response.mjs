const urls = [
  'https://developers.google.com/search/docs/fundamentals/seo-starter-guide?hl=en',
  'https://developers.google.com/search/docs/fundamentals/get-on-google?hl=en',
  'https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data?hl=en',
]

for (const url of urls) {
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
    headers: { Accept: 'text/html,application/xhtml+xml;q=0.9' },
  })
  console.log(JSON.stringify({
    url,
    status: response.status,
    location: response.headers.get('location'),
    contentType: response.headers.get('content-type'),
  }))
}
