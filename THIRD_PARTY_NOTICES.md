# Third-Party Notices — AutoGEO Research Foundation

DiscoveryStack does not distribute the listed code, datasets or model weights in this repository. The entries below document the independently retrieved upstream assets that the research adapter can verify into an external cache.

| Component | Official source | Observed license | Notice and usage boundary |
|---|---|---|---|
| AutoGEO code | https://github.com/cxcscmu/AutoGEO | MIT | Copyright (c) 2025 cxcscmu. The upstream MIT notice permits use, copying, modification, distribution and sale subject to retaining the notice and disclaimer. This branch does not vendor the code. |
| AutoGEO datasets: E-commerce, GEO-Bench, Researchy-GEO | https://huggingface.co/cx-cmu | MIT shown on every dataset card / public metadata | Dataset-specific source, consent, PII and commercial-use review remains mandatory before any DiscoveryStack training or customer-facing evaluation. A hub tag is not a replacement for that review. |
| AutoGEO-Mini: three Qwen1.7B variants | https://huggingface.co/cx-cmu | MIT shown on every model card / public metadata | The cards specify an English, domain-and-engine-specific post-trained rewriter. It must not be represented as a validated Chinese or DiscoveryStack model. |
| Qwen/Qwen3-1.7B-Base and Qwen/Qwen3-1.7B | https://huggingface.co/Qwen | Apache-2.0 | Preserve the upstream Apache-2.0 terms if distributing a downstream derivative. Qwen's multilingual claim does not replace in-domain Traditional Chinese evaluation. |
| LLaMA-Factory | https://github.com/hiyouga/LLaMA-Factory | Apache-2.0 (upstream repository) | AutoGEO lists it only for Mini training. It is not installed, copied or executed by this foundation. |
| open-r1 | https://github.com/huggingface/open-r1 | Apache-2.0 (upstream repository) | AutoGEO lists it only for Mini training. It is not installed, copied or executed by this foundation. |

> The exact asset revisions, license fields and file hashes are produced by `ml/autogeo/sync_assets.py` from the official public endpoints before use. Do not rely on this notice alone to approve a new data source.

## AutoGEO MIT notice

> MIT License. Copyright (c) 2025 cxcscmu. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, subject to the conditions in the upstream license.

## References

[1]: https://github.com/cxcscmu/AutoGEO/blob/main/LICENSE "AutoGEO MIT License"
[2]: https://huggingface.co/datasets/cx-cmu/E-commerce "E-commerce dataset card"
[3]: https://huggingface.co/datasets/cx-cmu/GEO-Bench "GEO-Bench dataset card"
[4]: https://huggingface.co/datasets/cx-cmu/Researchy-GEO "Researchy-GEO dataset card"
[5]: https://huggingface.co/Qwen/Qwen3-1.7B "Qwen3-1.7B model card"
[6]: https://github.com/hiyouga/LLaMA-Factory/blob/main/LICENSE "LLaMA-Factory license"
[7]: https://github.com/huggingface/open-r1/blob/main/LICENSE "open-r1 license"
