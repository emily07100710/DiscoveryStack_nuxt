import { assertPublicJourneyOrigin, publicOpsApiOrigin, publicSiteOrigin, readPublicOrigin } from './publicApi'

// This module is consumed by Astro while producing static HTML. Keeping the UI
// destination out of the hydrated API helper prevents deployment variable names
// from leaking into the public client bundle.
export const publicOpsUiOrigin = assertPublicJourneyOrigin('PUBLIC_OPS_UI_ORIGIN', readPublicOrigin(
  'PUBLIC_OPS_UI_ORIGIN',
  import.meta.env.PUBLIC_OPS_UI_ORIGIN,
  publicOpsApiOrigin,
), publicSiteOrigin)

export const customerManagedSiteStartUrl = `${publicOpsUiOrigin}/customer/managed-sites/start`
