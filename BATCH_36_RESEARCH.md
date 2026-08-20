# Batch-36 Candidate Research Notes

## Official source checked

- Google Search Central crawling and indexing overview: `https://developers.google.com/search/docs/crawling-indexing?hl=zh-tw`
- The page explicitly states that its content is licensed under **Creative Commons Attribution 4.0** unless otherwise noted; code samples are Apache 2.0.
- The overview identifies candidate themes spanning indexable file types, URL structure, sitemaps, crawl management, robots.txt, canonicalization, mobile-first indexing, AMP, JavaScript, metadata, removals, and site moves.

## Batch-36 selection rule

Candidates must be confirmed against the active eligible human-annotation source-document query before collection. Reuse is prohibited for source URLs that already have a non-removed `human_annotation` with `qualityStatus=passed`, `piiStatus=none_detected`, and `useSnapshot=training_candidate`.

## Research checkpoint

The overview itself, the in-depth Search lifecycle guide, Search appearance overview, Search Essentials, Search Console start, and traffic-drops diagnostic guide are already represented by prior batches and must not be re-collected as new training samples.

## Human-read candidate pages

All seven pages below were retrieved directly from `developers.google.com`, were confirmed to include the Google Developers **CC BY 4.0** licensing statement, and were assessed for SEO/GEO user-journey relevance before any collection attempt.

| URL | Candidate focus | Review conclusion before PII gate |
|---|---|---|
| `https://developers.google.com/search/docs/monitor-debug/bubble-chart-analysis` | Search Console query, CTR, position, clicks, device/country segmentation, and opportunity quadrants. | Suitable for a response/progression analytics sample; content includes only generic references to a site address or phone number, not observed personal data. |
| `https://developers.google.com/search/docs/monitor-debug/search-operators` | `site:`, `filetype:`, `imagesize:`, `src:` and the boundary between exploratory search operators and URL Inspection. | Suitable for a response/understanding diagnostic sample. |
| `https://developers.google.com/search/docs/crawling-indexing/amp` | AMP/canonical parity, user actions, URL clarity, structured-data eligibility, rich results, responsive devices. | Suitable for a conversion/progression implementation sample. |
| `https://developers.google.com/search/docs/crawling-indexing/amp/validate-amp` | AMP Test, Rich Results Test, AMP report, discovery, canonical and robots/X-Robots diagnosis. | Suitable for a response/progression validation sample. |
| `https://developers.google.com/search/docs/crawling-indexing/control-what-you-share` | Removal, authentication, `noindex`, robots, media crawling, low-value or duplicate content. | Suitable for a progression/conversion governance sample. |
| `https://developers.google.com/search/docs/crawling-indexing/javascript/fix-search-javascript` | Rendering, soft 404, URL fragments, state, caching, feature detection, HTTP fallback, web components and paywalls. | Relevant but code-heavy; reserve as a backup if PII-clean primary candidates are insufficient. |
| `https://developers.google.com/search/docs/crawling-indexing/website-testing` | Search-safe A/B/multivariate testing, cloaking, canonical links, temporary redirects and experiment duration. | Suitable for a conversion/progression optimization sample. |

## Candidate selection for controlled collection

The primary five candidates are bubble-chart analysis, search operators, AMP overview, AMP validation, and website testing. `control-what-you-share` and JavaScript troubleshooting are retained only as preflight-cleared backups. Ingestion remains conditional on the server-side approved-source policy, robots and rate gates, runtime PII extraction, structural artifact creation, human quality review, taxonomy validation, and source-document uniqueness.
