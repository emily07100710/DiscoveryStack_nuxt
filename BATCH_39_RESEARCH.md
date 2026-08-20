# Batch-39 Research Evidence

## Approved source and scope

All candidates must remain within the already approved Google Search Central Documentation source at `https://developers.google.com/search/docs/**`. Each final candidate requires canonical-source preflight against active eligible human annotations, individual reading, policy-gated ingestion, extractor v4 PII screening, quality review, and schema-validated human annotation before becoming a training candidate.

## Official source evidence

The Google Search Central crawling/indexing overview at <https://developers.google.com/search/docs/crawling-indexing> states that its section covers how a site can control Google's ability to find and parse content, describes topics including crawler management, robots, canonicalization, metadata, removals and site moves, and declares that, unless otherwise noted, page content is licensed under **Creative Commons Attribution 4.0**. Retrieved 2026-08-20.

Potential topics surfaced by the official overview include managing faceted-navigation URLs, crawl budget, HTTP/network/DNS errors, crawler management, metadata, removals, and site-change guidance. These are only research directions; none is approved for ingestion until it has separately passed the canonical-source and PII gates.

The Google Search Central structured-data resource at <https://developers.google.com/search/docs/appearance/structured-data> directs users to the Rich Results Test and Schema Markup Validator. Its footer states the Google Developers content license is **Creative Commons Attribution 4.0** unless otherwise noted. Retrieved 2026-08-20.

The monitor/debug index did not yield text through markdown extraction in this pass; it is not used as source evidence unless a specific child document is retrieved and manually verified.

## Candidate reading before ingestion

1. [Remove images hosted on your site from search results](https://developers.google.com/search/docs/crawling-indexing/prevent-images-on-your-page) distinguishes the emergency Removals tool from durable removal, and describes robots.txt `Googlebot-Image` rules and `noindex` `X-Robots-Tag`. It says crawl access is needed for Googlebot to read the header. It links to personal-information removal support rather than reproducing personal data. Footer: CC BY 4.0. Retrieved and read 2026-08-20.

2. [`meta` tags and attributes that Google supports](https://developers.google.com/search/docs/crawling-indexing/special-tags) describes supported `description`, robots/googlebot, `notranslate`, `nopagereadaloud`, verification, charset, refresh, viewport and rating metadata; restrictive robots directives prevail, and it advises against JavaScript injection where possible. It includes demonstration strings and a site-verification sample token, so PII/secret-like pattern screening remains mandatory before annotation. Footer: CC BY 4.0. Retrieved and read 2026-08-20.

3. [Spam policies for Google web search](https://developers.google.com/search/docs/essentials/spam-policies) covers policy-violating practices, human/automated enforcement, cloaking, doorway and expired-domain abuse, hacked content, hidden text/link abuse, keyword stuffing, link spam, machine-generated traffic and malicious practices. It includes illustrative text containing phone-number style examples, so extraction must remain fail-closed and only a `not_detected` outcome may proceed. Footer is Google Developers CC BY 4.0. Retrieved and read 2026-08-20.

4. [Google Search technical requirements](https://developers.google.com/search/docs/essentials/technical) identifies Googlebot access, HTTP 200 status and indexable content as minimum eligibility conditions, and distinguishes eligibility from a guarantee of indexing. It directs users to Page Indexing, Crawl Stats and URL Inspection reports for diagnosis. Footer: CC BY 4.0. Retrieved and read 2026-08-20.

5. [Google Search spam updates](https://developers.google.com/search/docs/appearance/spam-updates) explains ongoing automated spam detection, the distinction between routine systems and notable spam updates, review against spam policies after traffic changes, the months-long compliance period, and the non-restoration boundary for previously removed link-spam benefit. The page contains no apparent personal contact data. Footer: CC BY 4.0. Retrieved and read 2026-08-20.
