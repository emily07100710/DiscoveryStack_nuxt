# External ML provider notes

## Hugging Face Transformers

Source: https://huggingface.co/docs/transformers/v4.45.1/training

The official Transformers training guide describes fine-tuning a pretrained model with a task-specific dataset. The documented flow loads a dataset, tokenizes text with `AutoTokenizer`, loads a sequence classifier with `AutoModelForSequenceClassification`, creates `TrainingArguments`, and trains/evaluates with `Trainer`. The guide explicitly distinguishes fine-tuning from inference/embeddings.

## Hugging Face Jobs

Source: https://huggingface.co/docs/huggingface_hub/en/guides/jobs

Hugging Face Jobs run commands on Hugging Face-managed infrastructure with selectable CPU/GPU hardware. The official guide documents `run_job()` / `run_uv_job()`, encrypted job secrets, job status inspection, logs, metrics, and a default timeout that should be increased for long training. A GPU flavor such as `a10g-small` can be used for training. Jobs require an authenticated Hugging Face account and available credits.

## Firecrawl Crawl API

Sources:
- https://docs.firecrawl.dev/api-reference/endpoint/crawl-post
- https://docs.firecrawl.dev/api-reference/endpoint/crawl-get
- https://docs.firecrawl.dev/features/crawl

Firecrawl v2 uses `POST https://api.firecrawl.dev/v2/crawl` with `Authorization: Bearer <token>`. The request accepts a start URL, `limit`, `maxDiscoveryDepth`, path filters, `crawlEntireDomain`, `allowExternalLinks`, `allowSubdomains`, and `scrapeOptions`. It returns a crawl job ID. `GET /v2/crawl/{id}` returns status and page data, including markdown and metadata; results can be polled or received through a webhook. The implementation must set a low explicit page limit, disable external links/subdomains, and preserve the project's own Source Card policy gate before calling the provider.

## DiscoveryStack runtime wiring

The Nuxt server now reads these server-only variables: `FIRECRAWL_API_KEY`, `FIRECRAWL_API_BASE_URL`, `HUGGINGFACE_API_TOKEN`, `HUGGINGFACE_NAMESPACE`, `HUGGINGFACE_BASE_MODEL_ID`, and `HUGGINGFACE_JOB_FLAVOR`. A connector entry or a local UI field is not automatically injected into the deployed Nuxt runtime; the deployment environment must map the provider credentials to these variables. The public client never receives the token.

The site crawl path calls Firecrawl first, then applies DiscoveryStack's own host, robots, terms, copyright, PII and retention gates before creating structural artifacts. The training path submits a private Hugging Face Job that runs `transformers.Trainer` and uploads a private model repository. A training run is marked `completed` only after the remote job reports completion and its result marker is read; submission failure is recorded as `failed` and never presented as a trained model.
