<script setup lang="ts">
import { computed, defineProps, ref } from 'vue'

const props = defineProps<{ locale: 'en' | 'zh-hant' }>()
const isZh = computed(() => props.locale === 'zh-hant')
const activeModelLayerIndex = ref<number | null>(null)
const activeModelGovernanceIndex = ref<number | null>(null)
const modelTaskHeadsOpen = ref(false)
const modelLayers = computed(() => isZh.value
  ? [
      { code: '01 / SIGNAL CONTRACT', title: '先把網站轉成可計算的訊號。', stack: 'page_manifest · entity_map · topic_map · technical_seo', desc: '將抓取、索引、內容實體、主題群與技術 SEO 統一成版本化 Feature Contract，避免模型只讀一堆沒有結構的文字。' },
      { code: '02 / RETRIEVAL BASELINE', title: '建立語意檢索與相似度基線。', stack: 'BGE-M3 · embeddings · de-identified aggregates', desc: '用去識別後的特徵聚合建立向量表徵與 retrieval baseline；原始頁面內容不會未經治理就直接進入訓練資料。' },
      { code: '03 / SUPERVISED MULTI-TASK', title: '共享編碼器，同時學九種判斷。', stack: 'multilingual DistilBERT · shared encoder · 9 task heads', desc: '在多語基礎模型上進行 supervised fine-tuning，同步預測旅程階段、搜尋意圖、引用準備度、摩擦訊號與行動優先序。' },
      { code: '04 / DECISION ORCHESTRATION', title: '模型輸出，最後仍由策略負責。', stack: 'friction signals · action priority · human-in-the-loop', desc: '把預測轉成可執行的 SEO／GEO 與轉換工作；策略師覆核證據、風險與商業脈絡後，才進入客戶決策。' },
    ]
  : [
      { code: '01 / SIGNAL CONTRACT', title: 'Turn the website into computable signals.', stack: 'page_manifest · entity_map · topic_map · technical_seo', desc: 'Crawl, indexation, entities, topic clusters and technical SEO become a versioned feature contract—not an unstructured pile of text.' },
      { code: '02 / RETRIEVAL BASELINE', title: 'Establish semantic retrieval baselines.', stack: 'BGE-M3 · embeddings · de-identified aggregates', desc: 'De-identified feature aggregates form embeddings and retrieval baselines; raw page content does not enter training without governance.' },
      { code: '03 / SUPERVISED MULTI-TASK', title: 'One shared encoder, nine concurrent judgements.', stack: 'multilingual DistilBERT · shared encoder · 9 task heads', desc: 'Supervised fine-tuning predicts journey stage, search intent, citation readiness, friction signals and action priority together.' },
      { code: '04 / DECISION ORCHESTRATION', title: 'The model informs; strategists remain accountable.', stack: 'friction signals · action priority · human-in-the-loop', desc: 'Predictions become executable SEO/GEO and conversion work only after evidence, risk and commercial context are reviewed.' },
    ])
const modelGovernance = computed(() => isZh.value
  ? [
      { term: 'DATASET LINEAGE', value: 'Approved manifest', detail: 'manifestHash / datasetDigest', desc: '每一批資料都必須先形成核准清單，並以摘要值留下來源與內容版本；事後可以追查模型到底學過哪一版資料。' },
      { term: 'VERSION CONTROL', value: '三層契約版本', detail: 'feature / taxonomy / split', desc: '特徵定義、標籤分類與資料切分各自版本化，避免模型成效改變時，團隊卻不知道究竟是哪一層發生差異。' },
      { term: 'EVALUATION', value: '獨立驗證與測試集', detail: 'accuracy / macro-F1', desc: '訓練資料不等於考題。模型必須在未參與訓練的驗證集與測試集上評估，並同時觀察 accuracy 與類別平衡後的 macro-F1。' },
      { term: 'MODEL REGISTRY', value: 'Private artifact', detail: 'job status / version history', desc: '遠端訓練完成並產生私有模型 artifact 後，才會登錄為可用版本；只送出 training job 不代表已經訓練成功。' },
      { term: 'GOVERNANCE GATES', value: '五道資料閘門', detail: 'consent / quality / PII / policy / review', desc: '資料需依序通過同意、品質、個資、政策與人工覆核，沒有因為能被抓到，就自動取得拿來訓練的資格。' },
    ]
  : [
      { term: 'DATASET LINEAGE', value: 'Approved manifest', detail: 'manifestHash / datasetDigest', desc: 'Every dataset batch is approved and hashed so the exact source and content version used by the model remains traceable.' },
      { term: 'VERSION CONTROL', value: 'Three versioned contracts', detail: 'feature / taxonomy / split', desc: 'Feature definitions, label taxonomy and data splits are versioned independently, making performance changes explainable.' },
      { term: 'EVALUATION', value: 'Held-out validation and test', detail: 'accuracy / macro-F1', desc: 'Training data is not the exam. Performance is evaluated against held-out sets using both accuracy and class-balanced macro-F1.' },
      { term: 'MODEL REGISTRY', value: 'Private artifact', detail: 'job status / version history', desc: 'A model becomes available only after the remote job finishes and produces a private artifact; starting a job does not count as training success.' },
      { term: 'GOVERNANCE GATES', value: 'Five data gates', detail: 'consent / quality / PII / policy / review', desc: 'Data must pass consent, quality, privacy, policy and human-review gates before it is eligible for learning.' },
    ])
const modelTaskHeads = computed(() => isZh.value ? ['旅程階段', '搜尋意圖', '內容型態', '受眾角色', 'GEO 訊號', '引用準備度', '技術 SEO', '摩擦訊號', '行動優先序'] : ['Journey stage', 'Search intent', 'Content type', 'Audience role', 'GEO signals', 'Citation readiness', 'Technical SEO', 'Friction signals', 'Action priority'])
const modelTerms = ['ENTITY MAP', 'CITATION READINESS', 'MULTI-TASK LEARNING', 'MACRO-F1', 'DATASET LINEAGE', 'HUMAN-IN-THE-LOOP']
</script>

<template>
  <section class="section model-proof" id="model">
    <div class="shell">
      <header class="model-proof-head reveal">
        <div><p class="eyebrow">{{ isZh ? '受治理的搜尋情報研發 · DEVELOPMENT POC' : 'GOVERNED SEARCH INTELLIGENCE · DEVELOPMENT POC' }}</p><h2><span>{{ isZh ? '少一點猜測，多一點證據' : 'Less guesswork. More evidence.' }}</span><span>{{ isZh ? '先看見訊號，再決定下一筆預算。' : 'See the signal before spending the next dollar.' }}</span></h2></div>
        <div class="model-proof-intro"><p class="model-proof-position">{{ isZh ? '不是把 AI 接上網站就算完成；我們先把資料、標籤與評估流程做成可追溯的研發系統。' : 'Connecting AI to a website is not the finish line. We first make data, labels and evaluation traceable as a governed research system.' }}</p><p>{{ isZh ? '目前已完成 101 筆資料的開發概念驗證，但尚未達正式模型門檻，也未用於客戶網站推論。這裡公開的是 Feature Contract、training manifest、multi-task learning 與 model registry 的研發方法。' : 'A 101-example development proof of concept is complete, but it has not met the production-model gate and is not used for customer-site inference. This section shows the research method across feature contracts, training manifests, multi-task learning and a model registry.' }}</p><div class="model-proof-stamps" aria-label="Model operating principles"><span>101-EXAMPLE DEVELOPMENT POC</span><span>PRODUCTION GATE NOT MET</span><span>HUMAN-IN-THE-LOOP</span></div></div>
      </header>
      <div class="model-proof-board">
        <section class="model-pipeline" :aria-label="isZh ? '模型處理管線' : 'Model pipeline'"><header class="model-board-title"><div><span>ARCHITECTURE / 04 LAYERS</span><h3>{{ isZh ? '搜尋情報模型管線' : 'Search intelligence pipeline' }}</h3></div><p><i aria-hidden="true"></i>{{ isZh ? '版本化架構' : 'Versioned architecture' }}</p></header><ol><li v-for="(layer, index) in modelLayers" :key="layer.code" class="model-pipeline-layer" :class="{ 'is-open': activeModelLayerIndex === index }"><button class="model-layer-trigger" type="button" :aria-expanded="activeModelLayerIndex === index" :aria-controls="`model-layer-detail-${index}`" @click="activeModelLayerIndex = activeModelLayerIndex === index ? null : index"><span class="model-layer-index">{{ layer.code.slice(0, 2) }}</span><span class="model-layer-copy"><small>{{ layer.code.slice(5) }}</small><strong>{{ layer.title }}</strong></span><span class="model-expand-label">{{ activeModelLayerIndex === index ? (isZh ? '收起' : 'Close') : (isZh ? '查看步驟' : 'View step') }}<i aria-hidden="true"></i></span></button><Transition name="model-detail"><div v-if="activeModelLayerIndex === index" :id="`model-layer-detail-${index}`" class="model-layer-detail"><p>{{ layer.desc }}</p><code>{{ layer.stack }}</code></div></Transition></li></ol></section>
        <aside class="model-governance" :aria-label="isZh ? '模型治理與評估' : 'Model governance and evaluation'"><header class="model-board-title"><div><span>MLOPS / GOVERNANCE</span><h3>{{ isZh ? '不是黑盒子；每一步都有紀錄。' : 'Not a black box. Every step is recorded.' }}</h3></div></header><div class="model-governance-list"><article v-for="(item, index) in modelGovernance" :key="item.term" :class="{ 'is-open': activeModelGovernanceIndex === index }"><button type="button" :aria-expanded="activeModelGovernanceIndex === index" :aria-controls="`model-governance-detail-${index}`" @click="activeModelGovernanceIndex = activeModelGovernanceIndex === index ? null : index"><span><small>{{ item.term }}</small><strong>{{ item.value }}</strong></span><i aria-hidden="true"></i></button><Transition name="model-detail"><div v-if="activeModelGovernanceIndex === index" :id="`model-governance-detail-${index}`" class="model-governance-detail"><p>{{ item.desc }}</p><code>{{ item.detail }}</code></div></Transition></article></div><div class="model-task-heads"><button type="button" :aria-expanded="modelTaskHeadsOpen" aria-controls="model-task-head-list" @click="modelTaskHeadsOpen = !modelTaskHeadsOpen"><span><small>SHARED ENCODER</small><strong>{{ isZh ? '查看模型同時判斷的 9 種任務' : 'See the model’s 9 concurrent tasks' }}</strong></span><i aria-hidden="true"></i></button><Transition name="model-detail"><ul v-if="modelTaskHeadsOpen" id="model-task-head-list"><li v-for="task in modelTaskHeads" :key="task">{{ task }}</li></ul></Transition></div><p class="model-governance-note">{{ isZh ? '模型負責縮小未知；人類負責承擔判斷。任何改善建議仍需通過資料同意、去識別、政策檢查與策略覆核。' : 'The model narrows uncertainty; people remain accountable. Recommendations still pass consent, de-identification, policy and strategy review.' }}</p></aside>
      </div>
      <div class="model-proof-marquee" aria-hidden="true"><div v-for="repeat in 2" :key="repeat"><span v-for="term in modelTerms" :key="`${repeat}-${term}`">{{ term }}</span></div></div>
    </div>
  </section>
</template>
