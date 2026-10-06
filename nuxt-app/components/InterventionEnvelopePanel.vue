<script setup lang="ts">
import type { InterventionEnvelope } from '../server/intervention-loop/envelope'

defineProps<{ envelope: InterventionEnvelope }>()

const sourceLabels: Record<string, string> = {
  google_search_console: 'Google 搜尋成績', llm_visibility: 'AI 引用觀察', first_party_analytics: '訪客行為', lead_conversion: '詢問與轉換',
}
const statusLabels: Record<string, string> = {
  comparable: '可比較', insufficient_data: '資料不足', blocked: '未通過檢查', unsupported: '尚未支援此來源的指標',
  current: '已核對目前資料', stale: '資料已變更，請重新評估', not_assessed: '尚未評估',
  verified: '已核對目前發布回執', missing: '缺少發布回執', unavailable: '目前無法核對發布回執', not_applicable: '非回執確認模式',
}
const signalLabels: Record<string, string> = {
  positive_signal: '正向訊號', negative_signal: '負向訊號', mixed_signal: '訊號混合', no_material_change: '無明顯改變', insufficient_data: '資料不足',
}
const reasonLabels: Record<string, string> = {
  pre_post_not_experiment: '前後比較不等於對照實驗', no_control_group: '沒有對照組', observational_not_causal: '只能描述相關，不能證明因果',
  attribution_not_established: '尚未建立成效歸因', concurrent_changes_not_recorded: '尚未完整記錄同期間其他改動', immutable_change_set_not_recorded: '尚未綁定不可變的精確改動版本',
  sample_below_minimum: '樣本低於門檻', short_follow_up_window: '上線後觀察不足 14 天', deployment_weak_evidence: '上線僅有弱證據',
  baseline_unknown: '缺少可核對的發布前基準', recrawl_manual_confirmation: '重新抓取是人工確認', recrawl_not_confirmed: '尚未確認發布後重新抓取',
  mixed_measurement_origins: '有不同收集模式，數字保持分開', multiple_measurement_scopes: '有不同來源範圍，不能合併判讀',
  no_comparable_measurement_scope: '沒有完整且同範圍的前後資料', non_search_sources_kept_separate: '其他來源未混入 Google 搜尋成績',
  transition_rows_excluded: '過渡期間的資料未納入比較', assessment_stale: '評估與目前資料不一致', event_fingerprint_mismatch: '事件紀錄指紋不一致',
  publication_binding_missing: '缺少可核對的發布回執', publication_binding_stale: '發布回執與目前內容或頁面不一致', publication_binding_unavailable: '目前無法核對發布回執',
  measurement_lineage_mismatch: '量測與目前改動不一致', measurement_window_invalid: '量測時間範圍不正確', measurement_captured_before_window_end: '量測在觀察期結束前就被記錄',
  measurement_sample_invalid: '樣本數不正確', measurement_metrics_invalid: '指標內容不正確', measurement_source_hash_mismatch: '量測來源指紋不一致',
  measurement_source_not_supported_by_click_contract: '此來源不能使用搜尋點擊指標', measurement_windows_overlap: '觀察時間重疊，可能重複計數',
  baseline_measurements_missing: '缺少發布前量測', follow_up_measurements_missing: '缺少重新抓取後量測',
  consent_authority_not_bound: '尚未綁定有效的學習同意', pii_review_not_bound: '尚未綁定個資檢查紀錄', aggregate_is_not_citation_ground_truth: '彙總成績不是 AI 引用真值',
  comparable_outcome_not_ready: '可比較的成效資料尚未就緒', exact_publication_authority_not_bound: '尚未綁定可核對的精確發布授權',
}
const reason = (code: string) => reasonLabels[code] || '有待核對的資料限制'
const shortHash = (value: string | null) => value ? `${value.slice(0, 12)}…` : '未知'
const number = (value: number | null | undefined) => value === null || value === undefined ? '未知' : new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 }).format(value)
const date = (value: Date | string | null) => value ? new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Taipei' }).format(new Date(value)) : '未知'
</script>

<template>
  <section class="envelope" aria-label="改動前後與學習資料檢查">
    <h3>這次改動的完整證據</h3>
    <p class="intro">發布狀態、量測訊號與可否用來學習是三件不同的事。未知的資料不會補成 0，也不會自動成為訓練資料。</p>
    <div class="envelope-grid">
      <article class="evidence-card">
        <h4>改之前</h4>
        <p>{{ envelope.before.availability === 'known' ? '已有發布前內容基準' : '發布前內容基準未知' }}</p>
        <dl><dt>內容指紋</dt><dd :title="envelope.before.contentHash || ''">{{ shortHash(envelope.before.contentHash) }}</dd><dt>擷取時間</dt><dd>{{ date(envelope.before.capturedAt) }}</dd></dl>
      </article>
      <article class="evidence-card">
        <h4>做了什麼</h4>
        <dl><dt>發布時間</dt><dd>{{ date(envelope.intervention.deployedAt) }}</dd><dt>發布回執</dt><dd>{{ statusLabels[envelope.intervention.publication.binding] }}</dd><dt>精確改動版本</dt><dd>尚未綁定；不從摘要猜測</dd></dl>
      </article>
      <article class="evidence-card">
        <h4>改之後</h4>
        <p>{{ envelope.after.recrawl.status === 'confirmed' ? '已確認發布後重新抓取' : '發布後重新抓取未知' }}</p>
        <dl><dt>重新抓取時間</dt><dd>{{ date(envelope.after.recrawl.confirmedAt) }}</dd><dt>評估</dt><dd>{{ statusLabels[envelope.after.assessment.status] }}</dd><dt>判讀</dt><dd>{{ signalLabels[envelope.after.assessment.signal] }}</dd></dl>
      </article>
      <article class="evidence-card">
        <h4>可信程度</h4>
        <dl><dt>樣本數（前／後）</dt><dd>{{ number(envelope.confidence.sampleSize.before) }}／{{ number(envelope.confidence.sampleSize.after) }}</dd><dt>實際觀察天數（前／後）</dt><dd>{{ number(envelope.confidence.observedDays.before) }}／{{ number(envelope.confidence.observedDays.after) }}</dd><dt>最低樣本門檻</dt><dd>{{ envelope.confidence.minimumSampleSize }}</dd></dl>
        <p>不產生推測的置信百分比。</p>
      </article>
    </div>
    <h4>各來源分開看</h4>
    <p v-if="!envelope.after.measurements.length">尚無量測資料。這不是零流量，也不是零引用。</p>
    <div v-else class="measurement-scroll"><table><caption>同一來源、收集方式與範圍才可比較</caption><thead><tr><th scope="col">來源／收集方式</th><th scope="col">資料狀態</th><th scope="col">每日點擊（前／後）</th><th scope="col">樣本數（前／後）</th></tr></thead><tbody>
      <tr v-for="group in envelope.after.measurements" :key="group.scopeKey"><th scope="row">{{ sourceLabels[group.source] }}／{{ group.origin === 'manual' ? '人工輸入' : '系統收集' }}</th><td>{{ statusLabels[group.status] }}<ul v-if="group.reasons.length"><li v-for="code in group.reasons" :key="code">{{ reason(code) }}</li></ul></td><td>{{ number(group.baseline.aggregates?.clicksPerDay) }}／{{ number(group.followUp.aggregates?.clicksPerDay) }}</td><td>{{ number(group.baseline.sampleSize) }}／{{ number(group.followUp.sampleSize) }}</td></tr>
    </tbody></table></div>
    <details><summary>資料限制與待補證據（{{ envelope.confidence.limitations.length }}）</summary><ul><li v-for="code in envelope.confidence.limitations" :key="code">{{ reason(code) }}</li></ul></details>
    <aside class="learning-gate" aria-label="機器學習資料守門"><h4>能拿來訓練嗎？目前不能</h4><p>這份紀錄可供營運檢查；仍須補齊以下授權與證據，才能進入後續學習流程。</p><ul><li v-for="code in envelope.learning.reasonCodes" :key="code">{{ reason(code) }}</li></ul><NuxtLink to="/audit-lab/geo-outcome-model">查看模型資料與驗證門檻</NuxtLink></aside>
    <blockquote>{{ envelope.confidence.causalStatement }}</blockquote>
    <p class="fingerprint" :title="envelope.envelopeFingerprint">證據版本 {{ envelope.schemaVersion }}｜指紋 {{ shortHash(envelope.envelopeFingerprint) }}</p>
  </section>
</template>

<style scoped>
.envelope{margin:1rem 0 1.5rem}.intro,.fingerprint{color:#526579}.envelope-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem}.evidence-card{padding:1rem;background:#f5f8fb;border:1px solid #dbe3ed;border-radius:.6rem}.evidence-card h4{margin:0 0 .75rem}.evidence-card p{font-size:.9rem}dl{display:grid;grid-template-columns:minmax(6rem,auto) 1fr;gap:.4rem .75rem;font-size:.9rem}dt{color:#526579}dd{margin:0;overflow-wrap:anywhere}.measurement-scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:.9rem}caption{text-align:left;margin-bottom:.5rem;color:#526579}th,td{padding:.6rem;text-align:left;vertical-align:top;border-bottom:1px solid #dbe3ed}td ul{padding-left:1.2rem}details{margin:1rem 0}summary{cursor:pointer}.learning-gate{padding:1rem;background:#fff9eb;border:1px solid #e9d9b2;border-radius:.6rem}.learning-gate h4{margin-top:0}blockquote{margin:1rem 0 0;padding:1rem;background:#edf3f8;font-size:.9rem}.fingerprint{font-size:.8rem;overflow-wrap:anywhere}@media(max-width:760px){.envelope-grid{grid-template-columns:1fr}dl{grid-template-columns:1fr;gap:.2rem}dd{margin-bottom:.5rem}}
</style>
