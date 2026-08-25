# Adaptation boundary

`vendor/autogeo/**`, `vendor/rules/**`, and `LICENSE.autogeo` are immutable
upstream evidence. Their bytes are governed by `UPSTREAM_MANIFEST.json`.

Future Qwen/Bailian, HTTP, credential, queue, observability, or product adapters
must be implemented outside `vendor/**`. An upstream update must use a new
quarantine review, a new pinned commit and tree, regenerated hashes, and an
explicit audit delta. Never patch vendored files to make an adapter work.

The vendored package must not be imported in the web process or shipped to an
Astro/Nuxt client bundle. A future runtime must use a separate Python service or
worker with:

- outbound network disabled by default and explicitly allowlisted per adapter;
- no inherited developer or web-process environment;
- secrets injected only at the service boundary, never written to this tree;
- read-only vendored source and a disposable writable work/output directory;
- model IDs and revisions pinned, with `trust_remote_code=False` unless a
  separate review explicitly approves a pinned model-code artifact;
- filesystem, CPU, memory, process, and request limits;
- no customer-site writes without a separately authorized product workflow.

The current snapshot is not connected to Qwen, Bailian, Gemini, OpenAI, Claude,
Hugging Face, or any real model/provider. It does not establish production
readiness or demonstrate article optimization.
