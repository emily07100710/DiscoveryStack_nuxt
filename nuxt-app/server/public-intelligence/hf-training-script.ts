export const HF_TRAINING_SCRIPT = String.raw`
set -euo pipefail
python -m pip install --quiet --no-cache-dir "transformers>=4.45,<5" "huggingface_hub>=0.27,<2" "torch>=2.2,<3" "numpy>=1.26,<3"
cat > /tmp/discoverystack_train.py <<'PY'
import base64
import json
import os
import random
from pathlib import Path

import numpy as np
import torch
from huggingface_hub import HfApi
from torch import nn
from transformers import AutoModel, AutoTokenizer


def result(payload):
    print("DISCOVERYSTACK_RESULT=" + json.dumps(payload, sort_keys=True))


TASK_TYPES = {
    "journeyStage": "single",
    "searchIntents": "multi",
    "contentTypes": "multi",
    "audienceRoles": "multi",
    "geoSignals": "multi",
    "citationReadiness": "multi",
    "technicalSeoSignals": "multi",
    "frictionSignals": "multi",
    "actionPriority": "single",
}


def target_value(record, task):
    return (record.get("targets") or {}).get(task)


def f1_binary(predicted, actual):
    tp = int(np.sum((predicted == 1) & (actual == 1)))
    fp = int(np.sum((predicted == 1) & (actual == 0)))
    fn = int(np.sum((predicted == 0) & (actual == 1)))
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    return (2 * precision * recall / (precision + recall)) if precision + recall else 0.0


try:
    encoded = os.environ["DISCOVERYSTACK_DATASET_B64"]
    records = [json.loads(line) for line in base64.b64decode(encoded).decode("utf-8").splitlines() if line.strip()]
    if not records:
        raise ValueError("No approved records were supplied.")

    label_values = {}
    for task, task_type in TASK_TYPES.items():
        observed = []
        for record in records:
            value = target_value(record, task)
            if isinstance(value, list):
                observed.extend(str(item) for item in value)
            elif value is not None:
                observed.append(str(value))
        label_values[task] = sorted(set(observed))
        if not label_values[task]:
            raise ValueError(f"No approved labels are available for task {task}.")

    base_model = os.environ["HUGGINGFACE_BASE_MODEL_ID"]
    model_repo = os.environ["HUGGINGFACE_MODEL_REPO"]
    tokenizer = AutoTokenizer.from_pretrained(base_model, token=os.environ["HF_TOKEN"])
    encoder = AutoModel.from_pretrained(base_model, token=os.environ["HF_TOKEN"])
    hidden_size = int(getattr(encoder.config, "hidden_size"))

    class MultiTaskModel(nn.Module):
        def __init__(self):
            super().__init__()
            self.encoder = encoder
            self.dropout = nn.Dropout(0.1)
            self.heads = nn.ModuleDict({task: nn.Linear(hidden_size, len(values)) for task, values in label_values.items()})

        def forward(self, inputs):
            outputs = self.encoder(**inputs)
            pooled = outputs.last_hidden_state[:, 0]
            pooled = self.dropout(pooled)
            return {task: head(pooled) for task, head in self.heads.items()}

    def encode_rows(rows):
        text = [str(row["text"]) for row in rows]
        encoded_batch = tokenizer(text, truncation=True, padding=True, max_length=256, return_tensors="pt")
        return encoded_batch

    def task_target_batch(rows, task, device):
        valid_positions = []
        values = []
        for position, row in enumerate(rows):
            value = target_value(row, task)
            if value is None:
                continue
            valid_positions.append(position)
            values.append(value)
        if not valid_positions:
            return None, None
        mapping = {label: index for index, label in enumerate(label_values[task])}
        positions = torch.tensor(valid_positions, dtype=torch.long, device=device)
        if TASK_TYPES[task] == "single":
            return positions, torch.tensor([mapping[str(value)] for value in values], dtype=torch.long, device=device)
        target = torch.zeros((len(values), len(mapping)), dtype=torch.float32, device=device)
        for row_index, labels in enumerate(values):
            for label in labels:
                if str(label) in mapping:
                    target[row_index, mapping[str(label)]] = 1.0
        return positions, target

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = MultiTaskModel().to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-5, weight_decay=0.01)
    single_loss = nn.CrossEntropyLoss()
    multi_loss = nn.BCEWithLogitsLoss()
    train_rows = [row for row in records if row.get("split") == "train"]
    validation_rows = [row for row in records if row.get("split") == "validation"]
    test_rows = [row for row in records if row.get("split") == "test"]
    if not train_rows or not validation_rows or not test_rows:
        raise ValueError("Approved manifest must include non-empty train, validation and test splits.")

    task_support = {task: sum(1 for row in records if target_value(row, task) is not None) for task in TASK_TYPES}
    epochs = int(os.environ.get("DISCOVERYSTACK_EPOCHS", "2"))
    batch_size = 8
    model.train()
    for _ in range(epochs):
        random.shuffle(train_rows)
        for start in range(0, len(train_rows), batch_size):
            batch = train_rows[start:start + batch_size]
            inputs = {key: value.to(device) for key, value in encode_rows(batch).items()}
            outputs = model(inputs)
            losses = []
            for task in TASK_TYPES:
                positions, target = task_target_batch(batch, task, device)
                if positions is None:
                    continue
                logits = outputs[task].index_select(0, positions)
                losses.append(single_loss(logits, target) if TASK_TYPES[task] == "single" else multi_loss(logits, target))
            if not losses:
                continue
            optimizer.zero_grad()
            torch.stack(losses).mean().backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()

    def evaluate(rows):
        model.eval()
        gathered = {task: {"predicted": [], "actual": []} for task in TASK_TYPES}
        with torch.no_grad():
            for start in range(0, len(rows), batch_size):
                batch = rows[start:start + batch_size]
                inputs = {key: value.to(device) for key, value in encode_rows(batch).items()}
                outputs = model(inputs)
                for task in TASK_TYPES:
                    positions, target = task_target_batch(batch, task, device)
                    if positions is None:
                        continue
                    logits = outputs[task].index_select(0, positions)
                    if TASK_TYPES[task] == "single":
                        gathered[task]["predicted"].extend(torch.argmax(logits, dim=1).cpu().tolist())
                        gathered[task]["actual"].extend(target.cpu().tolist())
                    else:
                        gathered[task]["predicted"].append((torch.sigmoid(logits) >= 0.5).int().cpu().numpy())
                        gathered[task]["actual"].append(target.int().cpu().numpy())
        metrics = {}
        for task, values in gathered.items():
            support = task_support[task]
            if not values["actual"]:
                metrics[task] = {"kind": TASK_TYPES[task], "support": 0, "metrics": None}
                continue
            if TASK_TYPES[task] == "single":
                predicted = np.array(values["predicted"])
                actual = np.array(values["actual"])
                per_label = [f1_binary((predicted == index).astype(int), (actual == index).astype(int)) for index in range(len(label_values[task]))]
                metrics[task] = {"kind": "single", "support": support, "accuracy": round(float(np.mean(predicted == actual)), 4), "macroF1": round(float(np.mean(per_label)), 4), "labels": label_values[task]}
            else:
                predicted = np.concatenate(values["predicted"], axis=0)
                actual = np.concatenate(values["actual"], axis=0)
                per_label = [f1_binary(predicted[:, index], actual[:, index]) for index in range(predicted.shape[1])]
                metrics[task] = {"kind": "multi", "support": support, "macroF1": round(float(np.mean(per_label)), 4), "labels": label_values[task]}
        return metrics

    validation_metrics = evaluate(validation_rows)
    test_metrics = evaluate(test_rows)
    output_dir = Path("/tmp/discoverystack-model")
    output_dir.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), output_dir / "pytorch_model.bin")
    tokenizer.save_pretrained(output_dir)
    (output_dir / "multitask_config.json").write_text(json.dumps({"architecture": "shared_encoder_multitask", "baseModel": base_model, "taxonomyVersion": "seo-geo-journey-v1", "taskTypes": TASK_TYPES, "labelValues": label_values, "taskSupport": task_support}, indent=2, sort_keys=True), encoding="utf-8")
    api = HfApi(token=os.environ["HF_TOKEN"])
    api.create_repo(repo_id=model_repo, repo_type="model", private=True, exist_ok=True)
    api.upload_folder(folder_path=output_dir, repo_id=model_repo, repo_type="model", commit_message="Upload DiscoveryStack SEO/GEO multi-task training artifact")
    result({
        "status": "completed",
        "engine": "shared_encoder_multitask",
        "baseModel": base_model,
        "modelRepo": model_repo,
        "taxonomyVersion": "seo-geo-journey-v1",
        "taskHeads": {task: {"kind": TASK_TYPES[task], "labels": label_values[task], "support": task_support[task]} for task in TASK_TYPES},
        "exampleCount": len(records),
        "splitCounts": {split: sum(1 for row in records if row.get("split") == split) for split in ["train", "validation", "test"]},
        "metrics": {"validation": validation_metrics, "test": test_metrics},
    })
except Exception as error:
    result({"status": "failed", "engine": "shared_encoder_multitask", "error": type(error).__name__})
    raise
PY
python /tmp/discoverystack_train.py
`
