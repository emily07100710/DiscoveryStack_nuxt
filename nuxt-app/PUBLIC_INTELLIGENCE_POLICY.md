# Public Intelligence Data Policy

## Purpose

DiscoveryStack may use publicly accessible material to build high-value research features, evaluation corpora and, where the source record passes the relevant gates, training candidates. **Public accessibility is a discovery signal, not a blanket training permission.** Each source must retain a machine-readable lineage record so it can be reviewed, excluded, expired or removed from later datasets.

## Source-card decision model

| Layer | Allowed data value | Required gate | Prohibited use |
|---|---|---|---|
| `research_only` | URL, technical/page structure, topic/entity map, bounded excerpts or derived features, strategist observations | Source URL, observed time, robots result, terms/licensing review status, PII review and retention deadline | Deployment-training set or public reproduction of source content |
| `evaluation_candidate` | De-duplicated derived features and human labels for internal measurement | Research gate plus provenance completeness and reviewer approval | Training/fine-tuning without a separate use decision |
| `training_candidate` | Versioned, minimal feature/text representation needed for the defined task | Explicit approved-use decision, quality review, data split assignment, removal path and model-card accounting | Untracked reuse or a claim that the source provides a client outcome |
| `first_party_authorised` | Authorised client or owned data, subject to project agreement and revocation terms | Explicit contractual/data-processing authorisation and human review | Cross-client reuse beyond its permitted purpose |

The Source Card stores source URL, source/canonical URL, observed date, robots URL/result, terms/licence URL and review result, region, content modality, extraction method/version, text/feature hashes, PII result, copyright/use-risk status, allowed use, retention deadline and removal/review status.

## Collection rules

The system prefers an owner-provided API, downloadable/licensed dataset or explicit permission. For ordinary public pages, collection must be rate-limited, use canonical URLs, avoid credentials/private routes, preserve only the representation required by the selected data layer, and be open to deletion or reclassification. A `robots.txt` rule helps direct respectful crawler traffic but is not, by itself, an access-control or training-rights decision. Google similarly states that robots rules manage crawler access and do not guarantee non-indexing; privacy should use actual access controls and noindex/password protections.[1]

The University of Pittsburgh’s web-scraping guidance recommends checking robots rules before extraction, respecting request load and rate limits, and reviewing site terms, copyright, privacy and other obligations.[2] Research on AI provenance highlights source lineage, consent/use restrictions, temporal information, legal information, sensitive-content assessment and versioned metadata as useful dataset properties.[3]

## Initial robots observations — pending terms and use review

These observations support polite crawl planning only. They do **not** turn the sites into training data and they do not replace a terms/licence, privacy and source-purpose review.

| Source | Robots observation on 2026-08-16 | Preliminary crawler policy state |
|---|---|---|
| `businessetup.com` | Blocks selected WordPress login/registration paths and publishes a sitemap. | `robots_reviewed` / public paths still require terms review |
| `creationbc.com` | Blocks WordPress administration, PHP URLs and Cloudflare email protection paths; publishes a sitemap. | `robots_reviewed` / public paths still require terms review |
| `grantthornton.co.uk` | Allows general crawler access while excluding search and vCard paths; publishes sitemaps. | `robots_reviewed` / public paths still require terms review |
| `simon-kucher.com` | Lists numerous disallowed administration, account, search and taxonomy paths; publishes a sitemap. | `robots_reviewed` / public paths still require terms review |

## References

[1] [Google Search Central — Introduction to robots.txt](https://developers.google.com/search/docs/crawling-indexing/robots/intro)

[2] [University of Pittsburgh Library System — Web Scraping Best Practices](https://pitt.libguides.com/webscraping/bestpractices)

[3] [Longpre et al. — Data Authenticity, Consent, and Provenance for AI Are All Broken](https://mit-genai.pubpub.org/pub/uk7op8zs)
