export { DELIVERY_AUTOMATION_ENGINE_VERSION, DELIVERY_COMMAND_VERSION } from './types'
export { validateDeliveryTarget } from './target-guard'
export { computeDeliveryIdempotencyKey } from './idempotency'
export { evaluateDeliveryEligibility, planDeliveryAttempt, reduceDeliveryAttemptState, classifyDeliveryFailure } from './engine'
export type {
  ApprovedPublicationInput,
  DeliveryAdapter,
  DeliveryCommandMetadata,
  DeliveryEligibilityResult,
  DeliveryFailureClassification,
  DeliveryFailureInput,
  DeliveryPlanInput,
  DeliveryPlanResult,
  DeliveryResultInput,
  DeliveryState,
  DeliveryStateResult,
  DeliveryTargetInput,
  DeliveryTargetStatus,
  DeliveryTransitionEvent,
  IdempotencyPayload,
  IdempotencyResult,
  TargetValidationResult,
} from './types'
