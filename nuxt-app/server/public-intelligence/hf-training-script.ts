export const HF_TRAINING_SCRIPT = String.raw`
set -euo pipefail
python -m pip install --quiet --no-cache-dir "transformers>=4.45,<5" "datasets>=2.20,<4" "accelerate>=0.33,<2" "huggingface_hub>=0.27,<2" "torch>=2.2,<3" "numpy>=1.26,<3"
cat > /tmp/discoverystack_train.py <<'PY'
import base64
import inspect
import json
import os
from pathlib import Path

import numpy as np
from datasets import load_dataset
from huggingface_hub import HfApi
from transformers import AutoModelForSequenceClassification, AutoTokenizer, Trainer, TrainingArguments


def result(payload):
    print("DISCOVERYSTACK_RESULT=" + json.dumps(payload, sort_keys=True))


try:
    encoded = os.environ["DISCOVERYSTACK_DATASET_B64"]
    records = [json.loads(line) for line in base64.b64decode(encoded).decode("utf-8").splitlines() if line.strip()]
    labels = ["discovery", "understanding", "response", "progression", "conversion"]
    label_to_id = {label: index for index, label in enumerate(labels)}
    workdir = Path("/tmp/discoverystack-data")
    workdir.mkdir(parents=True, exist_ok=True)
    for split in ["train", "validation", "test"]:
        split_records = [row for row in records if row["split"] == split]
        (workdir / f"{split}.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in split_records), encoding="utf-8")
    dataset = load_dataset("json", data_files={split: str(workdir / f"{split}.jsonl") for split in ["train", "validation", "test"]})
    base_model = os.environ["HUGGINGFACE_BASE_MODEL_ID"]
    model_repo = os.environ["HUGGINGFACE_MODEL_REPO"]
    tokenizer = AutoTokenizer.from_pretrained(base_model, token=os.environ["HF_TOKEN"])
    model = AutoModelForSequenceClassification.from_pretrained(base_model, num_labels=len(labels), id2label={i: label for i, label in enumerate(labels)}, label2id=label_to_id, token=os.environ["HF_TOKEN"])

    def tokenize(batch):
        return tokenizer(batch["text"], truncation=True, padding="max_length", max_length=256)

    tokenized = dataset.map(tokenize, batched=True)
    tokenized = tokenized.map(lambda batch: {"labels": [label_to_id[value] for value in batch["label"]]}, batched=True)
    columns = ["input_ids", "attention_mask", "labels"]
    if "token_type_ids" in tokenized["train"].column_names:
        columns.append("token_type_ids")
    tokenized.set_format(type="torch", columns=columns)

    def compute_metrics(eval_pred):
        logits, labels_array = eval_pred
        predictions = np.argmax(logits, axis=-1)
        accuracy = float(np.mean(predictions == labels_array)) if len(labels_array) else 0.0
        f1_values = []
        for label_id in range(len(labels)):
            tp = int(np.sum((predictions == label_id) & (labels_array == label_id)))
            fp = int(np.sum((predictions == label_id) & (labels_array != label_id)))
            fn = int(np.sum((predictions != label_id) & (labels_array == label_id)))
            precision = tp / (tp + fp) if tp + fp else 0.0
            recall = tp / (tp + fn) if tp + fn else 0.0
            f1_values.append((2 * precision * recall / (precision + recall)) if precision + recall else 0.0)
        return {"accuracy": round(accuracy, 4), "macro_f1": round(float(np.mean(f1_values)), 4)}

    output_dir = "/tmp/discoverystack-model"
    argument_values = {
        "output_dir": output_dir,
        "num_train_epochs": int(os.environ.get("DISCOVERYSTACK_EPOCHS", "2")),
        "per_device_train_batch_size": 8,
        "per_device_eval_batch_size": 8,
        "learning_rate": 2e-5,
        "weight_decay": 0.01,
        "logging_steps": 10,
        "save_strategy": "no",
        "report_to": "none",
        "load_best_model_at_end": False,
    }
    parameters = inspect.signature(TrainingArguments.__init__).parameters
    argument_values["eval_strategy" if "eval_strategy" in parameters else "evaluation_strategy"] = "epoch"
    training_args = TrainingArguments(**argument_values)
    trainer = Trainer(model=model, args=training_args, train_dataset=tokenized["train"], eval_dataset=tokenized["validation"], tokenizer=tokenizer, compute_metrics=compute_metrics)
    trainer.train()
    validation_metrics = trainer.evaluate(tokenized["validation"], metric_key_prefix="validation")
    test_metrics = trainer.evaluate(tokenized["test"], metric_key_prefix="test")
    trainer.save_model(output_dir)
    tokenizer.save_pretrained(output_dir)
    api = HfApi(token=os.environ["HF_TOKEN"])
    api.create_repo(repo_id=model_repo, repo_type="model", private=True, exist_ok=True)
    api.upload_folder(folder_path=output_dir, repo_id=model_repo, repo_type="model", commit_message="Upload DiscoveryStack supervised training artifact")
    def metric_block(metrics):
        def pick(name):
            for candidate in [f"eval_{name}", f"validation_{name}", f"test_{name}", name]:
                if candidate in metrics:
                    return round(float(metrics[candidate]), 4)
            return None
        return {"accuracy": pick("accuracy"), "macroF1": pick("macro_f1")}

    result({
        "status": "completed",
        "engine": "huggingface_transformers_trainer",
        "baseModel": base_model,
        "modelRepo": model_repo,
        "labels": labels,
        "exampleCount": len(records),
        "splitCounts": {split: sum(1 for row in records if row["split"] == split) for split in ["train", "validation", "test"]},
        "metrics": {"validation": metric_block(validation_metrics), "test": metric_block(test_metrics)},
    })
except Exception as error:
    result({"status": "failed", "engine": "huggingface_transformers_trainer", "error": type(error).__name__})
    raise
`
