from __future__ import annotations
import json
from pathlib import Path

SOURCE = Path('/home/ubuntu/private_training/DiscoveryStack_SEO_GEO_500_OPTIMIZED.ipynb')
OUT = Path('/home/ubuntu/private_training/DiscoveryStack_SEO_GEO_500_OPTIMIZED_RECOVERY.ipynb')

nb = json.loads(SOURCE.read_text(encoding='utf-8'))

def source_text(cell):
    return ''.join(cell.get('source', []))

def set_source(cell, text):
    cell['source'] = [line + '\n' for line in text.splitlines()]
    cell['execution_count'] = None
    cell['outputs'] = []

# Make the environment cell idempotent and self-contained. Do not use the old runtime state.
setup_idx = next(i for i,c in enumerate(nb['cells']) if "from pathlib import Path" in source_text(c) and "AutoModel" in source_text(c))
setup = source_text(nb['cells'][setup_idx])
setup = setup.replace("!pip -q install transformers scikit-learn sentencepiece safetensors\n!nvidia-smi\n\n", """# Recovery environment: install only missing packages, then prove the runtime is usable.
import importlib.util, subprocess, sys
required = {'transformers': 'transformers', 'sklearn': 'scikit-learn', 'sentencepiece': 'sentencepiece', 'safetensors': 'safetensors'}
missing = [package for module, package in required.items() if importlib.util.find_spec(module) is None]
if missing:
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', '-q', *missing])
print({'dependency_check': True, 'installed_missing': missing}, flush=True)
!nvidia-smi

""")
setup = setup.replace("print({'model': MODEL_ID, 'device': str(DEVICE), 'rows': EXPECTED_ROW_COUNT, 'seeds': SEEDS})", "print({'imports_ready': True, 'model': MODEL_ID, 'device': str(DEVICE), 'rows': EXPECTED_ROW_COUNT, 'seeds': SEEDS}, flush=True)")
set_source(nb['cells'][setup_idx], setup)

# Add an explicit model-definition and one-batch forward/backward gate immediately after model class cell.
model_idx = next(i for i,c in enumerate(nb['cells']) if "class MultiTaskModelV4" in source_text(c))
smoke_md = {
    'cell_type': 'markdown', 'metadata': {},
    'source': [line + '\n' for line in """## Recovery gate: model definition and one-batch smoke test

這個 cell 必須在正式訓練前成功。它會重新建立一個模型、取一個 training batch，完成 forward、loss 與 backward，並輸出 `model_definition_ready` 與 `smoke_train_batch_ready`。若任一輸出缺失，停止，不要執行正式訓練。""".splitlines()]
}
smoke_code = {
    'cell_type': 'code', 'execution_count': None, 'metadata': {}, 'outputs': [],
    'source': [line + '\n' for line in """# One-batch smoke test: this is intentionally before train_one/full ablation.
smoke_model = MultiTaskModelV4(MODEL_ID, label_maps, len(FEATURE_NAMES), use_stage_features=True).to(DEVICE)
print({'model_definition_ready': True, 'device': str(DEVICE), 'featureDim': len(FEATURE_NAMES)}, flush=True)
smoke_loader = DataLoader(MultiTaskDataset(indices_by_split['train'][:8]), batch_size=min(BATCH_SIZE, 8), shuffle=False)
smoke_batch = batch_to_device(next(iter(smoke_loader)))
smoke_logits = smoke_model(smoke_batch['input_ids'], smoke_batch['attention_mask'], smoke_batch['stage_features'])
smoke_loss = 2.0 * nn.functional.cross_entropy(smoke_logits['journeyStage'], smoke_batch['journeyStage'])
for _task in MULTI_LABEL_TASKS:
    smoke_loss = smoke_loss + nn.functional.binary_cross_entropy_with_logits(smoke_logits[_task], smoke_batch[_task])
smoke_loss = smoke_loss + nn.functional.cross_entropy(smoke_logits['actionPriority'], smoke_batch['actionPriority'])
smoke_loss.backward()
print({'smoke_train_batch_ready': True, 'batchSize': int(smoke_batch['input_ids'].shape[0]), 'seqLength': int(smoke_batch['input_ids'].shape[1]), 'lossFinite': bool(torch.isfinite(smoke_loss).item())}, flush=True)
del smoke_model, smoke_loader, smoke_batch, smoke_logits, smoke_loss
torch.cuda.empty_cache()""".splitlines()]
}
nb['cells'][model_idx+1:model_idx+1] = [smoke_md, smoke_code]

# Modify training cell to expose progress and support a truthful fast path or full ablation.
train_idx = next(i for i,c in enumerate(nb['cells']) if "configs = [('text_only_baseline'" in source_text(c))
train = source_text(nb['cells'][train_idx])
train = train.replace("    for epoch in range(1, MAX_EPOCHS + 1):", "    for epoch in range(1, TRAIN_MAX_EPOCHS + 1):")
train = train.replace("    model = MultiTaskModelV4(MODEL_ID, label_maps, len(FEATURE_NAMES), use_stage_features=use_stage_features).to(DEVICE)", "    print({'run_start': True, 'config': config_name, 'seed': seed, 'maxEpochs': TRAIN_MAX_EPOCHS}, flush=True)\n    model = MultiTaskModelV4(MODEL_ID, label_maps, len(FEATURE_NAMES), use_stage_features=use_stage_features).to(DEVICE)")
train = train.replace("        model.train(); total = 0.0", "        model.train(); total = 0.0\n        print({'epoch_start': True, 'config': config_name, 'seed': seed, 'epoch': epoch}, flush=True)")
train = train.replace("        history.append(record); print({'config': config_name, 'seed': seed, 'epoch': epoch, 'trainLoss': record['trainLoss'], 'valMacroF1': val['macroF1'], 'valPredictedSupport': val['predictedSupport']})", "        history.append(record); print({'epoch_complete': True, 'config': config_name, 'seed': seed, 'epoch': epoch, 'trainLoss': record['trainLoss'], 'valMacroF1': val['macroF1'], 'valPredictedSupport': val['predictedSupport']}, flush=True)")
old = "configs = [('text_only_baseline', False, False), ('stage_branch_weighted', True, True)]\nrun_root = Path('/content/optimized_runs_v4'); shutil.rmtree(run_root, ignore_errors=True); run_root.mkdir(parents=True)\nrun_records = []; run_paths = []\nfor config_name, use_stage_features, use_class_weight in configs:\n    for seed in SEEDS:"
new = """# Default is a bounded, observable fast path. Set RUN_MODE='full_ablation' only after the smoke gate passes.
RUN_MODE = 'fast_path'  # 'fast_path' = one weighted branch / one seed / max 2 epochs; 'full_ablation' = 2 configs x 3 seeds x 8 epochs
if RUN_MODE == 'full_ablation':
    configs = [('text_only_baseline', False, False), ('stage_branch_weighted', True, True)]
    SEEDS_TO_RUN = SEEDS
    TRAIN_MAX_EPOCHS = MAX_EPOCHS
else:
    configs = [('stage_branch_weighted', True, True)]
    SEEDS_TO_RUN = [SEEDS[0]]
    TRAIN_MAX_EPOCHS = 2
print({'training_mode': RUN_MODE, 'configs': configs, 'seeds': SEEDS_TO_RUN, 'maxEpochs': TRAIN_MAX_EPOCHS}, flush=True)
run_root = Path('/content/optimized_runs_v4_recovery'); shutil.rmtree(run_root, ignore_errors=True); run_root.mkdir(parents=True)
run_records = []; run_paths = []
for config_name, use_stage_features, use_class_weight in configs:
    for seed in SEEDS_TO_RUN:"""
if old not in train:
    raise RuntimeError('training loop anchor not found')
train = train.replace(old, new)
train = train.replace("print({'selected': selected, 'candidateCount': len(run_records)})", "print({'selected': selected, 'candidateCount': len(run_records), 'training_complete': True, 'training_mode': RUN_MODE}, flush=True)")
set_source(nb['cells'][train_idx], train)

# Add a warning before training, and make metadata identify the recovery artifact.
train_idx = next(i for i,c in enumerate(nb['cells']) if "RUN_MODE = 'fast_path'" in source_text(c))
nb['cells'][train_idx:train_idx] = [{
    'cell_type':'markdown','metadata':{},
    'source':[line+'\n' for line in """## Formal training: truthful run mode

預設為 `fast_path`，只跑 `stage_branch_weighted`、seed `20260820`、最多 2 epochs；這是可觀察的快速候選，不等同原定 2 configs × 3 seeds 的完整 ablation。若 T4、smoke test 與第一個 run 都穩定，將本 cell 的 `RUN_MODE` 改為 `full_ablation` 後由新鮮 runtime 重新執行，才可產生完整比較結果。所有選模仍只使用 validation `journeyStage` macro-F1，`test_v2` 不得用於調參。""".splitlines()]
}]

nb['metadata'].setdefault('discoverystackTraining', {})['recoveryNotebook'] = True
nb['metadata']['discoverystackTraining']['runModeDefault'] = 'fast_path'
nb['metadata']['discoverystackTraining']['smokeGate'] = 'imports_ready, model_definition_ready, smoke_train_batch_ready'
nb['metadata']['colab'] = {'name': 'DiscoveryStack SEO GEO 500 optimized recovery'}
OUT.write_text(json.dumps(nb, ensure_ascii=False, indent=2), encoding='utf-8')
print(OUT)
