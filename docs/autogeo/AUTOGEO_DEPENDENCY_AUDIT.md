# AutoGEO Research Dependency Audit

> **Scope.** This record is for the separate research Python environment only. It does not change Nuxt dependencies, does not call a provider API, and does not download a model checkpoint.

The checked upstream is `cxcscmu/AutoGEO` commit `49456df236774ea24087c44f45e9e52005b8e6a4`, with upstream code retained outside this repository. A pure AST scan found 35 importable non-training modules. The adapter imported all 35 under the locked research environment; the smoke test did not initialise a rewrite, make a network API request, open a dataset, or load model weights.

| Category | Fixed packages | Evidence and scope |
|---|---|---|
| Dataset and model metadata | `datasets==2.21.0`, `huggingface-hub==0.35.3`, `transformers==4.57.1`, `torch==2.5.1+cpu` | Required by `autogeo.loader` and `autogeo.utils.hf_model`; only config/tokenizer metadata was loaded. |
| Evaluation and document processing | `nltk==3.9.2`, `numpy==2.5.1`, `pandas==2.2.3`, `pydantic==2.13.4`, `PyYAML==6.0.3`, `requests==2.34.2`, `tqdm==4.70.0`, `jsonlines==4.0.0` | Direct third-party imports found in non-training upstream modules. |
| Provider client import compatibility | `google-generativeai==0.8.5`, `openai==1.107.3`, `anthropic==0.66.0`, `python-dotenv==1.1.1` | Import-only compatibility. The adapter requires explicit opt-in before an API route can progress and contains no provider implementation. |

The scan identifies `vllm` only in `autogeo/rewriters/mini.py` behind a lazy function import. It is intentionally excluded: optimized Mini inference would require a complete model download and is outside this foundation's metadata/config/tokenizer/evaluation smoke scope. The official installer separately names `vllm==0.8.5.post1`; that line is recorded as upstream context, not installed or executable research scope.[1]

## NLTK Corpus Record

AutoGEO's evaluator imports `nltk` and executes `nltk.download('punkt_tab', quiet=True)` at module import time. The only corpus actually obtained was moved to the ignored external research cache `/home/ubuntu/.cache/discoverystack-autogeo/nltk-data/`.

| Resource | External location | SHA-256 | Files | Git status |
|---|---|---|---:|---|
| `punkt_tab` | `tokenizers/punkt_tab.zip` | `e57f64187974277726a3417ca6f181ec5403676c717672eef6a748a7b20e0106` | 77 | Outside repository and ignored; not staged or committed. |

The module-import smoke was rerun with `NLTK_DATA` pinned to that cache. No replacement default `~/nltk_data` directory was created.

## Verified Commands

```bash
python3 ml/autogeo/scan_upstream_imports.py --upstream /outside/autogeo --output /outside/static-imports.json
NLTK_DATA=/outside/nltk-data python3 ml/autogeo/smoke_upstream_imports.py --upstream /outside/autogeo
HF_HOME=/outside/hf python3 ml/autogeo/smoke_checkpoint_metadata.py --model-id cx-cmu/AutoGEO_mini_Qwen1.7B_Ecommerce --revision 34e822fefbd2f99584018206f70bc4b51a155053 --cache-dir /outside/hf
python3 -m pip check
python3 -m unittest discover -s ml/autogeo/tests -p 'test_*.py' -v
```

The metadata smoke confirmed Qwen3 config type and tokenizer vocabulary size `151643`; it found **zero** `.safetensors`, `.bin`, `.pt` or `.pth` files. The vanilla evaluation smoke used only the committed synthetic fixture and truthfully reports `geo_score` and `geu_score` as unavailable. It is a pipeline integrity check, not an effectiveness evaluation.

## References

[1]: https://github.com/cxcscmu/AutoGEO "AutoGEO official repository and installation instructions"
[2]: https://huggingface.co/cx-cmu/AutoGEO_mini_Qwen1.7B_Ecommerce "AutoGEO-Mini E-commerce model card"
