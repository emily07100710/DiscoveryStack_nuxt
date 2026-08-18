const urls = [
  'https://developers.google.com/search/docs/fundamentals/seo-starter-guide?hl=en',
  'https://developers.google.com/search/docs/fundamentals/get-on-google?hl=en',
  'https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data?hl=en',
]

function stripMarkup(value) {
  return value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

const phonePattern = /(?<!\d)(?:\+?\d[\d\s().-]{7,}\d)(?!\d)/g

for (const url of urls) {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) })
  const text = stripMarkup(await response.text())
  const matches = [...text.matchAll(phonePattern)].map(([match]) => ({
    classification: /^\d{4}-\d{2}-\d{2}$/.test(match) ? 'iso_date' : 'other',
    shape: match.replace(/\d/g, '#'),
    length: match.length,
  }))
  console.log(JSON.stringify({ url, status: response.status, matches }))
}
