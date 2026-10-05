export interface VantaEffect {
  destroy(): void
  resize(): void
  animationLoop(): void
  req: number
  prevNow?: number
  renderer?: {
    domElement: HTMLCanvasElement
    dispose(): void
    forceContextLoss(): void
  }
}
