declare module 'vanta/dist/vanta.waves.min.js' {
  type VantaFactory = (options: Record<string, unknown>) => import('./premium-motion').VantaEffect
  const waves: VantaFactory | { default: VantaFactory }
  export default waves
}
