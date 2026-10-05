/** Pure, bounded math for the original woven particle sculpture. */
export interface SpringState { value: number; velocity: number }

export const clampUnit = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** Exact critically damped response: the result does not depend on refresh rate. */
export function stepSpring(state: SpringState, target: number, seconds: number, response = 8): SpringState {
  const dt = Number.isFinite(seconds) ? Math.max(0, Math.min(0.064, seconds)) : 0;
  const omega = Number.isFinite(response) ? Math.max(0.1, Math.min(40, response)) : 8;
  const value = Number.isFinite(state.value) ? state.value : 0;
  const velocity = Number.isFinite(state.velocity) ? state.velocity : 0;
  const goal = Number.isFinite(target) ? target : value;
  const offset = value - goal;
  const momentum = velocity + omega * offset;
  const decay = Math.exp(-omega * dt);
  return {
    value: goal + (offset + momentum * dt) * decay,
    velocity: (velocity - omega * momentum * dt) * decay,
  };
}

/** Smooth local field, zero outside its radius, with no seam at its boundary. */
export function pointerFieldWeight(dx: number, dy: number, radiusSquared: number): number {
  if (!(radiusSquared > 0) || !Number.isFinite(dx + dy + radiusSquared)) return 0;
  const remaining = 1 - (dx * dx + dy * dy) / radiusSquared;
  return remaining > 0 ? remaining * remaining * remaining : 0;
}

/** Angle addition uses cached geometry instead of trigonometry for every particle. */
export const travellingWave = (basisSin: number, basisCos: number, phaseSin: number, phaseCos: number): number =>
  basisSin * phaseCos - basisCos * phaseSin;

export function sectionScrollPhase(top: number, height: number): number {
  if (!Number.isFinite(top) || !Number.isFinite(height) || height <= 0) return 0;
  return clampUnit(-top / (height * 0.85));
}
