# Adaptation boundary

The 35 files under `vendor/autogeo/**` and `LICENSE.autogeo` are immutable
upstream evidence governed by `UPSTREAM_MANIFEST.json`. They are the selected
runtime Python source snapshot, not the complete research/training repository.
LLaMA-Factory, open-r1, datasets, models, checkpoints, and weights are absent.

Future Qwen/Bailian, HTTP, credential, queue, observability, or product adapters
must be implemented outside `vendor/**`. An upstream update must use a new
quarantine review, a new pinned commit and tree, a complete source diff,
regenerated hashes, and a new security review. Never patch vendored files to
make an adapter work. A future one-click update flow may produce an inert
candidate for review only; it must not import, execute, accept, or automatically
upgrade upstream code.

The vendored package must not be imported in a Nuxt, Astro, or PHP web process
or shipped to a client bundle. Its current import graph includes environment
reads, provider initialization, model/download paths, and other import-time
network side effects. A future runtime must use a separate Python service or
worker with:

- outbound network disabled by default and explicitly allowlisted per adapter;
- no inherited developer or web-process environment;
- Qwen/Bailian and any other credentials injected only at the service boundary,
  never inherited from the web process or written to this tree;
- read-only vendored source and a disposable writable work/output directory;
- model IDs and revisions pinned, with `trust_remote_code=False` unless a
  separate review explicitly approves a pinned model-code artifact;
- filesystem, CPU, memory, process, and request limits;
- no customer-site writes without a separately authorized product workflow.

The current snapshot is not connected to Qwen, Bailian, Gemini, OpenAI, Claude,
Hugging Face, or any real model/provider. It is not currently usable as an
AutoGEO service and does not establish production readiness or demonstrate
article optimization.
