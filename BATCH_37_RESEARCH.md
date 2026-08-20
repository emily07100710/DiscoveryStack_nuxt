# Batch-37 Candidate Research — Google Search Central CC BY 4.0

## Scope and canonical-source preflight

Batch-37 uses only the existing approved source card **Google Search Central Documentation (CC BY 4.0)**. Candidate URLs were checked against active eligible human annotations using the Google Search Central canonical source identity: the `hl` language-selection parameter and fragment do not create a distinct source document.

The following five candidates returned zero active eligible annotations at canonical path before ingestion:

1. `https://developers.google.com/search/docs/crawling-indexing/control-what-you-share`
2. `https://developers.google.com/search/docs/appearance/publication-dates`
3. `https://developers.google.com/search/docs/appearance/sitelinks`
4. `https://developers.google.com/search/docs/appearance/translated-results`
5. `https://developers.google.com/search/docs/appearance/web-stories`

The final candidate is excluded from this batch because an independent browser check returned an official Google Developers **404** page. It must not be sent to ingestion or used as a training record.

The following replacement candidate also returned zero active eligible annotations at canonical path and was selected as the fifth valid batch-37 source:

- `https://developers.google.com/search/docs/appearance/flexible-sampling`

## Human reading evidence

### Control what you share with Google

The official document distinguishes content removal, password protection, `noindex`, media-specific `robots.txt` control, and property-specific opt-out. It emphasizes that confidential/private content should be access-controlled, and that removal, indexing, crawling, and appearance should not be conflated. The page footer states that content is licensed under **Creative Commons Attribution 4.0** (with code samples under Apache 2.0). The human reading did not reveal an email address, telephone number, or national-ID-like text, but the PII gate remains decisive.

### Influence your byline dates in Google Search

The official document explains user-visible dates, `datePublished` and `dateModified` structured data, consistency between visible and marked-up values, timezone handling, future-date avoidance, and the non-guarantee that Search will show a byline date. It includes ISO 8601 example datetimes and dates, providing a useful regression case for extractor v4: ISO dates/times must not be misclassified as phone numbers. The page footer states **CC BY 4.0** for content. PII eligibility still depends on ingestion outcome.

### Sitelinks

The official document describes automated same-domain links, logical site structure, informative titles/headings, relevant internal-link anchor text, repetition avoidance, and `noindex`/content removal as options for removal. It clearly states that sitelinks are automated and not guaranteed. The page footer states **CC BY 4.0** for content. No human-observed email, telephone number, or national-ID pattern was found; the fail-closed PII gate still applies.

### Translated results in Google Search

The official document describes language and perspective gaps, machine-translated title links/snippets, original-result access, desktop/mobile availability, Search Console performance monitoring, and `notranslate` via robots meta tag or HTTP header. The page footer states **CC BY 4.0** for content. The language list and example HTTP date are not treated as PII; only the automated PII gate can admit the page.

### Flexible Sampling general guidance

The official document distinguishes metering from lead-in sampling, discusses monthly sampling, paywall user experience, subscription conversion, testing caution, referral-traffic effects, and structured-data markup for paywalled content so it is not confused with cloaking. It explicitly warns that there is no single optimal sampling value and encourages publisher-specific evaluation. The page footer states **CC BY 4.0** for content. The text contains only generalized quotas and percentages; the automated PII gate remains the mandatory admission decision.

## Collection constraints

No candidate may become a training sample until all of the following are true: policy-gated ingestion succeeds; HTTP status is valid; PII outcome is `not_detected`; a structural artifact exists; a reviewer confirms quality; the full `seoGeoMultilabelSchema` parses; the human annotation is unique under canonical source identity; and the source remains approved for `training_candidate` use.
