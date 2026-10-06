<script setup lang="ts">
import type { Ref } from "vue";
import type { getLearningLoopWorkspace } from "~/server/learning-loop/service";
import type { WorkspaceSummary } from "~/server/geo-outcome-model/types";
import type { getContentEffectModelWorkspace } from "~/server/learning-loop/effect-service";

definePageMeta({ layout: "owner" });
useHead({
  title: "學習閉環｜DiscoveryStack",
  meta: [{ name: "robots", content: "noindex,nofollow,noarchive" }],
});
type Workspace = Awaited<ReturnType<typeof getLearningLoopWorkspace>>;
type Reader = <T>(
  path: string,
  options: { server: false }
) => Promise<{
  data: Ref<T | undefined>;
  error: Ref<{ statusCode?: number; message?: string } | undefined>;
  pending: Ref<boolean>;
  refresh: () => Promise<void>;
}>;
type Mutator = (
  path: string,
  options: { method: "POST"; body: Record<string, unknown> }
) => Promise<Record<string, unknown>>;
const read = useFetch as unknown as Reader,
  mutate = $fetch as unknown as Mutator;
const { data, error, pending, refresh } = await read<Workspace>(
  "/api/interventions/closed-loop/workspace",
  { server: false }
);
const model = await read<{ workspace: WorkspaceSummary }>(
  "/api/geo-outcome-model/workspace",
  { server: false }
);
const content = await read<{
  entries: Array<{
    id: number;
    draftId: number | null;
    topicCluster: string;
    status: string;
  }>;
}>("/api/content-operations/workspace", { server: false });
const effect = await read<
  Awaited<ReturnType<typeof getContentEffectModelWorkspace>>
>("/api/interventions/closed-loop/effect-models", { server: false });
const effects = computed(() => effect.data.value);
const effectReview = reactive({
  piiReviewConfirmed: false,
  observationalOnlyAcknowledged: false,
  reviewReason: "",
});
const workspace = computed(() => data.value),
  models = computed(() => model.data.value?.workspace);
const busy = ref(false),
  notice = ref(""),
  actionError = ref(""),
  detail = ref<Record<string, unknown> | null>(null);
const form = reactive({
  clientId: 0,
  sourceId: 0,
  rightsBasis: "owner_authorized",
  rightsEvidenceHash: "",
  consentReceiptHash: "",
  consentVersion: "",
  expiresDate: "",
  retentionDays: 14,
  consentConfirmed: false,
  rightsConfirmed: false,
});
const selectedClient = computed(() =>
  workspace.value?.clients.find(client => client.id === form.clientId)
);
const sources = computed(
  () =>
    workspace.value?.sources.filter(
      source =>
        source.trainingPolicyApproved &&
        source.origin === selectedClient.value?.origin
    ) || []
);
const piiChecked = reactive<Record<number, boolean>>({});
const training = reactive({
  datasetManifestId: "",
  modelFamily: "regularized_logistic_baseline_v1",
});
const advice = reactive({ entryId: 0, artifactId: "" });
const draftEntries = computed(
  () => content.data.value?.entries.filter(entry => entry.draftId) || []
);
const shadowModels = computed(
  () =>
    models.value?.models.filter(
      item => item.status === "approved_for_shadow" && !item.fallbackOnly
    ) || []
);
const fallbackModels = computed(
  () => models.value?.models.filter(item => item.fallbackOnly) || []
);
const fallbackReason = ref(""),
  fallbackChecked = reactive<Record<string, boolean>>({});
const reason = ref("");
const requestKeys = new Map<string, string>();
const keyFor = (operation: string) => {
  if (!requestKeys.has(operation))
    requestKeys.set(operation, `learning-ui:${crypto.randomUUID()}`);
  return requestKeys.get(operation)!;
};
const canSave = computed(
  () =>
    form.clientId > 0 &&
    form.sourceId > 0 &&
    /^[a-f0-9]{64}$/.test(form.rightsEvidenceHash) &&
    /^[a-f0-9]{64}$/.test(form.consentReceiptHash) &&
    /^[A-Za-z0-9_.:-]{1,80}$/.test(form.consentVersion) &&
    Boolean(form.expiresDate) &&
    form.consentConfirmed &&
    form.rightsConfirmed
);
const labels: Record<string, string> = {
  completed: "已完成",
  completed_partial: "部分完成",
  failed: "未完成",
  collecting: "蒐集中",
  pending: "待人工檢視",
  approved: "已核准",
  rejected: "已排除",
  active: "有效",
  revoked: "已撤回",
  gate_blocked: "證據不足",
  ready_for_review: "待審核",
  queued: "排程中",
  running: "執行中",
  training: "訓練中",
  blocked: "已阻擋",
  development: "開發模型",
  approved_for_shadow: "影子驗證模型",
};
const label = (value: string) => labels[value] || value;
async function refreshAll() {
  await Promise.all([
    refresh(),
    model.refresh(),
    content.refresh(),
    effect.refresh(),
  ]);
}
async function action(
  path: string,
  body: Record<string, unknown>,
  success: string,
  operation?: string
) {
  busy.value = true;
  notice.value = "";
  actionError.value = "";
  detail.value = null;
  try {
    detail.value = await mutate(path, { method: "POST", body });
    notice.value = success;
    if (operation) requestKeys.delete(operation);
    await refreshAll();
  } catch (e) {
    const failure = e as {
      data?: { data?: { code?: string }; statusMessage?: string };
      message?: string;
    };
    actionError.value =
      failure.data?.data?.code ||
      failure.data?.statusMessage ||
      failure.message ||
      "操作未完成，請確認目前狀態後再重試。";
  } finally {
    busy.value = false;
  }
}
async function hashDocument(
  event: Event,
  field: "rightsEvidenceHash" | "consentReceiptHash"
) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) {
    form[field] = "";
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    actionError.value = "證明檔案請小於 10 MB。";
    form[field] = "";
    return;
  }
  const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  form[field] = Array.from(new Uint8Array(hash), byte =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
async function saveGrant() {
  if (!canSave.value) return;
  const operation = `grant:${JSON.stringify(form)}`;
  await action(
    "/api/interventions/closed-loop/authorizations",
    {
      clientId: form.clientId,
      sourceId: form.sourceId,
      rightsBasis: form.rightsBasis,
      rightsEvidenceHash: form.rightsEvidenceHash,
      consentReceiptHash: form.consentReceiptHash,
      consentVersion: form.consentVersion,
      expiresAt: new Date(`${form.expiresDate}T23:59:59+08:00`).toISOString(),
      retentionDays: form.retentionDays,
      modelImprovementConsentConfirmed: form.consentConfirmed,
      sourceRightsConfirmed: form.rightsConfirmed,
      idempotencyKey: keyFor(operation),
    },
    "授權已記錄。系統仍會在每次蒐集與使用資料時重新檢查。",
    operation
  );
}
async function collect(id: number) {
  const operation = `collect:${id}`;
  await action(
    "/api/interventions/closed-loop/collect",
    { authorizationId: id, idempotencyKey: keyFor(operation) },
    "蒐集請求已完成，請查看紀錄及限制原因；尚未自動核准訓練。",
    operation
  );
}
async function review(id: number, decision: "approved" | "rejected") {
  await action(
    `/api/interventions/closed-loop/collections/${id}/review`,
    {
      decision,
      piiReviewConfirmed: Boolean(piiChecked[id]),
      structuralOnlyAcknowledged: true,
    },
    decision === "approved"
      ? "已核准結構輔助資料；不會變成 AI 引用標籤。"
      : "已排除這批資料。"
  );
}
async function buildDataset() {
  const operation = "build-citation-dataset";
  await action(
    "/api/geo-outcome-model/datasets/build",
    { taskType: "citation_selection", idempotencyKey: keyFor(operation) },
    "引用資料集已整理。請查看門檻與核對證據，再決定是否核准。",
    operation
  );
}
async function approveDataset(id: string) {
  if (!reason.value.trim()) {
    actionError.value = "請先填寫這次資料集核對的理由。";
    return;
  }
  const operation = `approve:${id}:${reason.value}`;
  await action(
    `/api/geo-outcome-model/datasets/${id}/review`,
    {
      decision: "approve",
      reason: reason.value.trim(),
      idempotencyKey: keyFor(operation),
    },
    "已記錄資料集核准；仍需通過訓練與影子驗證。",
    operation
  );
}
async function reviewEffectDataset() {
  if (!effects.value?.release) return;
  await action(
    "/api/interventions/closed-loop/effect-models/review",
    {
      datasetDigest: effects.value.release.datasetDigest,
      lineageFingerprint: effects.value.release.lineageFingerprint,
      ...effectReview,
    },
    "已核准這一份確切成效資料並排入訓練；新資料不會沿用這次核准，模型也不會自動上線。"
  );
}
async function createFallback() {
  await action(
    "/api/interventions/closed-loop/citation-fallback/create",
    { ...training },
    "已建立獨立的回退基準，尚未核准。請檢視資料、隔離評估與用途，再另行確認。"
  );
}
async function approveFallback(artifactId: string) {
  if (!fallbackChecked[artifactId] || fallbackReason.value.trim().length < 10)
    return;
  await action(
    "/api/interventions/closed-loop/citation-fallback/review",
    { artifactId, reason: fallbackReason.value.trim() },
    "已記錄這份回退基準的獨立核准；它不能用於草稿建議或正式模型，候選仍須通過完整影子門檻。"
  );
}
</script>

<template>
  <main class="learning-page">
    <header class="hero">
      <div>
        <p class="eyebrow">DISCOVERYSTACK · PRIVATE LEARNING OPERATIONS</p>
        <h1>讓每次發布<br /><em>都有下一次學習。</em></h1>
        <p>
          資料授權、網站蒐集、模型驗證、客戶確認與成效回收，在同一個工作流程裡。尚未接通的服務會明確停在門檻，不用示範資料假裝成功。
        </p>
      </div>
      <button type="button" :disabled="busy" @click="refreshAll()">
        更新目前狀態
      </button>
    </header>
    <nav class="steps" aria-label="閉環步驟">
      <a href="#authority">01 資料授權</a><a href="#collection">02 蒐集與檢視</a
      ><a href="#training">03 訓練與驗證</a><a href="#publish">04 LINE 確認</a
      ><a href="#feedback">05 成效回收</a>
    </nav>
    <p v-if="notice" class="success" role="status">{{ notice }}</p>
    <p v-if="actionError" class="error" role="alert">{{ actionError }}</p>
    <section v-if="pending" class="panel">正在讀取你的閉環工作台。</section>
    <section v-else-if="error" class="panel error">
      <h2>
        {{ error.statusCode === 401 ? "請先登入管理者帳號" : "工作台尚未就緒" }}
      </h2>
      <p>
        需要正式資料庫與管理者權限；不會載入假的客戶、同意或模型。{{
          error.message
        }}
      </p>
    </section>
    <template v-else-if="workspace">
      <div class="status-strip">
        <span
          >閉環排程：{{
            workspace.configuration.loopEnabled ? "已開通" : "未開通"
          }}</span
        ><span
          >保存期清理：{{
            workspace.configuration.retentionEnabled ? "已開通" : "尚未開通"
          }}</span
        ><span
          >安全蒐集：{{
            workspace.configuration.crawlEnabled ? "已開通" : "未開通"
          }}</span
        ><span
          >LINE 週更：{{
            workspace.configuration.weeklyContentEnabled &&
            workspace.configuration.schedulerEnabled
              ? "排程已開通，仍需帳號與政策就緒"
              : "尚未開通"
          }}</span
        >
      </div>
      <section id="authority" class="panel">
        <div class="heading">
          <div>
            <p class="eyebrow">01 · SOURCE AUTHORITY</p>
            <h2>先確認可以學哪些資料</h2>
          </div>
          <NuxtLink to="/audit-lab#source-card-title"
            >管理來源與使用權利 ↗</NuxtLink
          >
        </div>
        <p>
          只接受已通過權利、用途與個資審核的客戶網站。LINE
          的文章發布同意和資料學習同意是兩件事。證明檔案只在你的瀏覽器計算指紋，原檔不會上傳；請另外妥善保管原始同意證明。
        </p>
        <p
          v-if="!workspace.clients.some(client => client.active)"
          class="empty"
        >
          目前沒有可選的有效客戶。先在來源管理中建立客戶並完成來源權利審核；此頁不會建立示範客戶。
        </p>
        <form class="form-grid" @submit.prevent="saveGrant">
          <label
            >客戶<select
              v-model.number="form.clientId"
              required
              @change="form.sourceId = 0"
            >
              <option :value="0">選擇客戶</option>
              <option
                v-for="client in workspace.clients.filter(c => c.active)"
                :key="client.id"
                :value="client.id"
              >
                {{ client.name }} · {{ client.origin }}
              </option>
            </select></label
          ><label
            >已審核來源<select v-model.number="form.sourceId" required>
              <option :value="0">選擇同網站的來源</option>
              <option
                v-for="source in sources"
                :key="source.id"
                :value="source.id"
              >
                來源 #{{ source.id }} · {{ source.origin }}
              </option>
            </select></label
          ><label
            >使用權利依據<select v-model="form.rightsBasis">
              <option value="owner_authorized">客戶有權授權的自有內容</option>
              <option value="licensed">已取得明確授權</option>
              <option value="open_license_verified">已核對開放授權條款</option>
            </select></label
          ><label
            >同意書版本<input
              v-model.trim="form.consentVersion"
              required
              maxlength="80"
              placeholder="例如 model-improvement-v1" /></label
          ><label
            >權利證明檔<input
              type="file"
              @change="hashDocument($event, 'rightsEvidenceHash')"
            /><small>{{
              form.rightsEvidenceHash
                ? "已計算檔案指紋，原檔未上傳"
                : "請選擇你已保存的權利證明"
            }}</small></label
          ><label
            >學習同意證明檔<input
              type="file"
              @change="hashDocument($event, 'consentReceiptHash')"
            /><small>{{
              form.consentReceiptHash
                ? "已計算檔案指紋，原檔未上傳"
                : "請選擇已取得的資料學習同意證明"
            }}</small></label
          ><label
            >授權到期日（最長 90 天）<input
              v-model="form.expiresDate"
              type="date"
              required /></label
          ><label
            >資料保存天數<input
              v-model.number="form.retentionDays"
              type="number"
              min="1"
              max="30"
              required /></label
          ><label class="check wide"
            ><input
              v-model="form.consentConfirmed"
              type="checkbox"
            />我已取得客戶針對網站結構與去識別化成效資料用於模型改進的同意，且有可核對的證明。</label
          ><label class="check wide"
            ><input
              v-model="form.rightsConfirmed"
              type="checkbox"
            />我已核對來源權利、條款與個資範圍；不包含會員、訂單、表單或 LINE
            對話資料。</label
          ><button type="submit" :disabled="busy || !canSave">
            記錄這份授權
          </button>
        </form>
        <p v-if="!workspace.authorizations.length" class="empty">
          尚無授權紀錄。只有完成證明、同意與人工確認後，資料才可進入蒐集流程。
        </p>
        <div class="cards">
          <article
            v-for="grant in workspace.authorizations"
            :key="grant.id"
            class="record"
          >
            <strong>授權 #{{ grant.id }} · 客戶 #{{ grant.clientId }}</strong
            ><span>{{ grant.authorizedOrigin }}</span
            ><small
              >{{ label(grant.status) }} ·
              {{ grant.usable ? "目前可使用" : "目前不可使用" }} · 到期
              {{ grant.expiresAt }}</small
            >
            <div class="buttons">
              <button
                type="button"
                :disabled="
                  busy || !grant.usable || !workspace.configuration.crawlEnabled
                "
                @click="collect(grant.id)"
              >
                蒐集這個網站</button
              ><button
                type="button"
                class="quiet"
                :disabled="busy || grant.status === 'revoked'"
                @click="
                  action(
                    `/api/interventions/closed-loop/authorizations/${grant.id}/revoke`,
                    {},
                    '已撤回學習授權，停止新的蒐集與資料集使用。'
                  )
                "
              >
                撤回學習授權
              </button>
            </div>
          </article>
        </div>
      </section>
      <section id="collection" class="panel">
        <p class="eyebrow">02 · BOUNDED EVIDENCE</p>
        <h2>蒐集後，再檢視一次</h2>
        <p>
          每次最多 20 頁、兩層連結、單頁 256
          KB，並遵守目前的網站爬蟲規則。保存結構與指紋；蒐集成功不等於 AI
          引用了這個網站。
        </p>
        <p v-if="!workspace.collections.length" class="empty">
          尚未蒐集資料。先建立真實授權，再開始第一批蒐集。
        </p>
        <article
          v-for="collection in workspace.collections"
          :key="collection.id"
          class="record"
        >
          <strong
            >蒐集 #{{ collection.id }} · {{ label(collection.status) }}</strong
          ><span
            >{{ collection.projection?.pagesCaptured || 0 }} 頁 ·
            {{ label(collection.reviewStatus) }} ·
            {{
              collection.usable ? "目前可納入輔助資料集" : "目前不可納入"
            }}</span
          ><small v-if="collection.errorCode"
            >停止原因：{{ collection.errorCode }}</small
          ><small
            >保存期限：{{ collection.retentionUntil }} · AI
            引用標籤：未知</small
          >
          <details v-if="collection.projection">
            <summary>檢視保存的結構資料</summary>
            <pre>{{
              JSON.stringify(collection.projection.pages, null, 2)
            }}</pre>
          </details>
          <template
            v-if="
              collection.status === 'completed' &&
              collection.reviewStatus === 'pending'
            "
            ><label class="check"
              ><input
                v-model="piiChecked[collection.id]"
                type="checkbox"
              />我已核對這批來源與結構資料，確認沒有個資，並理解它不是 AI
              引用標籤。</label
            >
            <div class="buttons">
              <button
                type="button"
                :disabled="busy || !piiChecked[collection.id]"
                @click="review(collection.id, 'approved')"
              >
                核准結構輔助資料</button
              ><button
                type="button"
                class="quiet"
                :disabled="busy"
                @click="review(collection.id, 'rejected')"
              >
                排除這批資料
              </button>
            </div></template
          >
        </article>
        <a
          class="text-link"
          href="/api/interventions/closed-loop/structural-release"
          target="_blank"
          rel="noopener"
          >檢視目前可使用的結構輔助資料集 ↗</a
        >
      </section>
      <section id="training" class="panel">
        <div class="heading">
          <div>
            <p class="eyebrow">03 · TRAIN / EVALUATE / GOVERN</p>
            <h2>真正訓練，分開驗證</h2>
          </div>
          <NuxtLink to="/audit-lab/geo-outcome-model"
            >模型與影子驗證工作台 ↗</NuxtLink
          >
        </div>
        <p>
          引用模型只使用已核對的「查詢 × 候選頁 × 引擎 × 介面 × 地區 ×
          時間」觀測。同一網站、查詢與時間的資料會隔離，避免模型背答案。結構爬蟲、Google
          流量和訪客數不會混成引用標籤。
        </p>
        <p v-if="model.pending.value" class="empty" role="status">
          正在讀取模型門檻與訓練紀錄…
        </p>
        <p v-else-if="model.error.value" class="error" role="alert">
          模型工作台目前無法讀取，請確認登入狀態、資料庫與權限；授權及蒐集紀錄不受影響。
        </p>
        <p v-else-if="!models" class="empty">
          目前沒有模型工作台資料，請更新狀態或檢查服務連線；不會用示範結果代替。
        </p>
        <template v-if="models"
          ><div class="status-strip">
            <span
              >合格引用候選：{{ models.inventory.verifiedPrimaryCount }}</span
            ><span
              >開發門檻：{{
                models.readiness.development.ready ? "已達標" : "尚未達標"
              }}</span
            ><span
              >影子驗證：{{
                models.readiness.shadow.ready ? "已達標" : "尚未達標"
              }}</span
            >
          </div>
          <p v-if="!models.readiness.development.ready" class="empty">
            還缺：{{ models.readiness.development.missing.join("、") }}
          </p>
          <button type="button" :disabled="busy" @click="buildDataset">
            整理引用資料集（不自動核准）</button
          ><label class="review-reason"
            >資料集核對理由<textarea
              v-model.trim="reason"
              maxlength="500"
              placeholder="記錄已核對的證據、使用同意與個資審查依據"
            ></textarea>
          </label>
          <p v-if="!models.datasets.length" class="empty">
            尚無可審查的引用資料集。整理資料集不會自動核准，只有通過既有門檻與人工核對的資料才可訓練。
          </p>
          <article
            v-for="dataset in models.datasets"
            :key="dataset.manifestId"
            class="record"
          >
            <strong>{{ dataset.manifestId }}</strong
            ><span
              >{{ label(dataset.status) }} ·
              {{ dataset.sourceObservationFingerprints.length }} 筆 ·
              {{ dataset.websiteCount }} 網站 ·
              {{ dataset.queryGroupCount }} 查詢群</span
            ><button
              v-if="dataset.status === 'ready_for_review'"
              type="button"
              :disabled="busy || !reason"
              @click="approveDataset(dataset.manifestId)"
            >
              依核對理由核准此資料集
            </button>
          </article>
          <form
            class="form-grid"
            @submit.prevent="
              action(
                '/api/interventions/closed-loop/train',
                { ...training },
                '訓練流程已回報結果，請檢查評估與停止原因；模型不會自動切換到正式使用。'
              )
            "
          >
            <label
              >已核准資料集<select
                v-model="training.datasetManifestId"
                required
              >
                <option value="">選擇資料集</option>
                <option
                  v-for="dataset in models.datasets.filter(
                    d => d.status === 'approved' && d.readiness.ready
                  )"
                  :key="dataset.manifestId"
                  :value="dataset.manifestId"
                >
                  {{ dataset.manifestId }}
                </option>
              </select></label
            ><label
              >模型<select v-model="training.modelFamily">
                <option value="regularized_logistic_baseline_v1">
                  可解釋的引用基準模型
                </option>
                <option value="pairwise_logistic_ranker_v1">
                  候選頁面的成對排序模型
                </option>
              </select></label
            ><button
              type="submit"
              :disabled="busy || !training.datasetManifestId"
            >
              訓練並產出驗證結果
            </button>
          </form>
          <p v-if="!models.trainingRuns.length" class="empty">
            尚無訓練紀錄。只有核准且達標的資料集會提供選項。
          </p>
          <article
            v-for="run in models.trainingRuns"
            :key="run.trainingRunId"
            class="record"
          >
            <strong>{{ label(run.status) }} · {{ run.trainingRunId }}</strong
            ><small>{{
              run.reason || "訓練只使用訓練分區，其餘分區只做驗證。"
            }}</small>
          </article></template
        >
      </section>
      <section class="panel" aria-label="首次引用模型的回退基準">
        <p class="eyebrow">SEPARATE REVIEW · FALLBACK ONLY</p>
        <h2>第一個模型，也要有安全的回退基準</h2>
        <p>
          回退基準只使用核准資料集的訓練分區，計算正例比例；其他分區只做隔離評估。它不是內容建議模型、不是已校準的引用機率，也不會自動上線。先獨立建立與核准，再訓練綁定它的候選模型。
        </p>
        <form v-if="models" class="form-grid" @submit.prevent="createFallback">
          <label
            >已核准且達標的資料集<select
              v-model="training.datasetManifestId"
              required
            >
              <option value="">選擇資料集</option>
              <option
                v-for="dataset in models.datasets.filter(
                  d => d.status === 'approved' && d.readiness.ready
                )"
                :key="dataset.manifestId"
                :value="dataset.manifestId"
              >
                {{ dataset.manifestId }}
              </option>
            </select></label
          >
          <label
            >與候選相同的模型種類<select v-model="training.modelFamily">
              <option value="regularized_logistic_baseline_v1">
                引用基準模型
              </option>
              <option value="pairwise_logistic_ranker_v1">成對排序模型</option>
            </select></label
          >
          <button type="submit" :disabled="busy || !training.datasetManifestId">
            建立待審查的回退基準
          </button>
        </form>
        <p v-if="!fallbackModels.length" class="empty">
          尚無回退基準。缺少有效資料或獨立核准時，候選模型的影子准入會保持阻擋。
        </p>
        <label v-if="fallbackModels.length" class="review-reason"
          >回退基準的獨立核對理由<textarea
            v-model.trim="fallbackReason"
            minlength="10"
            maxlength="500"
            placeholder="記錄已核對的資料、權利、個資、隔離評估與回退用途"
          ></textarea>
        </label>
        <article
          v-for="item in fallbackModels"
          :key="item.artifactId"
          class="record"
        >
          <strong>僅供回退 · {{ item.artifactId }}</strong
          ><small
            >{{ label(item.status) }} · {{ item.modelFamily }} ·
            {{
              item.trainingRowCount
            }}
            筆訓練資料；每次使用仍重新檢查同意與資料譜系。</small
          >
          <details>
            <summary>檢視回退評估與限制（不含權重）</summary>
            <pre>{{ JSON.stringify(item.metrics, null, 2) }}</pre>
          </details>
          <template v-if="item.status === 'ready_for_owner_review'"
            ><label class="check"
              ><input
                v-model="fallbackChecked[item.artifactId]"
                type="checkbox"
              />我已核對這份基準與證據，理解它只能供回退，不能用來替客戶改稿或代表正式模型品質。</label
            ><button
              type="button"
              :disabled="
                busy ||
                !fallbackChecked[item.artifactId] ||
                fallbackReason.trim().length < 10
              "
              @click="approveFallback(item.artifactId)"
            >
              獨立核准這份回退基準
            </button></template
          >
        </article>
      </section>
      <section id="publish" class="panel">
        <div class="heading">
          <div>
            <p class="eyebrow">04 · CUSTOMER CONFIRMATION</p>
            <h2>客戶在 LINE 確認這一篇</h2>
          </div>
          <NuxtLink to="/audit-lab/weekly-content"
            >設定客戶、LINE 與週更政策 ↗</NuxtLink
          >
        </div>
        <p>
          已核准題目 → 生成草稿 → 事實與品質檢查 → LINE
          預覽／確認／要求修改。客戶確認後，下一次排程只會發布同一版本；文章變更、同意過期或帳號停用，都需要重新確認。
        </p>
        <div class="buttons">
          <select v-model.number="form.clientId" aria-label="要執行的客戶">
            <option :value="0">選擇客戶</option>
            <option
              v-for="client in workspace.clients.filter(c => c.active)"
              :key="client.id"
              :value="client.id"
            >
              {{ client.name }}
            </option></select
          ><button
            type="button"
            :disabled="
              busy || !form.clientId || !workspace.configuration.loopEnabled
            "
            @click="
              action(
                '/api/interventions/closed-loop/client-cycle',
                { clientId: form.clientId },
                '這位客戶的有界流程已執行。待客戶確認、服務未就緒或品質未過時，不會發布。'
              )
            "
          >
            執行這位客戶的流程
          </button>
        </div>
        <small
          >此操作可能依已開通的政策產生文章、發送 LINE
          或發布已確認內容；受原有額度與權限限制。沒有開通服務時不會以假成功代替。</small
        >
      </section>
      <section id="feedback" class="panel">
        <div class="heading">
          <div>
            <p class="eyebrow">05 · OBSERVE / LEARN AGAIN</p>
            <h2>發布回執，接回下一次判斷</h2>
          </div>
          <NuxtLink to="/audit-lab/measurement-operations"
            >連接 Google 成效來源 ↗</NuxtLink
          >
        </div>
        <p>
          正式發布後會補登改動與安排後續觀測，並在有足夠成效資料與重新抓取證據時評估。每次整理學習資料，都重新檢查客戶同意、來源權利、版本與保存期限；撤回後就不再納入。
        </p>
        <div class="buttons">
          <NuxtLink to="/audit-lab/interventions">查看改動前後與限制</NuxtLink
          ><a
            href="/api/interventions/closed-loop/outcome-release"
            target="_blank"
            rel="noopener"
            >檢視去識別化成效候選資料 ↗</a
          >
        </div>
        <p class="empty">
          成效資料反映觀察到的變化，不等於能證明因果；模型預測不等於真的被 AI
          引用，也不保證排名或收入。
        </p>
      </section>
      <section class="panel" aria-label="目前草稿的模型建議">
        <p class="eyebrow">EXACT DRAFT · EXPERIMENTAL ADVICE</p>
        <h2>把通過驗證的模型用在目前草稿</h2>
        <p>
          只讀取系統裡的同一份草稿，以仍有效的學習授權及已核准影子模型產出建議。缺少的特徵保持未知；這不是市場排名、不會改寫文章，也不會代替
          LINE 確認。
        </p>
        <p v-if="content.error.value" class="error">
          目前無法讀取正式草稿，請確認資料庫與權限。
        </p>
        <p
          v-else-if="!draftEntries.length || !shadowModels.length"
          class="empty"
        >
          需要正式草稿及已核准的影子模型。新模型仍須完成資料、成效及回退驗證，不能直接套用。
        </p>
        <form
          class="form-grid"
          @submit.prevent="
            action(
              '/api/interventions/closed-loop/draft-advice',
              { ...advice },
              '已產出這份草稿的實驗性建議，請查看下方結果與未知特徵。'
            )
          "
        >
          <label
            >目前草稿<select v-model.number="advice.entryId" required>
              <option :value="0">選擇草稿</option>
              <option
                v-for="entry in draftEntries"
                :key="entry.id"
                :value="entry.id"
              >
                #{{ entry.id }} · {{ entry.topicCluster }} ·
                {{ label(entry.status) }}
              </option>
            </select></label
          ><label
            >已核准影子模型<select v-model="advice.artifactId" required>
              <option value="">選擇模型</option>
              <option
                v-for="item in shadowModels"
                :key="item.artifactId"
                :value="item.artifactId"
              >
                {{ item.artifactId }}
              </option>
            </select></label
          ><button
            type="submit"
            :disabled="busy || !advice.entryId || !advice.artifactId"
          >
            產出目前草稿的模型建議
          </button>
        </form>
      </section>
    </template>
    <section
      v-if="workspace && !error && !pending"
      class="panel"
      aria-label="成效模型重新訓練"
    >
      <p class="eyebrow">FEEDBACK · A SEPARATE OBSERVATIONAL MODEL</p>
      <h2>讓核准的成效，真正進入下一輪訓練</h2>
      <p>
        這是另一個模型任務：學習哪些發布前的條件，與後續 Google
        搜尋成效的正向／負向變化相關。只使用發布前的資料；發布後的數字只能用於答案與評估，不能偷偷當成預測輸入。不明、混合或沒有明顯變化的結果，不會被當成負例。
      </p>
      <p v-if="effect.error.value" class="error">
        目前無法讀取正式成效資料。沒有資料庫、目前同意或正式回執時，不會使用示範結果代替。
      </p>
      <template v-else-if="effects"
        ><div class="status-strip">
          <span>合格成效候選：{{ effects.release?.candidateCount || 0 }}</span
          ><span
            >重新訓練：{{
              effects.enabled ? "已開通，仍須核准確切資料" : "尚未開通"
            }}</span
          ><span>正式模型切換：不自動執行</span>
        </div>
        <p
          v-if="effects.release?.status !== 'ready_for_dataset_review'"
          class="empty"
        >
          資料尚未達到訓練審查門檻。需至少 150
          筆合格候選，以及足夠的內容種類、語言、來源和隔離驗證資料；不能降低門檻補數字。
        </p>
        <form v-else class="form-grid" @submit.prevent="reviewEffectDataset">
          <label class="wide"
            >這批資料的核對理由<textarea
              v-model.trim="effectReview.reviewReason"
              minlength="10"
              maxlength="500"
              required
              placeholder="記錄已核對的資料來源、權利、目前同意與個資處理依據"
            ></textarea></label
          ><label class="check wide"
            ><input
              v-model="effectReview.piiReviewConfirmed"
              type="checkbox"
            />我已檢視這一份去識別化成效資料及證據，確認個資處理與目前授權符合用途。</label
          ><label class="check wide"
            ><input
              v-model="effectReview.observationalOnlyAcknowledged"
              type="checkbox"
            />我理解這是方向性觀察模型，不是因果、AI
            引用、排名或成交保證；訓練時仍須通過可信發布時間、重複觀測去重與獨立時間外驗證。</label
          ><button
            type="submit"
            :disabled="
              busy ||
              !effectReview.piiReviewConfirmed ||
              !effectReview.observationalOnlyAcknowledged ||
              effectReview.reviewReason.length < 10
            "
          >
            核對並排入下一輪訓練
          </button>
        </form>
        <article v-for="item in effects.models" :key="item.id" class="record">
          <strong>成效模型 #{{ item.id }} · {{ label(item.status) }}</strong
          ><span
            >{{ item.candidateCount }} 筆核准候選 ·
            {{
              item.currentLineageValid ? "目前資料與同意仍有效" : "目前不可使用"
            }}</span
          ><small v-if="item.reasonCode">停止原因：{{ item.reasonCode }}</small>
          <div class="buttons">
            <button
              v-if="item.status === 'queued' || item.status === 'training'"
              type="button"
              :disabled="busy || !effects.enabled || !item.currentLineageValid"
              @click="
                action(
                  '/api/interventions/closed-loop/effect-models/train',
                  { modelId: item.id },
                  '已執行這份成效模型訓練，請查看驗證結果或停止原因；未切換正式模型。'
                )
              "
            >
              執行核准的訓練</button
            ><button
              type="button"
              class="quiet"
              :disabled="busy || item.status === 'revoked'"
              @click="
                action(
                  `/api/interventions/closed-loop/effect-models/${item.id}/revoke`,
                  {},
                  '已撤回這份模型並移除其衍生權重，保留核准歷史。'
                )
              "
            >
              撤回這份模型
            </button>
          </div>
          <details v-if="item.artifact">
            <summary>檢視隔離驗證結果與限制（不含權重）</summary>
            <pre>{{ JSON.stringify(item.artifact, null, 2) }}</pre>
          </details>
        </article></template
      >
      <p class="empty">
        模型只在本機／伺服器進行有界訓練，不上傳客戶資料。驗證可檢查相關性，但沒有完整
        live 改動前後與時間外證據時，不能宣稱因果效果或正式模型品質。
      </p>
    </section>
    <details v-if="detail" class="panel">
      <summary>本次操作的完整結果</summary>
      <pre>{{ JSON.stringify(detail, null, 2) }}</pre>
    </details>
  </main>
</template>

<style scoped>
.learning-page {
  max-width: 1160px;
  margin: auto;
  padding: 44px 24px 80px;
  color: #233147;
}
.hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 24px 0 30px;
}
.hero h1 {
  font-size: clamp(36px, 5vw, 64px);
  line-height: 1.12;
  letter-spacing: -0.04em;
  margin: 12px 0 20px;
}
.hero em {
  font-style: normal;
  color: #486291;
}
.hero p:not(.eyebrow) {
  max-width: 680px;
  line-height: 1.8;
}
.eyebrow {
  font-size: 11px;
  letter-spacing: 0.15em;
  font-weight: 800;
  color: #60758e;
}
.steps {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 24px;
}
.steps a {
  background: #e5ebf2;
  padding: 12px 16px;
  border-radius: 20px;
  font-size: 13px;
}
.panel {
  background: white;
  border: 1px solid #dce4ec;
  border-radius: 18px;
  padding: 28px;
  margin: 22px 0;
  scroll-margin-top: 100px;
}
.panel h2 {
  font-size: 24px;
  margin: 4px 0 14px;
}
.panel p {
  line-height: 1.85;
}
.heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 18px;
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  margin: 24px 0;
}
.form-grid label,
.review-reason {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 14px;
}
.wide {
  grid-column: 1/-1;
}
input:not([type="checkbox"]),
select,
textarea {
  width: 100%;
  min-width: 0;
  border: 1px solid #cdd7e2;
  border-radius: 8px;
  padding: 11px;
  background: #fff;
  font: inherit;
  color: inherit;
  box-sizing: border-box;
}
textarea {
  min-height: 84px;
}
.check {
  display: flex !important;
  flex-direction: row !important;
  align-items: flex-start;
  gap: 9px;
  line-height: 1.65;
}
.check input {
  margin-top: 5px;
  flex-shrink: 0;
}
button {
  padding: 11px 17px;
  background: #233f66;
  border: 1px solid #233f66;
  color: #fff;
  border-radius: 8px;
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.quiet {
  background: white;
  color: #233f66;
  border-color: #cdd7e2;
}
.buttons {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin: 14px 0;
}
.buttons select {
  width: auto;
  max-width: 100%;
}
.record {
  display: flex;
  align-items: flex-start;
  flex-direction: column;
  gap: 9px;
  margin-top: 16px;
  padding: 19px;
  border: 1px solid #e1e7ef;
  border-radius: 12px;
  overflow-wrap: anywhere;
}
.record strong {
  font-size: 14px;
}
small {
  font-size: 12px;
  line-height: 1.6;
  color: #6a778c;
}
.status-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  background: #e9eff6;
  border-radius: 10px;
  padding: 16px;
  font-size: 13px;
}
.empty {
  padding: 14px;
  background: #f3f5f8;
  border-radius: 8px;
  color: #62718a;
  font-size: 13px;
}
.success {
  background: #e5f3eb;
  padding: 16px;
  border-radius: 8px;
}
.error {
  background: #fff0ed;
  padding: 16px;
  border-radius: 8px;
  color: #8b352b;
}
a {
  color: #365983;
  text-decoration: none;
  font-size: 13px;
}
a:hover {
  text-decoration: underline;
}
pre {
  overflow: auto;
  max-height: 450px;
  width: 100%;
  font-size: 12px;
  line-height: 1.6;
  background: #f4f6fa;
  padding: 14px;
  box-sizing: border-box;
}
details {
  max-width: 100%;
}
.text-link {
  display: inline-block;
  margin-top: 18px;
}
.review-reason {
  margin: 20px 0;
}
button:focus-visible,
a:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 3px solid #83b4e6;
  outline-offset: 3px;
}
@media (max-width: 700px) {
  .learning-page {
    padding: 22px 15px 60px;
  }
  .hero,
  .heading {
    flex-direction: column;
    align-items: flex-start;
  }
  .panel {
    padding: 20px;
  }
  .form-grid {
    grid-template-columns: 1fr;
  }
  .wide {
    grid-column: auto;
  }
  .steps a {
    font-size: 11px;
    padding: 10px;
  }
  .buttons {
    align-items: flex-start;
    flex-direction: column;
  }
  .buttons select {
    width: 100%;
  }
}
</style>
