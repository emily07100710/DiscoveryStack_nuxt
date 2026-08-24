export { validateDeliveryTarget } from './target-guard'
export { computeDeliveryIdempotencyKey, isOpaqueIdentifier, isValidSha256 } from './idempotency'
export { computeDeliveryResultFingerprint, evaluateDeliveryEligibility, planDeliveryAttempt, reduceDeliveryAttemptState, classifyDeliveryFailure } from './engine'
export { DELIVERY_AUTOMATION_ENGINE_VERSION } from './types'
export type {
  ApprovedPublicationInput,
  DeliveryAdapter,
  DeliveryAttemptRecord,
  DeliveryCommandMetadata,
  DeliveryEligibilityResult,
  DeliveryFailureClassification,
  DeliveryFailureHistoryRecord,
  DeliveryFailureInput,
  DeliveryPlanInput,
  DeliveryPlanResult,
  DeliveryResultFingerprintResult,
  DeliveryResultInput,
  DeliveryState,
  DeliveryStateResult,
  DeliveryTargetInput,
  DeliveryTargetStatus,
  DeliveryTransitionEvent,
  IdempotencyPayload,
  IdempotencyResult,
  TargetValidationResult,
  ValidatedDeliveryTarget,
} from './types'
