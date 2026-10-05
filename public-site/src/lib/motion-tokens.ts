/** CSS is the single source of motion timing. Read once when mounting an effect. */
export function readMotionTokens(element: Element = document.documentElement) {
  const style = getComputedStyle(element)
  const duration = (name: string, fallback: number) => {
    const value = style.getPropertyValue(name).trim()
    const amount = parseFloat(value)
    return Number.isFinite(amount) && amount >= 0 ? amount * (value.endsWith('ms') ? 1 : 1000) : fallback
  }
  return {
    feedback: duration('--motion-feedback', 200),
    panel: duration('--motion-panel', 360),
    reveal: duration('--motion-reveal', 720),
    stagger: duration('--motion-stagger', 70),
    ease: style.getPropertyValue('--motion-ease').trim() || 'cubic-bezier(.22,1,.36,1)',
  }
}
