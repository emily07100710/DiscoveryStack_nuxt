# AutoGEO upstream supply-chain security audit V1

## Conclusion: PASS WITH LIMITATIONS

The pinned upstream source passed the V1 quarantine gate for a source-only,
non-executed vendor snapshot. No high/critical malicious indicator, source SHA
mismatch, incompatible license, detected secret signature, unexplained binary,
symlink, Git LFS pointer, archive, gitlink/submodule drift, or archive-bomb input
was found in the pinned tree.

This is not a claim that AutoGEO is completely safe, non-malicious, or free of
viruses. Static review cannot prove absence of malicious behavior. ClamAV,
Semgrep, OSV-Scanner, and pip-audit were unavailable; dependencies are not fully
pinned or locked; the commit signature could not be locally verified; and no
upstream code or dependency was executed. The vendored source contains network,
credential, model-loading, filesystem-write, and import-time behaviors that must
remain isolated until a separate runtime/adaptation review.

Audit time: `2026-08-25T08:21:12Z` UTC.

## Source identity and license

- Repository: `https://github.com/cxcscmu/AutoGEO.git`
- Requested and checked-out commit: `49456df236774ea24087c44f45e9e52005b8e6a4`
- `origin/main` from `git ls-remote` at audit time: same SHA
- Parent: `aa3af2686b5ca88a028b080453e6f7010a1dfa13`
- Tree: `4eb429f3ee33150c122a8e37856977b13c089924`
- Subject: `Update README.md`
- Commit date: `2026-06-13T22:17:31-04:00`
- Commit signature verification: **NOT RUN**; local `gpg` was unavailable.
- License: MIT, verified from `LICENSE` at the pinned commit rather than README.
- License SHA-256: `7db440f0a16ee1bb2b77726e9c693a6171667069c6ac1679efbb2c2fe41cf0b3`
- License text contains the standard MIT grant, preservation condition, and
  warranty/liability disclaimer; copyright is `2025 cxcscmu`.

## Quarantine procedure

The audit used a new `/tmp` clone, detached at the pinned SHA, with
`GIT_LFS_SKIP_SMUDGE=1`. No submodule was initialized. None of `install.sh`,
`install_mini.sh`, `run_cold_start.sh`, `run_grpo.sh`, or any other upstream
shell script was executed. No package was installed or imported. No `.env`,
keychain, local credential, model provider, dataset service, or customer site was
accessed.

The upstream tree has no `.gitmodules` file and no `160000` gitlink entry at this
commit. Although `install_mini.sh:48-49,72-73` describes `open-r1` and
`LLaMA-Factory` as submodules, the pinned tree actually stores them as ordinary
tracked directories. Therefore the submodule URL/SHA inventory is empty.

## Tree inventory

- Tracked files: 2,392
- Sum of tracked blob bytes: 58,540,414
- Executable tracked files: `install.sh`, `install_mini.sh`,
  `run_cold_start.sh`
- Symlinks: none
- Git LFS pointers: none
- Archive/compressed extensions: none
- Files greater than 1 MiB:
  - 19,692,372 bytes: `LLaMA-Factory/data/Autorule_claude_ecommercial_Results.json`
  - 1,575,286 bytes: `LLaMA-Factory/data/dpo_en_demo.json`
- Files greater than 5 MiB: only the 19,692,372-byte JSON above
- Files greater than 20 MiB: none

`file --mime-type` classified 2,021 files as JSON, 216 as Python, 122 as
plain text, 9 as shell, 8 as empty, and the remainder as known documentation or
media. The 14 non-plain media files were confined to excluded LLaMA-Factory
assets/demo data: `assets/alaya_new.svg`, `assets/wechat.jpg`,
`assets/wechat_npu.jpg`, and `data/mllm_demo_data/{1.jpg,1.mp3,1.mp4,2.avi,2.jpg,2.wav,3.flac,3.jpg,3.mp4,4.mp3,4.mp4}`. No binary or media file exists under `autogeo/**`.

### Largest 30 tracked blobs

| Bytes | Upstream path |
| ---: | --- |
| 19,692,372 | `LLaMA-Factory/data/Autorule_claude_ecommercial_Results.json` |
| 1,575,286 | `LLaMA-Factory/data/dpo_en_demo.json` |
| 1,028,326 | `LLaMA-Factory/data/wiki_demo.txt` |
| 913,519 | `LLaMA-Factory/data/kto_en_demo.json` |
| 860,929 | `LLaMA-Factory/data/alpaca_en_demo.json` |
| 853,311 | `LLaMA-Factory/data/dpo_zh_demo.json` |
| 747,189 | `LLaMA-Factory/data/c4_demo.jsonl` |
| 738,925 | `LLaMA-Factory/data/glaive_toolcall_en_demo.json` |
| 680,684 | `LLaMA-Factory/data/glaive_toolcall_zh_demo.json` |
| 636,036 | `LLaMA-Factory/data/alpaca_zh_demo.json` |
| 481,185 | `LLaMA-Factory/data/mllm_demo_data/1.mp4` |
| 385,746 | `LLaMA-Factory/data/mllm_demo_data/2.avi` |
| 270,849 | `LLaMA-Factory/data/mllm_demo_data/3.mp4` |
| 195,493 | `data/Researchy-GEO/key_point/879779.json` |
| 189,954 | `LLaMA-Factory/assets/wechat.jpg` |
| 172,660 | `LLaMA-Factory/assets/wechat_npu.jpg` |
| 135,658 | `data/Researchy-GEO/key_point/354532.json` |
| 129,024 | `LLaMA-Factory/data/mllm_demo_data/1.mp3` |
| 120,041 | `LLaMA-Factory/data/mllm_demo_data/3.flac` |
| 119,848 | `LLaMA-Factory/src/llamafactory/extras/constants.py` |
| 107,423 | `data/Researchy-GEO/key_point/923549.json` |
| 103,771 | `LLaMA-Factory/src/llamafactory/webui/locales.py` |
| 100,741 | `data/Researchy-GEO/key_point/921842.json` |
| 92,886 | `LLaMA-Factory/data/mllm_demo_data/2.wav` |
| 80,918 | `LLaMA-Factory/data/mllm_demo_data/4.mp3` |
| 78,611 | `LLaMA-Factory/src/llamafactory/data/template.py` |
| 76,052 | `data/Researchy-GEO/key_point/333606.json` |
| 73,598 | `LLaMA-Factory/src/llamafactory/data/mm_plugin.py` |
| 70,674 | `data/Researchy-GEO/key_point/981588.json` |
| 68,448 | `data/Researchy-GEO/key_point/471082.json` |

## Dependency, installer, Docker, and workflow review

- Root `requirements.txt:2-18` uses ranges or unpinned packages and has no lock
  or hashes. Provider SDKs, `datasets`, `huggingface-hub`, `transformers`,
  `requests`, and `python-dotenv` are runtime-relevant supply-chain surfaces.
- `install.sh:15-35` creates/activates a conda environment, upgrades pip,
  installs the un-hashed requirements, and copies `keys.env.example` to
  `keys.env`. It was not run and is excluded.
- `install_mini.sh:38-77` installs pinned and unpinned PyPI packages, downloads
  a GitHub-hosted wheel without a checksum (`:43`), and performs editable
  installs of the two bundled research frameworks. It was not run and is
  excluded.
- `run_cold_start.sh:26` and `run_grpo.sh:10` evaluate conda-generated shell
  code. The scripts launch training/model servers and write outputs/logs;
  `run_grpo.sh:103-104` force-kills the recorded process. They were not run and
  are excluded.
- `LLaMA-Factory/pyproject.toml:1-3` uses the standard setuptools backend.
  `LLaMA-Factory/setup.py:21-41,78-114` reads local metadata and registers
  console scripts; no custom `cmdclass`, `build_ext`, or post-install hook was
  found.
- `open-r1/setup.py:25-38` has a top-level install-time deletion of a scoped
  `open_r1.egg-info` path with `shutil.rmtree`. Its dependency list also includes
  a Git URL at a pinned commit (`:59`) and many un-hashed packages. This is
  explainable packaging cleanup, not evidence of malware, but it must not run in
  the web repository and is excluded.
- Four Dockerfiles and three compose files exist only under
  `LLaMA-Factory/docker`. They use mutable image tags, apt/pip network installs,
  editable package installs, and, in `Dockerfile.base:46-51`, GitHub wheel
  downloads without recorded checksums. Compose grants host IPC and GPU/device
  access. They are excluded.
- GitHub workflow files: none at the pinned tree.
- Filename-based download scripts: none. Download-capable runtime call sites
  still exist and are classified below.

## Static scan classification

Broad `git grep` over every tracked blob intentionally included documentation
and datasets. Raw hit counts were: code-execution terms 57; process-execution
terms 19; network terms 231; dynamic-loading terms 6; encoded-payload terms 20;
permission/secret terms 4,140; path/archive terms 16; packaging-hook terms 5.
Counts are not treated as findings by themselves: dataset prose and terms such
as “token”, regex `compile`, and `model.eval()` produce many false positives.

### `eval`, `exec`, `compile`, `marshal`, `pickle`, `torch.load`, `joblib`

- `autogeo/rewriters/mini.py:250` and `autogeo/utils/hf_model.py:49` are
  PyTorch `model.eval()` mode switches, not Python `eval`. No built-in `eval`,
  `exec`, `compile`, marshal, pickle, `torch.load`, or joblib use was found in
  `autogeo/**`.
- Excluded LLaMA-Factory has real checkpoint deserialization at
  `scripts/convert_ckpt/llamafy_baichuan2.py:35`,
  `src/llamafactory/model/model_utils/valuehead.py:52`,
  `src/llamafactory/train/callbacks.py:79`, and
  `tests/model/model_utils/test_visual.py:95`. Some calls do not enforce
  `weights_only=True`; untrusted checkpoints must never be loaded.
- Excluded open-r1 calls a remote sandbox API named `aexec` in
  `utils/competitive_programming/morph_client.py:158,179,203,382,385,394`.
  These execute build/run commands in a Morph instance and are not acceptable
  for the planned web runtime.
- Remaining raw hits are regex compilation, method/function names, docs, or
  dataset prose. No encoded text was found to flow into Python execution.

### `subprocess`, `os.system`, `shell=True`, `pty`

- The two `autogeo/**` hits are text only:
  `extract_rules.py:285` checks an exception string and `rules/utils.py:62` is a
  comment. No process launch occurs in that source layer.
- Excluded process launches exist in `LLaMA-Factory/src/llamafactory/cli.py:108,130`,
  `extras/env.py:81`, and web UI runner imports; comments at `cli.py:129` and
  `webui/runner.py:377` explicitly avoid `shell=True`.
- Excluded open-r1 launches `sinfo`, Piston/evaluation commands, and reward
  subprocesses at `utils/callbacks.py:31`, `utils/competitive_programming/piston_client.py:204`,
  `utils/evaluation.py:103`, and `rewards.py:910`.
- No actual `shell=True`, `os.system`, or PTY call was found in the reviewed
  code scope. Root shell scripts remain executable process orchestration and are
  excluded.

### Network and downloads

- `autogeo/loader/github_loader.py:38-64,103-109` requests GitHub API content,
  base64-decodes it, and writes files. The decoded bytes are not executed, but
  the destination/content lacks an independent hash allowlist.
- `autogeo/loader/data_loader.py:128-180` discovers and downloads Hugging Face
  datasets and writes reconstructed JSON.
- `autogeo/evaluation/evaluator.py:21` performs `nltk.download` at import time.
- `autogeo/rewriters/mini.py:61-70,243-249` and
  `autogeo/utils/hf_model.py:42-48` can resolve model IDs and set
  `trust_remote_code=True`. This is a high-risk runtime configuration if used
  with an unreviewed model repository; it was not invoked and must default to
  false in any future adapter.
- `autogeo/utils/{gemini,openai,anthropic}.py`,
  `autogeo/evaluation/generative_engine.py`, and the rules client contain real
  provider call paths. No provider call was made during this audit.
- Broad network-term hits in excluded LLaMA-Factory/open-r1 cover HTTP clients,
  hub/model downloads, remote code sandboxes, API/Web UI servers, and docs.
  They are ML/research-expected capabilities but outside this snapshot's
  execution boundary.

### Dynamic imports, native loading, and encoded payloads

- No `ctypes`, cffi, `importlib`, or dynamic `__import__` use was found in
  `autogeo/**`.
- Excluded LLaMA-Factory uses `importlib.metadata`/`importlib.util` only for
  installed-package discovery at `extras/packages.py:18-36`. Excluded open-r1
  has an `importlib` string in a source-code patch rule.
- `autogeo/loader/github_loader.py:107` is the only runtime base64 decode in
  `autogeo/**`; it writes GitHub JSON content and does not execute it.
- Excluded LLaMA-Factory API code decodes base64 image/video/audio into memory at
  `api/chat.py:121-144`. Excluded open-r1 encodes an evaluation prompt. No
  base64/base85/hex decode-then-execute chain was found.

### Permissions, home/SSH, environment, credentials, and secrets

- No `chmod`, `chown`, home-directory, or SSH access occurs in `autogeo/**`.
- `autogeo/evaluation/evaluator.py:22-23`,
  `evaluation/generative_engine.py:9-12`, `extract_rules.py:28`,
  `loader/cold_start_data.py:9`, and
  `utils/{anthropic,gemini,openai}.py:10-13` load `keys.env` and/or read provider
  environment variables. `generative_engine.py` instantiates all three provider
  clients at import time.
- `autogeo/rules/llm_client.py:40-72` temporarily mutates process-wide API-key
  environment variables. That is unsafe under concurrent service requests and
  must not be reused as-is.
- `autogeo/loader/github_loader.py:29-36` reads `GITHUB_TOKEN` and places it in
  an Authorization header. This is expected for a GitHub loader but not needed
  by the planned adapter.
- A redacted signature scan covered OpenAI, Anthropic, Google, GitHub, AWS, and
  private-key formats: 0 signatures. A generic credential-assignment heuristic
  produced 172 hits, dominated by ML “token” variables and environment lookups.
  The tracked `LLaMA-Factory/.env.local` has empty `API_KEY` and
  `WANDB_API_KEY` assignments; `keys.env.example:3,7` contains explicit
  placeholders. No secret value was printed or imported.
- Excluded open-r1 expands the user home in `utils/evaluation.py:17` and emits
  chmod commands for a remote Morph workspace at
  `utils/competitive_programming/morph_client.py:386,394,423,446,479,644-645`.

### Removal, traversal, archive extraction, and install/build hooks

- No tar/zip/archive extraction call exists in `autogeo/**` or the reviewed code
  scope. With no tracked archive, no archive input was available for an archive
  bomb.
- `autogeo/extract_rules.py:14` inserts a `../..`-derived path into `sys.path`;
  it is not archive traversal but broadens import resolution and should not be
  used in a service.
- Excluded training configuration references `../../data`; excluded
  `open-r1/setup.py:38` removes scoped stale egg metadata;
  `open-r1/src/grpo.py:118` removes a computed output path; and
  `morph_client.py:541` contains remote `rm -rf` in a generated sandbox script.
  These are contained research/training behaviors, excluded from import, and
  still require isolation if ever used.
- Packaging grep hits in LLaMA-Factory are standard console-script entry points.
  No custom build extension or arbitrary post-install command was found. The
  open-r1 top-level `rmtree` remains an install-time side effect and is excluded.

## Complete `autogeo/**` AST import and top-level review

Every one of the 35 Python files was decoded as UTF-8, parsed with `ast.parse`,
and compiled with `compile(..., flags=ast.PyCF_ONLY_AST)` without importing the
package or writing bytecode. Syntax errors: 0.

| Module | Imports | Top-level side effects observed |
| --- | --- | --- |
| `config.py` | `typing`, `enum` | none |
| `evaluate.py` | stdlib, `requests`, rewriters, loader, evaluation, config, logger | `sys.path.insert` at 11 |
| `evaluation/__init__.py` | evaluator, aggregate, generative engine | imports those modules; their effects follow |
| `evaluation/aggregate_results.py` | `os`, `json`, `typing` | none |
| `evaluation/evaluator.py` | stdlib, `openai`, `nltk`, `tqdm`, `dotenv`, metrics/generative/logger | path mutation 15; `nltk.download` 21; `load_dotenv` 22; env read 23 |
| `evaluation/generative_engine.py` | provider SDKs, `dotenv`, stdlib | `load_dotenv` 9; configure/instantiate Gemini/OpenAI/Anthropic clients 10-12 |
| `evaluation/metrics/__init__.py` | geo/geu metric exports | none |
| `evaluation/metrics/geo_score.py` | `math`, `itertools`, `re`, `nltk` | none |
| `evaluation/metrics/geu_score.py` | stdlib, `openai`, pydantic, `dotenv`, `tqdm` | env load/log setup 19-26; OpenAI client try at 28 |
| `extract_rules.py` | stdlib, pandas, `dotenv`, config/loader/rules/logger | path mutation 14; environment mutation 27; env load 28 |
| `loader/__init__.py` | all loader modules | imports those modules; their effects follow |
| `loader/cold_start_data.py` | JSON/filesystem, rewriter/config/utils/loader utils, `dotenv` | env load 9 |
| `loader/data_loader.py` | filesystem/JSON, Hugging Face datasets, config | local default-config construction 28 |
| `loader/github_loader.py` | `os`, `requests`, `base64`, `time`, `typing` | none before function calls |
| `loader/grpo_data.py` | JSON/filesystem, rewriter/config/loader utils | none |
| `loader/inference_data.py` | JSON/filesystem, rewriter/config/loader utils | none |
| `loader/rule_candidate_data.py` | JSON/filesystem, metrics/config | none |
| `loader/utils.py` | config | none |
| `rewriters/__init__.py` | core, API, mini | imports mini and its optional ML imports |
| `rewriters/api.py` | stdlib, `tqdm`, core/config/logger | none |
| `rewriters/core.py` | stdlib, config, utils, HF model | importing utils cascades into provider modules |
| `rewriters/mini.py` | stdlib, `tqdm`, transformers, evaluator; optional torch/vLLM | optional dependency imports at 12-24 |
| `rules/__init__.py` | explainer, extractor, merger, client, utils | imports all rule modules |
| `rules/explainer.py` | typing, LLM client | none |
| `rules/extractor.py` | JSON/regex/typing, LLM client | none |
| `rules/llm_client.py` | `os`, typing, provider utils | importing utils cascades into provider modules |
| `rules/merger.py` | time/JSON/concurrency/typing, LLM client | none |
| `rules/utils.py` | random/JSON/typing, Hugging Face datasets | none |
| `utils/__init__.py` | Gemini/OpenAI/Anthropic/logger/HF modules | imports provider modules and triggers their effects |
| `utils/anthropic.py` | stdlib, `dotenv`, Anthropic SDK, constants | env load 11 |
| `utils/constants.py` | none | none |
| `utils/gemini.py` | stdlib, `dotenv`, Gemini SDK, constants | env load 10; provider configuration 13 |
| `utils/hf_model.py` | typing, torch, transformers, evaluator | import cascades into evaluator network/env effects |
| `utils/logger.py` | logging/JSON/datetime/pathlib/typing | none until logger construction |
| `utils/openai.py` | stdlib, `dotenv`, OpenAI SDK, constants | env load 11 |

The import graph is therefore not safe for direct use in a web process even
though the source snapshot passed the malicious-indicator gate. Importing common
package entry points can cascade into environment reads, provider configuration,
and an NLTK download. The future adapter must live outside `vendor/**` and apply
the isolation rules in `ADAPTATION_BOUNDARY.md`.

## Scanner and check status

| Check | Status | Evidence / limitation |
| --- | --- | --- |
| Pinned SHA and live upstream main | PASS | detached HEAD and `ls-remote` both `49456df...` |
| License text/hash | PASS | pinned MIT text; SHA-256 recorded above |
| `git fsck --full` | PASS | exit 0, no diagnostics |
| Tree/mode/size/MIME/LFS/archive inventory | PASS | inventory above; this is classification, not malware detection |
| Python AST parse/compile | PASS | 35/35 source files; no import or bytecode |
| Redacted secret signature scan | PASS WITH LIMITATIONS | 0 known-format signatures; heuristic patterns cannot find every secret |
| ClamAV | NOT RUN | `clamscan` not installed |
| Semgrep | NOT RUN | `semgrep` not installed |
| OSV-Scanner | NOT RUN | `osv-scanner` not installed |
| pip-audit | NOT RUN | `pip-audit` not installed; no resolved dependency lock |
| gitleaks/trufflehog | NOT RUN | both CLIs not installed; custom redacted scan used instead |
| GPG commit verification | NOT RUN | `gpg` not installed |
| Upstream install/scripts/imports/models/providers | NOT RUN | prohibited by quarantine boundary |

## Import decision

Imported byte-for-byte:

- `LICENSE` as `LICENSE.autogeo` (1 file, 1,064 bytes)
- all 35 Python files under upstream `autogeo/**` as
  `vendor/autogeo/**` (238,468 bytes)

Excluded:

- all `data/**`: datasets and generated/research material; no rule JSON was
  proven necessary for the planned adapter;
- all `LLaMA-Factory/**` and `open-r1/**`: research/training frameworks with
  independent dependencies, network/process/model behavior, media, and data;
- root install/training shell scripts: executable environment/training actions;
- `keys.env.example` and tracked `LLaMA-Factory/.env.local`: environment-shaped
  files are not runtime source;
- `.gitignore`, README, Docker material, media, logs, archives, outputs,
  checkpoints, weights, caches, workflows, and LFS/model artifacts: not required
  runtime source or forbidden by policy.

No `vendor/rules/**` JSON was imported. The manifest records every imported
file, including the license. Vendored bytes must match the upstream pinned tree.

## Required next phase (not performed)

The next separately authorized phase is a Qwen/Bailian adapter plus an isolated
Python service runtime outside `vendor/**`. It must first neutralize import-time
effects, disable `trust_remote_code`, define a pinned dependency/container
artifact with vulnerability scanning, introduce explicit network and secret
boundaries, and add tests without contacting providers. No such connection,
runtime, optimization result, deployment, migration, or production readiness is
claimed by this snapshot.
