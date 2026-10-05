<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import type { VantaEffect } from "../types/premium-motion";
import { clampUnit, pointerFieldWeight, sectionScrollPhase, stepSpring, travellingWave } from "../lib/particle-flow";

const props = withDefaults(
  defineProps<{ locale?: "en" | "zh-hant"; variant?: "hero" | "compact" }>(),
  {
    locale: "zh-hant",
    variant: "hero",
  }
);

const stage = ref<HTMLDivElement | null>(null);
const water = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const ready = ref(false);
let dispose: (() => void) | undefined;

onMounted(() => {
  const element = stage.value;
  const surface = canvas.value;
  const context = surface?.getContext("2d", { alpha: true });
  if (!element || !surface || !context) return;

  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(pointer: fine)");
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  let width = 1;
  let height = 1;
  let frame = 0;
  let previous = 0;
  let phase = 0;
  const initialBounds = element.getBoundingClientRect();
  let visible =
    initialBounds.bottom > -80 && initialBounds.top < window.innerHeight + 80;
  let destroyed = false;
  let pageActive = true;
  let loadingVanta = false;
  let vantaUnavailable = false;
  let vanta: VantaEffect | undefined;
  let vantaPaused = false;
  let mouseX = 0;
  let mouseY = 0;
  let pointerPresent = false;
  let pointerX = { value: 0, velocity: 0 };
  let pointerY = { value: 0, velocity: 0 };
  let pointerStrength = { value: 0, velocity: 0 };
  let scroll = { value: 0, velocity: 0 };
  let scrollTarget = 0;
  let scrollDirty = true;
  const parent = element.closest("section") || element;
  const isPaused = () => document.documentElement.dataset.motionPaused === "true";
  const canAnimate = () => !destroyed && pageActive && visible && !document.hidden && !preference.matches && !isPaused();

  // The sculpture is original geometry: two woven ribbons, not a star field.
  // A deterministic distribution also gives the static/SSR versions a stable shape.
  let seed = 73;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const count = mobile ? 2600 : 4800;
  const sample = (t: number, band: number, strand: number) => {
    const angle = t + strand * Math.PI;
    const twist = angle * 1.12 + Math.PI / 4;
    return {
      y: t * 0.46,
      envelope: 0.78 + 0.18 * Math.cos(t * 0.8),
      band: band * 0.155,
      sinAngle: Math.sin(angle),
      cosAngle: Math.cos(angle),
      sinTwist: Math.sin(twist),
      cosTwist: Math.cos(twist),
      sinFlowA: Math.sin(t * 0.82 + strand * 0.65),
      cosFlowA: Math.cos(t * 0.82 + strand * 0.65),
      sinFlowB: Math.sin(t * 1.42 - strand * 0.45),
      cosFlowB: Math.cos(t * 1.42 - strand * 0.45),
      screenX: 0,
      screenY: 0,
      depth: 0,
    };
  };
  const particles = Array.from({ length: count }, (_, index) => {
    const t = (index / count) * Math.PI * 2.35 - Math.PI * 1.175;
    return {
      ...sample(t, random() * 2 - 1, index % 2),
      fleck: random(),
      sinShimmer: Math.sin(t * 5),
      cosShimmer: Math.cos(t * 5),
    };
  });
  const threads = Array.from({ length: 44 }, (_, thread) => ({
    opacity: (thread % 22) % 7 === 0 ? 0.33 : 0.1125,
    lineWidth: (thread % 22) % 7 === 0 ? 0.65 : 0.4,
    points: Array.from({ length: 109 }, (_, segment) =>
      sample(
        (segment / 108) * Math.PI * 2.35 - Math.PI * 1.175,
        ((thread % 22) / 21) * 2 - 1,
        Math.floor(thread / 22)
      )
    ),
  }));

  const draw = (time: number) => {
    // Precomputed samples + angle addition avoid ~100k trigonometric calls per frame.
    const scrollPhase = preference.matches ? 0 : clampUnit(scroll.value);
    const turn = time * 0.075 + scrollPhase * 0.42;
    const sinPhase = Math.sin(turn);
    const cosPhase = Math.cos(turn);
    const sinTwistPhase = Math.sin(turn * 1.12);
    const cosTwistPhase = Math.cos(turn * 1.12);
    const sinY = Math.sin(0.48 + pointerX.value * 0.11 + scrollPhase * 0.1);
    const cosY = Math.cos(0.48 + pointerX.value * 0.11 + scrollPhase * 0.1);
    const sinZ = Math.sin(-0.34 + pointerY.value * 0.045 - scrollPhase * 0.12);
    const cosZ = Math.cos(-0.34 + pointerY.value * 0.045 - scrollPhase * 0.12);
    const baseScale = Math.min(width * 0.38, height * 0.29);
    const flowTime = time + scrollPhase * 0.65;
    const sinFlowA = Math.sin(flowTime * 0.62);
    const cosFlowA = Math.cos(flowTime * 0.62);
    const sinFlowB = Math.sin(flowTime * 0.87);
    const cosFlowB = Math.cos(flowTime * 0.87);
    const flowAmplitude = preference.matches ? 0 : 0.13 + scrollPhase * 0.045 + Math.min(Math.abs(scroll.velocity) * 0.014, 0.035);
    const fieldX = pointerX.value * width * 0.5 / baseScale;
    const fieldY = pointerY.value * height * 0.5 / baseScale;
    const fieldStrength = preference.matches ? 0 : clampUnit(pointerStrength.value);
    const dragX = Math.max(-0.12, Math.min(0.12, pointerX.velocity * 0.034));
    const dragY = Math.max(-0.12, Math.min(0.12, pointerY.velocity * 0.034));
    const sinShimmerPhase = Math.sin(time * 0.28);
    const cosShimmerPhase = Math.cos(time * 0.28);
    const position = (point: ReturnType<typeof sample>) => {
      const twistCos =
        point.cosTwist * cosTwistPhase - point.sinTwist * sinTwistPhase;
      const twistSin =
        point.sinTwist * cosTwistPhase + point.cosTwist * sinTwistPhase;
      const waveA = travellingWave(point.sinFlowA, point.cosFlowA, sinFlowA, cosFlowA);
      const waveB = travellingWave(point.sinFlowB, point.cosFlowB, sinFlowB, cosFlowB);
      const radius = point.envelope + point.band * twistCos + waveB * flowAmplitude * 0.24;
      const x =
        (point.sinAngle * cosPhase + point.cosAngle * sinPhase) * radius + waveA * flowAmplitude;
      const y = point.y * (1 - scrollPhase * 0.05) + point.band * twistSin + waveB * flowAmplitude * 0.58;
      const z =
        (point.cosAngle * cosPhase - point.sinAngle * sinPhase) * radius * 0.68 + waveA * flowAmplitude * 0.7;
      const rotatedX = x * cosY + z * sinY;
      const rotatedZ = -x * sinY + z * cosY;
      const scale = baseScale * (4.3 / (4.3 + rotatedZ));
      let planeX = rotatedX * cosZ - y * sinZ;
      let planeY = rotatedX * sinZ + y * cosZ;
      if (fieldStrength > 0.002) {
        const dx = planeX - fieldX, dy = planeY - fieldY;
        const weight = pointerFieldWeight(dx, dy, 0.88) * fieldStrength;
        // A local curl follows the hand, while drag inherits its damped momentum.
        planeX += (-dy * 0.27 + dragX) * weight;
        planeY += (dx * 0.27 + dragY) * weight;
      }
      point.screenX =
        width * 0.51 + planeX * scale + pointerX.value * 7;
      point.screenY =
        height * (0.49 - scrollPhase * 0.035) + planeY * scale + pointerY.value * 5;
      point.depth = (rotatedZ + 1) / 2;
    };
    context.clearRect(0, 0, width, height);
    // Continuous fine threads keep the material legible while the flecks give it depth.
    context.strokeStyle = "#b7a88f";
    for (const thread of threads) {
      context.beginPath();
      for (let segment = 0; segment < thread.points.length; segment += 1) {
        const point = thread.points[segment]!;
        position(point);
        if (segment === 0) context.moveTo(point.screenX, point.screenY);
        else context.lineTo(point.screenX, point.screenY);
      }
      context.globalAlpha = thread.opacity;
      context.lineWidth = thread.lineWidth;
      context.stroke();
    }
    for (const particle of particles) {
      position(particle);
      const shimmer =
        0.78 +
        (particle.sinShimmer * cosShimmerPhase +
          particle.cosShimmer * sinShimmerPhase) *
          0.16;
      const alpha = Math.min(
        0.9,
        (0.3 + (1 - particle.depth) * 0.55) * shimmer * 1.5
      );
      const size =
        (0.52 + particle.fleck * 0.8) * (1.2 - particle.depth * 0.32);
      const bright = particle.fleck > 0.91;
      context.fillStyle = bright ? "#f4ebd3" : "#bea97e";
      context.globalAlpha = bright ? alpha : alpha * 0.8;
      context.fillRect(particle.screenX, particle.screenY, size, size);
    }
    context.globalAlpha = 1;
  };

  const tick = (now: number) => {
    frame = 0;
    if (!canAnimate()) return;
    // 30 fps is ample for this deliberately slow piece and halves canvas work.
    if (now - previous >= 1000 / 30) {
      const seconds = Math.min((now - (previous || now)) / 1000, 0.06);
      phase += seconds;
      previous = now;
      if (scrollDirty) {
        const bounds = parent.getBoundingClientRect();
        scrollTarget = sectionScrollPhase(bounds.top, bounds.height) * (props.variant === "compact" ? 0.45 : 1);
        scrollDirty = false;
      }
      pointerX = stepSpring(pointerX, mouseX, seconds, 8.5);
      pointerY = stepSpring(pointerY, mouseY, seconds, 8.5);
      pointerStrength = stepSpring(pointerStrength, pointerPresent ? 1 : 0, seconds, 6.5);
      scroll = stepSpring(scroll, scrollTarget, seconds, 5.5);
      draw(phase);
    }
    frame = window.requestAnimationFrame(tick);
  };

  const stopVanta = () => {
    if (!vanta || vantaPaused) return;
    window.cancelAnimationFrame(vanta.req);
    vantaPaused = true;
  };

  const destroyVanta = () => {
    if (!vanta) return;
    // Vanta's public destroy removes listeners/scene; r134's renderer also needs disposal.
    const renderer = vanta.renderer;
    try {
      vanta.destroy();
    } catch {
      // Vanta removes its canvas early when initialization fails; destroy then
      // assumes the child still exists. Finish disposing that partial instance.
      renderer?.domElement.remove();
    } finally {
      renderer?.dispose();
      renderer?.forceContextLoss();
      vanta = undefined;
      vantaPaused = false;
    }
  };

  const startVanta = async () => {
    if (
      vanta ||
      loadingVanta ||
      vantaUnavailable ||
      !pageActive ||
      mobile ||
      preference.matches ||
      document.documentElement.dataset.motionPaused === "true" ||
      !visible ||
      document.hidden ||
      !water.value
    )
      return;
    loadingVanta = true;
    try {
      // Both modules stay outside SSR and are loaded only when the artwork is in view.
      const [three, effect] = await Promise.all([
        import("three"),
        import("vanta/dist/vanta.waves.min.js"),
      ]);
      if (
        destroyed ||
        !pageActive ||
        preference.matches ||
        document.documentElement.dataset.motionPaused === "true" ||
        !visible ||
        document.hidden ||
        !water.value
      )
        return;
      // The UMD package may retain its own default wrapper in dev/SSR interop.
      const waves =
        typeof effect.default === "function"
          ? effect.default
          : effect.default.default;
      vanta = waves({
        el: water.value,
        THREE: three,
        mouseControls: false,
        touchControls: false,
        gyroControls: false,
        minHeight: 120,
        minWidth: 120,
        color: 0x171a32,
        backgroundColor: 0x101326,
        shininess: 12,
        waveHeight: 5,
        waveSpeed: 0.22,
        zoom: 0.72,
        scale: Math.max(1.5, window.devicePixelRatio || 1),
        scaleMobile: 2,
      });
      if (
        !vanta.renderer?.domElement.isConnected ||
        typeof vanta.req !== "number"
      ) {
        vantaUnavailable = true;
        destroyVanta();
        return;
      }
      if (!canAnimate()) stopVanta();
    } catch {
      // Canvas sculpture and the SSR artwork remain complete without WebGL support.
      vantaUnavailable = true;
    } finally {
      loadingVanta = false;
    }
  };

  const sync = () => {
    const active = canAnimate();
    if (active) {
      if (!frame) {
        previous = 0;
        frame = window.requestAnimationFrame(tick);
      }
      if (vanta && vantaPaused) {
        vanta.prevNow = undefined;
        vantaPaused = false;
        vanta.animationLoop();
      } else void startVanta();
    } else {
      window.cancelAnimationFrame(frame);
      frame = 0;
      previous = 0;
      pointerX.velocity = 0;
      pointerY.velocity = 0;
      pointerStrength.velocity = 0;
      scroll.velocity = 0;
      stopVanta();
      if (preference.matches) {
        pointerX = { value: 0, velocity: 0 };
        pointerY = { value: 0, velocity: 0 };
        pointerStrength = { value: 0, velocity: 0 };
        scroll = { value: 0, velocity: 0 };
        draw(0);
        destroyVanta();
      }
    }
  };

  const resize = () => {
    scrollDirty = true;
    const bounds = element.getBoundingClientRect();
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    const ratio = Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2);
    if (
      surface.width === Math.round(width * ratio) &&
      surface.height === Math.round(height * ratio)
    )
      return;
    surface.width = Math.round(width * ratio);
    surface.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw(preference.matches ? 0 : phase);
    vanta?.resize();
  };
  const pointer = (event: PointerEvent) => {
    if (
      !finePointer.matches ||
      !canAnimate() ||
      preference.matches ||
      document.documentElement.dataset.motionPaused === "true" ||
      event.pointerType === "touch"
    )
      return;
    const bounds = element.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    pointerPresent = event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    mouseX = Math.max(
      -1,
      Math.min(1, ((event.clientX - bounds.left) / bounds.width - 0.5) * 2)
    );
    mouseY = Math.max(
      -1,
      Math.min(1, ((event.clientY - bounds.top) / bounds.height - 0.5) * 2)
    );
  };
  const resetPointer = () => {
    mouseX = 0;
    mouseY = 0;
    pointerPresent = false;
  };
  const scrollChanged = () => { scrollDirty = true; };
  parent.addEventListener("pointermove", pointer as EventListener, {
    passive: true,
  });
  parent.addEventListener("pointerleave", resetPointer);
  document.addEventListener("visibilitychange", sync);
  document.addEventListener("discoverystack:motion-change", sync);
  window.addEventListener("scroll", scrollChanged, { passive: true });
  const pageShow = () => { pageActive = true; scrollDirty = true; sync(); };
  window.addEventListener("pageshow", pageShow);
  preference.addEventListener("change", sync);
  const observer = new IntersectionObserver(
    ([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      sync();
    },
    { rootMargin: "80px" }
  );
  observer.observe(element);
  const sizeObserver = new ResizeObserver(resize);
  sizeObserver.observe(element);
  resize();
  ready.value = true;
  sync();

  const pageHide = (event: PageTransitionEvent) => {
    if (!event.persisted) {
      dispose?.();
      return;
    }
    window.cancelAnimationFrame(frame);
    frame = 0;
    pageActive = false;
    previous = 0;
    stopVanta();
  };
  window.addEventListener("pagehide", pageHide);
  const beforeSwap = () => dispose?.();
  document.addEventListener("astro:before-swap", beforeSwap);
  dispose = () => {
    if (destroyed) return;
    destroyed = true;
    window.cancelAnimationFrame(frame);
    observer.disconnect();
    sizeObserver.disconnect();
    parent.removeEventListener("pointermove", pointer as EventListener);
    parent.removeEventListener("pointerleave", resetPointer);
    document.removeEventListener("visibilitychange", sync);
    document.removeEventListener("discoverystack:motion-change", sync);
    document.removeEventListener("astro:before-swap", beforeSwap);
    window.removeEventListener("scroll", scrollChanged);
    window.removeEventListener("pagehide", pageHide);
    window.removeEventListener("pageshow", pageShow);
    preference.removeEventListener("change", sync);
    destroyVanta();
  };
});

onUnmounted(() => dispose?.());
</script>

<template>
  <div
    ref="stage"
    class="particle-sculpture"
    :class="[{ 'is-ready': ready }, `particle-sculpture--${variant}`]"
    aria-hidden="true"
  >
    <div ref="water" class="particle-sculpture__water"></div>
    <div class="particle-sculpture__halo"></div>
    <svg class="particle-sculpture__fallback" viewBox="0 0 620 690" fill="none">
      <defs>
        <linearGradient
          id="sculpture-thread"
          x1="145"
          y1="65"
          x2="470"
          y2="600"
          gradientUnits="userSpaceOnUse"
        >
          <stop stop-color="#eee9df" stop-opacity=".68" />
          <stop offset=".5" stop-color="#b7a88f" stop-opacity=".24" />
          <stop offset="1" stop-color="#b7a88f" stop-opacity=".7" />
        </linearGradient>
      </defs>
      <g stroke="url(#sculpture-thread)" stroke-width=".7">
        <path
          v-for="thread in 36"
          :key="`a-${thread}`"
          :d="`M ${260 + thread * 1.5} 80 C ${515 + thread} 148 ${405 + thread} 280 ${274 + thread} 340 S ${118 + thread * 2} 530 ${314 + thread * 2} 609`"
        />
        <path
          v-for="thread in 36"
          :key="`b-${thread}`"
          :d="`M ${283 + thread * 1.5} 80 C ${117 + thread} 213 ${222 + thread} 276 ${325 + thread} 340 S ${495 + thread} 496 ${336 + thread * 2} 609`"
        />
      </g>
    </svg>
    <canvas ref="canvas" class="particle-sculpture__canvas"></canvas>
    <span class="particle-sculpture__cross particle-sculpture__cross--a"
      >+</span
    >
    <span class="particle-sculpture__cross particle-sculpture__cross--b"
      >+</span
    >
    <span class="particle-sculpture__caption">FORM / 001</span>
    <span class="particle-sculpture__axis">DISCOVERY IN MOTION</span>
  </div>
</template>

<style scoped>
.particle-sculpture {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 480px;
  isolation: isolate;
  overflow: hidden;
  pointer-events: none;
}
.particle-sculpture__water {
  position: absolute;
  inset: 12% 0 8%;
  opacity: 0.22;
  z-index: -2;
  mask-image: radial-gradient(ellipse at 55% 54%, #000 8%, transparent 67%);
}
.particle-sculpture__halo {
  position: absolute;
  inset: 7%;
  z-index: -1;
  background: radial-gradient(
    ellipse at 52% 50%,
    rgba(183, 168, 143, 0.055),
    transparent 62%
  );
}
.particle-sculpture__canvas,
.particle-sculpture__fallback {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.particle-sculpture__canvas {
  opacity: 0;
  transition: opacity var(--motion-reveal, 720ms) var(--motion-ease, ease);
}
.particle-sculpture__fallback {
  opacity: 1;
  transition: opacity var(--motion-reveal, 720ms) var(--motion-ease, ease);
}
.is-ready .particle-sculpture__canvas {
  opacity: 1;
}
.is-ready .particle-sculpture__fallback {
  opacity: 0;
}
.particle-sculpture__caption,
.particle-sculpture__axis {
  position: absolute;
  color: rgba(183, 168, 143, 0.6);
  font:
    9px/1.2 "Courier New",
    monospace;
  letter-spacing: 0.2em;
}
.particle-sculpture__caption {
  left: 15%;
  bottom: 13%;
}
.particle-sculpture__axis {
  right: 6%;
  top: 47%;
  writing-mode: vertical-rl;
}
.particle-sculpture__cross {
  position: absolute;
  color: rgba(183, 168, 143, 0.32);
  font: 18px/1 monospace;
}
.particle-sculpture__cross--a {
  top: 15%;
  left: 17%;
}
.particle-sculpture__cross--b {
  bottom: 17%;
  right: 14%;
}
.particle-sculpture--compact {
  min-height: 360px;
}
@media (max-width: 760px) {
  .particle-sculpture {
    min-height: 360px;
  }
  .particle-sculpture__caption {
    bottom: 9%;
    left: 11%;
  }
  .particle-sculpture__axis {
    right: 4%;
    font-size: 8px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .particle-sculpture__canvas,
  .particle-sculpture__fallback {
    transition: none;
  }
}
:global(html[data-motion-paused="true"]) .particle-sculpture__canvas,
:global(html[data-motion-paused="true"]) .particle-sculpture__fallback {
  transition: none;
}
</style>
