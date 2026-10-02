export type ManagedSiteOperationState = { completed: Record<string, true>; refreshFailed: boolean }

export type ManagedSiteOperationOutcome<T> =
  | { status: 'success'; result: T; refreshFailed: boolean }
  | { status: 'blocked'; error: unknown }
  | { status: 'already_completed' }

export function createManagedSiteOperationState(): ManagedSiteOperationState { return { completed: {}, refreshFailed: false } }

/** Re-reads the screen only. A thrown refresh and a refresh that reports failure both count as a failed screen update. */
export async function refreshManagedSiteOperationScreen(state: ManagedSiteOperationState, refreshScreen: () => Promise<boolean>): Promise<boolean> {
  let refreshed = false
  try { refreshed = await refreshScreen() === true } catch { refreshed = false }
  state.refreshFailed = !refreshed
  return refreshed
}

/**
 * Sends one owner management operation and then refreshes the screen. Once the server accepts the
 * operation it stays recorded as completed for this page session: a failed refresh is reported
 * separately and the same operation key is never submitted again.
 */
export async function runManagedSiteOperation<T>(state: ManagedSiteOperationState, operationKey: string, submit: () => Promise<T>, refreshScreen: () => Promise<boolean>): Promise<ManagedSiteOperationOutcome<T>> {
  if (state.completed[operationKey]) return { status: 'already_completed' }
  let result: T
  try { result = await submit() } catch (error) { return { status: 'blocked', error } }
  state.completed[operationKey] = true
  const refreshed = await refreshManagedSiteOperationScreen(state, refreshScreen)
  return { status: 'success', result, refreshFailed: !refreshed }
}
