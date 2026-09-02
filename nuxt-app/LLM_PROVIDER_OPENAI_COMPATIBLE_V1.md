# OpenAI-compatible LLM Provider V1

## Purpose and boundary

This server-only layer provides one injectable, SDK-free chat-completions transport for GEO base-draft generation and the managed-site one-sentence edit planner. The two features have independent switches. Unset switches preserve deterministic behavior, and no provider response or credential is logged or persisted.

Allowed HTTPS endpoints are limited to the exact chat-completions paths for:

- `dashscope-intl.aliyuncs.com` and `dashscope.aliyuncs.com`;
- workspace hosts in the approved Alibaba Model Studio regions, including `*.ap-southeast-1.maas.aliyuncs.com`;
- `api.openai.com`.

Base URLs ending in `/compatible-mode/v1` or `/v1` are normalized to their matching `/chat/completions` URL. Query strings, fragments, userinfo, explicit ports, lookalike hosts, cross-family paths, redirects, and unapproved regions fail closed.

## Configuration names

- Shared provider: `NUXT_LLM_ENDPOINT`, `NUXT_LLM_API_KEY`, `NUXT_LLM_MODEL`.
- GEO switch: `NUXT_CONTENT_DRAFT_PROVIDER=openai_compatible`.
- Editor switch: `NUXT_PAGE_EDITOR_AI_PROVIDER=openai_compatible`.
- Optional editor-specific model: `NUXT_PAGE_EDITOR_AI_MODEL`.
- Legacy GEO fallback names remain supported: `NUXT_GEOFLOW_QWEN_ENDPOINT`, `NUXT_GEOFLOW_QWEN_API_KEY`, `NUXT_GEOFLOW_QWEN_MODEL`, `NUXT_GEOFLOW_QWEN_CREDENTIAL_REFERENCE`, `NUXT_AUTOGEO_BAILIAN_ENDPOINT`, `NUXT_AUTOGEO_BAILIAN_API_KEY`, `NUXT_AUTOGEO_BAILIAN_MODEL`. The legacy provider value `autogeo_bailian_qwen` aliases `openai_compatible`.
- Real-provider test gate: `DS_RUN_REAL_LLM_TESTS=1`.

OpenAI endpoints require an explicit shared or editor model; the legacy `qwen-plus` default is used only for Bailian endpoints.

## Failure semantics and tests

GEO provider output remains a draft and still passes the existing source-bound safety gate. A safety-blocked draft is held for human review with no automatic retry.

An editor provider timeout, transport failure, malformed output, forbidden operation, or failed dry run returns `clarification_required`, no operations, and `AI 暫時無法處理這個要求，請換個說法再試一次。`. The reserved daily budget is released and this fallback proposal is not stored, so it cannot be applied. Rule-based unrelated and dangerous refusals never call the provider.

With the editor switch enabled, incomplete or non-allow-listed `NUXT_LLM_*` configuration is treated as `not_configured`: it uses the same fallback with `AI_PLANNER_FAILURE:not_configured`, consumes no quota, and is not persisted.

Planner-provided warnings are sanitized and can never carry the reserved `AI_PLANNER_UNAVAILABLE` or `AI_PLANNER_FAILURE:*` markers; only the server-side fallback emits them, so provider output cannot make a request skip the budget commit or the stored proposal record.

`pnpm test` uses mocked fetch implementations and makes no provider call. `pnpm test:real-llm` is explicitly opt-in and covers a minimal completion, editor planning, and GEO base draft.

## Manual test

1. Set the three `NUXT_LLM_*` variables in the deployment secret/configuration system, then enable only the desired feature switch.
2. For the editor, submit one bounded sentence, inspect the structured proposal, and confirm that nothing changes until the customer explicitly applies a stored `proposed` proposal. For GEO, manually trigger one base draft and inspect provider provenance plus the human-review gate.
3. Run `pnpm test:real-llm` in an isolated test environment, record only status/provenance metadata, then unset the feature switch to verify deterministic fallback.
