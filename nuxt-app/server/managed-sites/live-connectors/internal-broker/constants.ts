/**
 * Sentinel only: this origin is never resolved over the network. The broker fetch
 * hard-binds it in-process; absent broker configuration returns 503 with no network fallthrough.
 */
export const MANAGED_SITE_INTERNAL_BROKER_ORIGIN = 'https://managed-sites-broker.discoverystack.dev'
