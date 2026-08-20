# Batch-38 Candidate Research

## Scope and source policy

Only Google Search Central documents under `https://developers.google.com/search/docs/**` are considered. The approved source is Google Search Central Documentation, with CC BY 4.0 reuse terms and policy-gated, single-document ingestion. Every candidate must pass canonical-source preflight, official-page reading, PII extraction, human quality review, and schema validation before it can contribute to the 101-example threshold.

## Canonical source preflight

The following paths already have human annotations and are excluded before collection: `crawling-indexing/links-crawlable` (270003), `crawling-indexing/robots-meta-tag` (150002), and `appearance/structured-data/sd-policies` (270002). Preflight treats language-only `hl` variants as one Google source document.

## Official index evidence

- Crawling and indexing overview: <https://developers.google.com/search/docs/crawling-indexing>
  - Official scope covers crawler management, faceted navigation, removals, metadata, canonicalization, mobile, AMP, JavaScript, and site changes.
  - Page footer states Google Developers content is CC BY 4.0 unless otherwise noted.
- Search appearance overview: <https://developers.google.com/search/docs/appearance>
  - Official scope includes business details, Top Places List, structured data, and appearance features.
  - Page footer states Google Developers content is CC BY 4.0 unless otherwise noted.

## Human-read candidate evidence

| Candidate URL | Reading result | Subject fit | Licence / risk note |
|---|---|---|---|
| <https://developers.google.com/search/docs/appearance/top-places-list> | Extracted successfully | Local-business appearance, genuine independent lists, physical location and feature opt-out | Footer confirms CC BY 4.0; no personal contact information observed in the official prose. |
| <https://developers.google.com/search/docs/appearance/structured-data/speakable> | Extracted successfully | Structured data, TTS presentation, country/language availability, eligibility and troubleshooting | Footer confirms CC BY 4.0; use official PII gate rather than manual inference. |
| <https://developers.google.com/search/docs/crawling-indexing/faceted-navigation> | Text extraction returned no content; browser verification returned Google for Developers 404 | Not a valid current document | Excluded. No ingestion, PII processing, artifact, or annotation was created. |
| <https://developers.google.com/search/docs/appearance/business-details> | Text extraction returned no content; browser verification returned Google for Developers 404 | Not a valid current document | Excluded. No ingestion, PII processing, artifact, or annotation was created. |
| <https://developers.google.com/search/docs/appearance/package-tracking> | Extracted successfully | Package-tracking API availability, latency, required and recommended delivery fields, personal-data prohibition | Footer confirms CC BY 4.0. The page mentions support-phone field names but does not expose a phone number; the PII extractor remains authoritative. |
| <https://developers.google.com/search/docs/appearance/structured-data/shipping-policy> | Extracted successfully (long document) | `ShippingService`, organization-level policy, delivery time/cost, country conditions, Rich Results Test and URL Inspection | Footer is present in the official document. Example code contains commercial values and region codes; retain only if PII gate is `not_detected`. |
| <https://developers.google.com/search/docs/appearance/structured-data/vacation-rental> | Extracted successfully (long document) | `VacationRental` eligibility, local listing properties, schema validation and technical-account prerequisites | Official CC BY 4.0 document. Example content includes names and physical-address-shaped data, so this candidate is specifically subject to the fail-closed PII gate and may be excluded. |

## Batch-38 selected ingestion scope

The five selected, canonical-preflight-clear candidates are Top Places List, Speakable structured data, Package tracking Early Adopters Program, Merchant shipping policy structured data, and Vacation rental structured data. No candidate is eligible merely because it is an official document; batch-38 must still record an actual policy-gated HTTP outcome and may annotate only `piiOutcome=not_detected` structural artifacts.

No batch-38 ingestion, structural artifact, or annotation has been created at this research stage.
