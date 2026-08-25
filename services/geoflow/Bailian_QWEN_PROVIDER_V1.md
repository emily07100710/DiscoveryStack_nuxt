# GEOFlow Bailian Qwen Provider Integration V1

## Scope and safety boundary

This integration adds governed Bailian/Qwen support to the existing GEOFlow OpenAI-compatible runtime. It does not create a second AI model store, a second quota table, a browser-side client, a public endpoint, a crawler, a RAG implementation, an AutoGEO rule engine, or an automatic publication path. Generated material remains a candidate/draft and must pass the existing owner and human-review boundary.

The implementation is provider-neutral at the transport layer. `BailianRuntimeProvider` is a pure server-side contract guard: it validates configuration, creates the bounded OpenAI-compatible request shape, validates a bounded response, classifies failures, redacts diagnostics, defines bounded retry eligibility, and creates key-free provenance. It never sends a request.

## Official endpoint allowlist

Only the following canonical bases are accepted:

| Region class | Canonical base |
|---|---|
| China shared | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| International shared | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| US shared | `https://dashscope-us.aliyuncs.com/compatible-mode/v1` |
| Beijing workspace | `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` |
| Singapore workspace | `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` |
| Japan workspace | `https://{WorkspaceId}.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1` |
| US East workspace | `https://{WorkspaceId}.us-east-1.maas.aliyuncs.com/compatible-mode/v1` |

The canonical workspace label uses lowercase ASCII letters, digits, and interior hyphens; DNS hostname casing is normalized to lowercase before validation. URLs must use HTTPS, have no userinfo, query, or fragment, use the default HTTPS port, contain no IP literal, and have exactly the `/compatible-mode/v1` path. A caller-provided `/chat/completions` path, encoded slash, double-encoded path, traversal, backslash, arbitrary compatible host, or hostname suffix spoof fails closed. The server alone constructs `/chat/completions`; callers do not choose a complete request URL. No cross-origin redirect is enabled by the existing secure outbound boundary.

Official Alibaba Cloud documentation describes the OpenAI-compatible HTTP endpoint as `POST <BASE_URL>/chat/completions`, with `model`, `messages`, and `stream` request fields. The implementation sends `stream: false` for the Bailian connection-test payload and reuses the existing GEOFlow generation prompt/agent for article generation. [1] [2]

## Model and credential governance

A Bailian configuration requires an explicit opaque model identifier beginning with `qwen`. The identifier is bounded to 128 characters and accepts only ASCII letters, digits, dot, underscore, and hyphen. It rejects URL/path/query syntax, control characters, duplicate-dot or backslash forms, and prompt-injection markers. `qwen-plus` is used only as a synthetic test value; the production code does not hard-code it as the only or permanent model.

Credentials remain exclusively in `AiModel.api_key` using the existing `ApiKeyCrypto` encryption/decryption path. The provider helper does not accept, store, or return a credential. Admin update behavior continues to treat a blank key as “retain the existing encrypted key.” Logs, response metadata, provenance, exceptions, HTML, JavaScript, and URLs do not contain the raw key or a complete Authorization header.

## Runtime, quota, and response contract

`ArticleContentGenerationService` continues to use `MarkdownContentWriterAgent`, `OpenAiRuntimeProvider`, the Laravel AI OpenAI-compatible driver, and the existing `AiUsageQuotaService`. Before a Bailian generation runtime is registered, the canonical endpoint and model are validated. Daily usage is atomically reserved before the agent call; failures release or finalize according to the existing GEOFlow reservation semantics, while successful output records existing usage. The admin connection test also reserves quota and never bypasses the daily limit.

The Bailian connection-test request is sent only through the existing `SafeOutboundHttpClient` and existing server-side timeout. The bounded request contains `model`, `messages`, `stream: false`, bounded `temperature`, and bounded `max_tokens`. No new `Http::post()` or browser request is introduced.

Only a bounded OpenAI-compatible response is accepted. It must contain a non-empty string at `choices[0].message.content`, a bounded optional `finish_reason`, non-negative integer `prompt_tokens`, `completion_tokens`, and `total_tokens`, and an optional bounded opaque request ID. Empty content, empty choices, malformed usage, HTML/non-JSON content, embedded streaming data, unsafe request IDs, and oversized values fail closed. Success metadata contains provider, region, canonical host, model ID, provider mode, request ID, finish reason, token usage, attempted timestamp, response status, and fallback status; it never contains a key, prompt, or full response.

Failure classes are `invalid_configuration`, `missing_credential`, `unauthorized`, `forbidden`, `rate_limited`, `timeout`, `network_failure`, `provider_5xx`, `malformed_json`, `empty_content`, `content_truncated`, and `unsupported_model`. Unauthorized, forbidden, and malformed configuration failures are not retryable. Rate limits, 5xx, timeout, and network failures may be retried only within a bounded attempt count; there is no unbounded retry loop. Diagnostics are redacted and bounded before being returned to an owner-facing response.

## Validation boundary

`BailianQwenProviderTest.php` contains 129 direct pure-contract tests. They cover the three shared bases, four workspace regions, exact canonical paths, endpoint spoofing, userinfo/query/fragment/port/IP/localhost/private targets, traversal and encoded paths, workspace grammar, model validation, request shape, `stream: false`, bounded sampling and token fields, response content/finish/usage/request ID, malformed/empty/oversized response cases, HTTP failure classes, retry eligibility, redaction, provenance, and the explicit no-network surface. Existing OpenAI-compatible runtime tests remain part of the regression set.

The task environment did not provide host PHP, Composer, or Docker. Per the repair instruction, implementation, static inspection, Node checks, and Git safety scans may proceed, but PHP/Composer runtime validation remains pending until a Docker + PHP 8.4 environment is available. No real Bailian credential, request, connection test, migration, deployment, or client-site write is performed by this task.

## References

[1]: https://help.aliyun.com/en/model-studio/compatibility-of-openai-with-dashscope "Alibaba Cloud Model Studio — OpenAI-compatible Chat"
[2]: https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions "Alibaba Cloud Model Studio — Qwen OpenAI-compatible Chat"
