import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const notebookPath = resolve(__dirname, '../../colab/DiscoveryStack_SEO_GEO_101.ipynb')
const notebook = JSON.parse(readFileSync(notebookPath, 'utf8')) as {
  cells: Array<{ cell_type: string; source: string[] }>
}
const cellWith = (marker: string) => {
  const cell = notebook.cells.find(candidate => candidate.cell_type === 'code' && candidate.source.join('').includes(marker))
  expect(cell, `notebook cell containing ${marker}`).toBeDefined()
  return cell?.source.join('') ?? ''
}

describe('Google Colab v2 task-head classification contract', () => {
  it('declares exactly journeyStage and actionPriority as categorical single-label heads', () => {
    const setup = cellWith("MODEL_VERSION = 'seo-geo-multitask-colab-v2'")
    expect(setup).toContain("SINGLE_LABEL_TASKS = ['journeyStage', 'actionPriority']")
    expect(setup).toContain("MULTI_LABEL_TASKS = [task for task in TASKS if task not in SINGLE_LABEL_TASKS]")
    expect(setup).toContain("assert not isinstance(value, list), f'FAIL-CLOSED: {task} must have one categorical target'")
    expect(setup).toContain("assert isinstance(value, list), f'FAIL-CLOSED: {task} must have multi-label targets'")
  })

  it('encodes single-label targets as long class indices and preserves multi-label multi-hot vectors', () => {
    const model = cellWith('def collate(batch):')
    expect(model).toContain("labels[task] = torch.tensor([item[task] for item in batch], dtype=torch.long)")
    expect(model).toContain("target = torch.zeros((len(batch), len(label_maps[task])), dtype=torch.float32)")
    expect(model).toContain("target[row_index, item[task]] = 1.0")
  })

  it('uses CrossEntropyLoss plus softmax argmax only for categorical heads', () => {
    const training = cellWith('def compute_loss(logits, labels):')
    expect(training).toContain("for task in SINGLE_LABEL_TASKS:\n        task_losses.append(nn.functional.cross_entropy(logits[task], labels[task]))")
    expect(training).toContain("for task in MULTI_LABEL_TASKS:\n        task_losses.append(nn.functional.binary_cross_entropy_with_logits(logits[task], labels[task]))")
    expect(training).toContain("for task in SINGLE_LABEL_TASKS:\n                y = batch['labels'][task].detach().cpu().numpy().astype(int)\n                p = torch.softmax(logits[task], dim=-1).argmax(dim=-1).detach().cpu().numpy().astype(int)")
  })

  it('uses sigmoid thresholding only for multi-label heads and publishes a journeyStage confusion matrix', () => {
    const training = cellWith('def compute_loss(logits, labels):')
    expect(training).toContain("for task in MULTI_LABEL_TASKS:\n                y = batch['labels'][task].detach().cpu().numpy().astype(int)\n                p = (torch.sigmoid(logits[task]).detach().cpu().numpy() >= THRESHOLD).astype(int)")
    expect(training).toContain("metrics['journeyStageConfusionMatrix']")
    expect(training).toContain("confusion_matrix(np.concatenate(actual['journeyStage']), np.concatenate(predicted['journeyStage'])")
  })
})
