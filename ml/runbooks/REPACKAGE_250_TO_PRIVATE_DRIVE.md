# 250 筆模型與 artifact 重封裝 Runbook

目前 250 筆 Colab run 已完成訓練與舊版 artifact packaging；但 artifact 先前是透過 `files.download()` 送到使用者瀏覽器，Google Drive 尚未列出可供後續工程重用的 artifact ZIP。這份 runbook 用來把現有 runtime 的 checkpoint 與 metrics 再保存一份到 owner-only Drive，並且不把原始 JSONL 或 HTML 放進 ZIP。

## 目前基線

| 欄位 | 值 |
|---|---|
| Notebook | [DiscoveryStack SEO/GEO 250](https://colab.research.google.com/drive/1BuuoawYmZSGzSW_Voc6fUURsxWgISeuh) |
| model version | `seo-geo-multitask-colab-v3` |
| manifest hash | `c1b454ddf438d5346d28dbeebada7bc5fbeb8d705363eb7c06117e4eea9a226f` |
| dataset digest | `77f290729d7f3b9b9b2adc901eb0bd43c416aee96402b6990e25cecd7e8d6f37` |
| training rows | 250；train 184、validation 34、test 32 |
| checkpoint format | legacy `model_state_dict.pt` + tokenizer directory |
| artifact status | Colab download packaging 已執行；Drive persistence 需再執行下方 cell |

## Colab 追加 cell

在現有 250 Notebook 的最下方插入一個新的 code cell。這個 cell 不重跑訓練，只從既有 `artifact_dir` 或新建的 repack run 產生 ZIP，再以 private Drive API 保存。若 `artifact_dir`、`model`、`tokenizer`、`metrics` 或 `summary` 不存在，應停止並要求重新依序執行既有資料載入、驗證、模型與訓練 cells；不要用空目錄或新隨機模型冒充已訓練模型。

```python
# Repackage the current trained model; no raw data is included.
import hashlib, json, shutil, textwrap
from datetime import datetime, timezone
from pathlib import Path
from google.colab import auth
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

required = ['model', 'tokenizer', 'metrics', 'summary', 'EXPECTED_MANIFEST_HASH', 'DATASET_DIGEST']
missing = [name for name in required if name not in globals()]
assert not missing, f'FAIL-CLOSED: missing trained-runtime variables: {missing}'

repack_stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
repack_id = f'manifest-250-v3-repack-{EXPECTED_MANIFEST_HASH[:12]}-{repack_stamp}'
root = Path('/content/DiscoveryStack_training_artifacts') / repack_id
checkpoint = root / 'checkpoint'
checkpoint.mkdir(parents=True, exist_ok=False)
torch.save(model.state_dict(), checkpoint / 'model_state_dict.pt')
tokenizer.save_pretrained(checkpoint)
(checkpoint / 'model-definition.py').write_text(textwrap.dedent('''
import torch.nn as nn
from transformers import AutoModel

class MultiTaskModel(nn.Module):
    def __init__(self, model_id, task_label_maps, tasks):
        super().__init__()
        self.encoder = AutoModel.from_pretrained(model_id)
        hidden_size = self.encoder.config.hidden_size
        self.heads = nn.ModuleDict({task: nn.Linear(hidden_size, len(task_label_maps[task])) for task in tasks})

    def forward(self, input_ids, attention_mask):
        pooled = self.encoder(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state[:, 0]
        return {task: self.heads[task](pooled) for task in self.heads}
'''), encoding='utf-8')
(root / 'training-config.json').write_text(json.dumps(summary['trainingConfig'], ensure_ascii=False, indent=2), encoding='utf-8')
(root / 'metrics.json').write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding='utf-8')
(root / 'run-summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
(root / 'test-predictions.json').write_text(json.dumps(test_predictions, ensure_ascii=False, indent=2), encoding='utf-8')
(root / 'README.md').write_text('Legacy v3 development artifact. Raw JSONL and HTML intentionally excluded. Verify checksums before loading.', encoding='utf-8')

# Do not copy DATA_PATH or source cards.
zip_path = Path(shutil.make_archive('/content/discoverystack-ml-v3-repack', 'zip', root_dir=root.parent, base_dir=root.name))
assert zip_path.exists() and zip_path.stat().st_size > 100_000

# Private Drive upload. Do not add public permissions.
auth.authenticate_user()
drive = build('drive', 'v3')
metadata = {'name': f'discoverystack-ml-v3-repack-{EXPECTED_MANIFEST_HASH[:12]}.zip', 'description': 'Owner-only DiscoveryStack 250 training artifact; no raw dataset'}
created = drive.files().create(body=metadata, media_body=MediaFileUpload(str(zip_path), mimetype='application/zip'), fields='id,name,size,webViewLink').execute()
print({'privateDriveArtifact': True, 'file': created, 'zipBytes': zip_path.stat().st_size, 'manifestHash': EXPECTED_MANIFEST_HASH, 'datasetDigest': DATASET_DIGEST})
```

## 重封裝後檢查

Drive 搜尋結果應只出現一個同名的 private ZIP；不要建立公開權限。下載後先驗證 SHA-256，再用 repo 的 `ml/packaging/package_artifact.py` 將內容轉為 allow-list bundle。250 v3 的 `model_state_dict.pt` 是 legacy pickle checkpoint；只從自己的私有 artifact 讀取，500 v4 起應改為 Transformers-compatible `safetensors` checkpoint。

## 不可接受的結果

若 cell 顯示 missing runtime variables、checkpoint 不存在、ZIP 小於預期、Drive 出現兩個同名檔、或 file permission 不是 owner-only，都標記 `artifact_recovery_failed`，不可把 notebook 內的 metrics JSON 當作模型 checkpoint。此情況需要重新執行 250 Notebook 的資料載入、驗證、smoke test、訓練與 packaging。
