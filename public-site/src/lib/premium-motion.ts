import type Lenis from "lenis";
import { initFluidScenes } from './fluid-scenes';

/*
 * The proximity/center calculation in attachMagnets is adapted from Vue Bits Magnet,
 * the official Vue port of React Bits, with GSAP quickTo replacing Vue reactive writes.
 * Source: https://github.com/DavidHDev/vue-bits/blob/main/src/content/Animations/Magnet/Magnet.vue
 *
 * MIT + Commons Clause License Condition v1.0
 * Copyright (c) 2025 David Haz
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, and distribute the Software as part of
 * an application, website, or product, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * Commons Clause Restriction: You may use this Software, including for any
 * commercial purpose, so long as you do not sell, sublicense, or redistribute
 * the components themselves-whether alone, in a bundle, template, or as a ported version.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

type Gsap = typeof import("gsap").gsap;

const motionIsPaused = () => document.documentElement.dataset.motionPaused === "true";

/** Read the same duration and spacing tokens used by the CSS interfaces. */
function motionTokens(scope: HTMLElement) {
  const styles = getComputedStyle(scope);
  const seconds = (name: string, fallback: number) => {
    const value = styles.getPropertyValue(name).trim();
    const number = parseFloat(value);
    return Number.isFinite(number) && number > 0 ? Math.min(0.9, value.endsWith("ms") ? number / 1000 : number) : fallback;
  };
  return {
    feedback: seconds("--motion-feedback", 0.2),
    panel: seconds("--motion-panel", 0.36),
    reveal: seconds("--motion-reveal", 0.72),
    stagger: seconds("--motion-stagger", 0.07),
    distance: Math.min(48, Math.max(8, parseFloat(styles.getPropertyValue("--motion-distance")) || 24)),
  };
}

/** A small vocabulary of entrances; a group owns its children only once. */
export function initPremiumReveals(scope: HTMLElement, motion: Gsap): () => void {
  const tokens = motionTokens(scope);
  const owned = new Set<HTMLElement>();
  const tweens: gsap.core.Tween[] = [];
  const entrance = (targets: HTMLElement[], kind: string, trigger: HTMLElement, stagger = 0) => {
    if (!targets.length) return;
    const vars: gsap.TweenVars = {
      opacity: 0, y: tokens.distance, duration: tokens.reveal, stagger,
      ease: "power3.out",
      scrollTrigger: { trigger, start: "top 91%", once: true },
    };
    if (kind === "title") Object.assign(vars, { y: tokens.distance * 0.8, rotationX: 8, transformOrigin: "50% 100%", duration: Math.min(0.9, tokens.reveal + 0.1) });
    else if (kind === "line") Object.assign(vars, {
      y: 0, opacity: 0.3, "--reveal-line-progress": 0,
      ...(targets.every(target => target.matches("hr,line,path")) ? { scaleX: 0, transformOrigin: "0% 50%" } : {}),
    });
    else if (kind === "card") Object.assign(vars, { y: tokens.distance * 1.2, scale: 0.98 });
    else if (kind === "image") Object.assign(vars, { y: tokens.distance * 0.5, clipPath: "inset(9% 0% 9% 0%)", duration: Math.min(0.9, tokens.reveal + 0.16) });
    else if (kind === "soft") Object.assign(vars, { y: tokens.distance * 0.4, duration: Math.max(0.5, tokens.reveal - 0.08) });
    if (trigger.closest(".premium-hero")) vars.delay = 0.08;
    if (kind === "line") {
      const directLine = vars.scaleX === 0;
      tweens.push(motion.fromTo(targets, {
        opacity: 0.3, "--reveal-line-progress": 0,
        ...(directLine ? { scaleX: 0, transformOrigin: "0% 50%" } : {}),
      }, { ...vars, opacity: 1, "--reveal-line-progress": 1, ...(directLine ? { scaleX: 1 } : {}) }));
    } else tweens.push(motion.from(targets, vars));
    targets.forEach(target => owned.add(target));
  };
  scope.querySelectorAll<HTMLElement>("[data-reveal-stagger]").forEach(group => {
    const children = [...group.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
    const configured = parseFloat(group.dataset.revealStagger || "");
    const stagger = Number.isFinite(configured) && configured > 0 ? Math.min(0.12, configured) : tokens.stagger;
    // Mixed rows use the child's semantic entrance while keeping one group trigger.
    children.forEach((child, index) => {
      entrance([child], child.dataset.revealKind || group.dataset.revealKind || "card", group);
      tweens[tweens.length - 1]?.delay(index * stagger);
    });
  });
  scope.querySelectorAll<HTMLElement>("[data-reveal]").forEach(element => {
    if (owned.has(element) || element.closest("[data-reveal-stagger]") !== null) return;
    entrance([element], element.dataset.revealKind || "soft", element);
  });
  return () => tweens.forEach(tween => {
    tween.scrollTrigger?.kill();
    tween.revert();
  });
}

/** Independent CSS channels avoid colliding with hover tilt and section parallax. */
export function initPremiumStoryLayers(scope: HTMLElement, motion: Gsap): () => void {
  const cleanups: (() => void)[] = [];
  scope.querySelectorAll<HTMLElement>("[data-scroll-story]").forEach(story => {
    story.querySelectorAll<HTMLElement | SVGElement>("[data-story-layer]").forEach(layer => {
      const depth = Math.min(36, Math.max(-36, Number(layer.dataset.storyLayer) || 12));
      const rotation = Math.min(5, Math.max(-5, Number(layer.dataset.storyRotate) || 0));
      const restore = saveStyle(layer as HTMLElement, ["--story-y", "--story-rotate"]);
      const tween = motion.fromTo(layer, { "--story-y": `${depth}px`, "--story-rotate": `${rotation}deg` }, {
        "--story-y": `${-depth}px`, "--story-rotate": `${-rotation}deg`, ease: "none",
        scrollTrigger: { trigger: story, start: "top 85%", end: "bottom 25%", scrub: 0.7 },
      });
      cleanups.push(() => { tween.scrollTrigger?.kill(); tween.kill(); restore(); });
    });
  });
  return () => cleanups.forEach(cleanup => cleanup());
}

/** Lenis owns wheel input, so an open navigation must suspend it explicitly. */
export function initPremiumMenuScrollGuard(controller: Pick<Lenis, "stop" | "start">, reduced: MediaQueryList): () => void {
  const sync = () => {
    if (document.documentElement.dataset.menuOpen === "true" || motionIsPaused() || reduced.matches) controller.stop();
    else controller.start();
  };
  document.addEventListener("discoverystack:menu-change", sync);
  sync();
  return () => document.removeEventListener("discoverystack:menu-change", sync);
}

const saveStyle = (element: HTMLElement, properties: string[]) => {
  const values = properties.map(property => [
    property,
    element.style.getPropertyValue(property),
    element.style.getPropertyPriority(property),
  ] as const);
  return () => values.forEach(([property, value, priority]) => {
    if (value) element.style.setProperty(property, value, priority);
    else element.style.removeProperty(property);
  });
};

/** Native details enhancement; an interrupted transition always settles to its last intent. */
export function initPremiumServiceAccordion(
  scope: HTMLElement,
  motion: Gsap,
  onLayout: () => void = () => {},
): () => void {
  let disposed = false;
  const tokens = motionTokens(scope);
  const entries = [...scope.querySelectorAll<HTMLDetailsElement>("details[data-service]")]
    .flatMap(details => {
      const summary = details.querySelector<HTMLElement>(":scope > summary");
      const panel = details.querySelector<HTMLElement>(":scope > .premium-service-detail");
      if (!summary || !panel) return [];
      const children = [...panel.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
      return [{
        details, summary, panel, children,
        desired: details.open,
        version: 0,
        targetHeight: 0,
        heightTween: undefined as gsap.core.Tween | undefined,
        childTween: undefined as gsap.core.Tween | undefined,
        name: details.getAttribute("name"),
        expanded: summary.getAttribute("aria-expanded"),
        inert: panel.inert,
        restoreBox: saveStyle(details, ["height", "overflow", "box-sizing"]),
        restoreChildren: children.map(child => saveStyle(child, ["opacity", "transform"])),
      }];
    });
  type Entry = typeof entries[number];
  const restoreChildren = (entry: Entry) => {
    motion.set(entry.children, { clearProps: "opacity,transform" });
    entry.restoreChildren.forEach(restore => restore());
  };
  const stop = (entry: Entry) => {
    entry.version += 1;
    entry.heightTween?.kill();
    entry.childTween?.kill();
    entry.heightTween = undefined;
    entry.childTween = undefined;
  };
  const collapsedHeight = (entry: Entry) => {
    const style = getComputedStyle(entry.details);
    const extras = [style.borderTopWidth, style.borderBottomWidth, style.paddingTop, style.paddingBottom]
      .reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
    return entry.summary.getBoundingClientRect().height + extras;
  };
  const animate = (entry: Entry, open: boolean, retarget = false) => {
    const current = entry.details.getBoundingClientRect().height;
    const wasOpen = entry.details.open;
    stop(entry);
    const version = entry.version;
    entry.desired = open;
    entry.summary.setAttribute("aria-expanded", String(open));
    entry.panel.inert = !open;
    // Closed details must be rendered before measuring the content's natural height.
    entry.details.open = true;
    const target = collapsedHeight(entry) + (open ? entry.panel.getBoundingClientRect().height : 0);
    entry.targetHeight = target;
    const finish = () => {
      if (disposed || version !== entry.version) return;
      entry.heightTween = undefined;
      entry.childTween?.kill();
      entry.childTween = undefined;
      entry.details.open = entry.desired;
      entry.panel.inert = entry.inert;
      entry.restoreBox();
      restoreChildren(entry);
      onLayout();
    };
    if (Math.abs(current - target) < 0.5) { finish(); return; }
    try {
      motion.set(entry.details, { height: current, overflow: "hidden", boxSizing: "border-box" });
      if (open && !wasOpen && !retarget) motion.set(entry.children, { opacity: 0, y: 14 });
      entry.childTween = motion.to(entry.children, {
        opacity: open ? 1 : 0,
        y: open ? 0 : 8,
        duration: open ? tokens.panel : tokens.feedback,
        stagger: open ? Math.min(tokens.stagger, 0.055) : 0.018,
        ease: "power2.out",
        overwrite: "auto",
      });
      entry.heightTween = motion.to(entry.details, {
        height: target,
        duration: retarget ? tokens.panel : open ? Math.max(0.5, tokens.reveal * 0.82) : Math.max(tokens.panel, tokens.reveal * 0.64),
        ease: "power3.inOut",
        overwrite: "auto",
        onComplete: finish,
      });
    } catch {
      // Native readable content is the fallback even if an animation cannot start.
      finish();
    }
  };
  const listeners: (() => void)[] = [];
  let openFound = false;
  entries.forEach(entry => {
    entry.details.removeAttribute("name");
    if (entry.desired && openFound) { entry.desired = false; entry.details.open = false; }
    openFound ||= entry.desired;
    entry.summary.setAttribute("aria-expanded", String(entry.desired));
    const click = (event: MouseEvent) => {
      if (disposed || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.target instanceof Element && event.target.closest("a,button,input,select,textarea")) return;
      event.preventDefault();
      const open = !entry.desired;
      if (open) entries.forEach(other => {
        if (other !== entry && other.desired) animate(other, false);
      });
      animate(entry, open);
    };
    entry.summary.addEventListener("click", click);
    listeners.push(() => entry.summary.removeEventListener("click", click));
  });
  const resize = new ResizeObserver(changes => {
    if (disposed) return;
    const changed = new Set<Entry>();
    changes.forEach(change => {
      const entry = entries.find(candidate => candidate.panel === change.target || candidate.summary === change.target);
      if (!entry?.heightTween) return;
      const target = collapsedHeight(entry) + (entry.desired ? entry.panel.getBoundingClientRect().height : 0);
      if (Math.abs(target - entry.targetHeight) > 0.5) changed.add(entry);
    });
    changed.forEach(entry => animate(entry, entry.desired, true));
  });
  entries.forEach(entry => { resize.observe(entry.panel); resize.observe(entry.summary); });
  return () => {
    if (disposed) return;
    disposed = true;
    resize.disconnect();
    listeners.forEach(remove => remove());
    entries.forEach(entry => {
      stop(entry);
      entry.details.open = entry.desired;
      entry.panel.inert = entry.inert;
      entry.restoreBox();
      restoreChildren(entry);
      if (entry.expanded === null) entry.summary.removeAttribute("aria-expanded");
      else entry.summary.setAttribute("aria-expanded", entry.expanded);
    });
    entries.forEach(entry => {
      if (entry.name === null) entry.details.removeAttribute("name");
      else entry.details.setAttribute("name", entry.name);
    });
  };
}

let activeCleanup: (() => void) | undefined;

/** CSS keeps the animation itself; JavaScript only controls when it may run. */
function initAmbient(scope: HTMLElement, reduced: MediaQueryList): () => void {
  const elements = [...scope.querySelectorAll<HTMLElement | SVGElement>("[data-ambient]")];
  if (!elements.length) return () => {};
  let pageActive = true;
  const visible = new Set<Element>();
  const sync = () => elements.forEach(element => element.style.setProperty(
    "--ambient-play-state",
    pageActive && !document.hidden && !reduced.matches && !motionIsPaused() && visible.has(element) ? "running" : "paused",
  ));
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) visible.add(entry.target);
      else visible.delete(entry.target);
    });
    sync();
  });
  elements.forEach(element => { element.style.setProperty("--ambient-play-state", "paused"); observer.observe(element); });
  const hide = () => { pageActive = false; sync(); };
  const show = () => { pageActive = true; sync(); };
  document.addEventListener("visibilitychange", sync);
  document.addEventListener("discoverystack:motion-change", sync);
  reduced.addEventListener("change", sync);
  window.addEventListener("pagehide", hide);
  window.addEventListener("pageshow", show);
  return () => {
    observer.disconnect();
    document.removeEventListener("visibilitychange", sync);
    document.removeEventListener("discoverystack:motion-change", sync);
    reduced.removeEventListener("change", sync);
    window.removeEventListener("pagehide", hide);
    window.removeEventListener("pageshow", show);
    elements.forEach(element => element.style.setProperty("--ambient-play-state", "paused"));
  };
}

/**
 * Progressive enhancement for the premium home only. Existing content is always
 * visible before scripts load. Returns an idempotent cleanup function; also handles
 * Astro swaps, pagehide/pageshow, preference changes, and background tabs.
 */
export function initPremiumMotion(): () => void {
  if (typeof window === "undefined") return () => {};
  activeCleanup?.();
  const scope = document.querySelector<HTMLElement>(".premium-home");
  if (!scope) return () => {};
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(pointer: fine)");
  const cleanupAmbient = initAmbient(scope, reduced);
  let disposed = false;
  let generation = 0;
  let teardownInner: (() => void) | undefined;
  let lenis: Lenis | undefined;
  let pauseTicker: (() => void) | undefined;
  let resumeTicker: (() => void) | undefined;

  const start = async () => {
    generation += 1;
    const request = generation;
    teardownInner?.();
    teardownInner = undefined;
    if (disposed || reduced.matches || motionIsPaused()) return;
    try {
      const [{ gsap }, { ScrollTrigger }, { default: LenisConstructor }] =
        await Promise.all([
          import("gsap"),
          import("gsap/ScrollTrigger"),
          import("lenis"),
        ]);
      if (disposed || reduced.matches || motionIsPaused() || request !== generation) return;
      gsap.registerPlugin(ScrollTrigger);
      const localCleanups: (() => void)[] = [];
      let refreshTimer = 0;
      const refresh = () => {
        refreshTimer = 0;
        if (!disposed && request === generation) ScrollTrigger.refresh();
      };
      const queueRefresh = () => {
        window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(refresh, 140);
      };
      localCleanups.push(() => window.clearTimeout(refreshTimer));
      const context = gsap.context(() => {}, scope);
      // Establish rollback before any enhancement: failures cannot leave content
      // hidden, observer callbacks live, or animation styles behind.
      teardownInner = () => {
        try {
          localCleanups.forEach(cleanup => cleanup());
        } finally {
          context.revert();
        }
      };
      context.add(() => {
        const tokens = motionTokens(scope);
        localCleanups.push(initPremiumServiceAccordion(scope, gsap, queueRefresh));
        const heroLines =
          scope.querySelectorAll<HTMLElement>("[data-hero-line]");
        if (heroLines.length) {
          gsap.from(heroLines, {
            yPercent: 105,
            opacity: 0,
            duration: tokens.reveal,
            stagger: Math.min(tokens.stagger, 0.06),
            ease: "power3.out",
            delay: 0.05,
          });
        }
        localCleanups.push(initPremiumReveals(scope, gsap));
        localCleanups.push(initPremiumStoryLayers(scope, gsap));
        // Fluid scenes own their reversible SVG/CSS snapshots. A second context
        // revert would remove the original values restored by their cleanup.
        context.ignore(() => localCleanups.push(initFluidScenes(scope, gsap)));
        scope
          .querySelectorAll<HTMLElement>("[data-parallax]")
          .forEach(element => {
            const configured = Number(element.dataset.parallax);
            const amount =
              Number.isFinite(configured) && configured !== 0
                ? Math.abs(configured) < 1
                  ? (configured * Math.min(window.innerHeight, 1000)) / 2
                  : configured
                : 28;
            gsap.fromTo(
              element,
              { y: amount },
              {
                y: -amount,
                ease: "none",
                scrollTrigger: {
                  trigger: element.closest("section") || element,
                  start: "top bottom",
                  end: "bottom top",
                  scrub: 1.3,
                },
              }
            );
          });

        scope.querySelectorAll<HTMLElement>("[data-progress]").forEach(element => {
          const restore = saveStyle(element, ["--section-progress"]);
          element.style.setProperty("--section-progress", "0");
          const trigger = ScrollTrigger.create({
            trigger: element,
            start: "top bottom",
            end: "bottom top",
            onUpdate: trigger => element.style.setProperty("--section-progress", trigger.progress.toFixed(4)),
          });
          localCleanups.push(() => { trigger.kill(); restore(); });
        });

        if (finePointer.matches) {
          scope.querySelectorAll<HTMLElement>("[data-tilt]").forEach(element => {
            const restore = saveStyle(element, ["--tilt-x", "--tilt-y", "--tilt-active"]);
            const limit = Math.min(9, Math.abs(Number(element.dataset.tilt)) || 5);
            gsap.set(element, { transformPerspective: 1100 });
            const rotateX = gsap.quickTo(element, "rotationX", { duration: 0.75, ease: "power3.out" });
            const rotateY = gsap.quickTo(element, "rotationY", { duration: 0.75, ease: "power3.out" });
            let pointerFrame = 0;
            let pointerX = 0;
            let pointerY = 0;
            let visible = false;
            const reset = () => {
              window.cancelAnimationFrame(pointerFrame);
              pointerFrame = 0;
              rotateX(0);
              rotateY(0);
              element.style.setProperty("--tilt-active", "0");
            };
            const update = () => {
              pointerFrame = 0;
              if (!visible || document.hidden) return;
              const bounds = element.getBoundingClientRect();
              if (!bounds.width || !bounds.height) { reset(); return; }
              const x = Math.max(0, Math.min(1, (pointerX - bounds.left) / bounds.width));
              const y = Math.max(0, Math.min(1, (pointerY - bounds.top) / bounds.height));
              rotateX((0.5 - y) * limit * 2);
              rotateY((x - 0.5) * limit * 2);
              element.style.setProperty("--tilt-x", `${(x * 100).toFixed(2)}%`);
              element.style.setProperty("--tilt-y", `${(y * 100).toFixed(2)}%`);
              element.style.setProperty("--tilt-active", "1");
            };
            const pointer = (event: PointerEvent) => {
              if (!visible || document.hidden || event.pointerType === "touch") return;
              pointerX = event.clientX;
              pointerY = event.clientY;
              if (!pointerFrame) pointerFrame = window.requestAnimationFrame(update);
            };
            const observer = new IntersectionObserver(([entry]) => {
              visible = Boolean(entry?.isIntersecting);
              if (!visible) reset();
            });
            observer.observe(element);
            const visibility = () => { if (document.hidden) reset(); };
            element.addEventListener("pointermove", pointer, { passive: true });
            element.addEventListener("pointerleave", reset);
            document.addEventListener("visibilitychange", visibility);
            localCleanups.push(() => {
              window.cancelAnimationFrame(pointerFrame);
              observer.disconnect();
              element.removeEventListener("pointermove", pointer);
              element.removeEventListener("pointerleave", reset);
              document.removeEventListener("visibilitychange", visibility);
              rotateX.tween.kill();
              rotateY.tween.kill();
              restore();
            });
          });
          const magnets = [
            ...scope.querySelectorAll<HTMLElement>("[data-magnetic]"),
          ].map(element => ({
            element,
            x: gsap.quickTo(element, "x", {
              duration: 0.55,
              ease: "power3.out",
            }),
            y: gsap.quickTo(element, "y", {
              duration: 0.55,
              ease: "power3.out",
            }),
            active: false,
            visible: false,
          }));
          const byElement = new Map(
            magnets.map(magnet => [magnet.element, magnet])
          );
          const magnetObserver = new IntersectionObserver(entries =>
            entries.forEach(entry => {
              const magnet = byElement.get(entry.target as HTMLElement);
              if (magnet) {
                magnet.visible = entry.isIntersecting;
                if (!magnet.visible && magnet.active) { magnet.x(0); magnet.y(0); magnet.active = false; }
              }
            })
          );
          magnets.forEach(magnet => magnetObserver.observe(magnet.element));
          let pointerFrame = 0;
          let pointerX = 0;
          let pointerY = 0;
          const reset = () =>
            magnets.forEach(magnet => {
              if (!magnet.active) return;
              magnet.x(0);
              magnet.y(0);
              magnet.active = false;
            });
          const updatePointer = () => {
            pointerFrame = 0;
            for (const magnet of magnets) {
              if (!magnet.visible) continue;
              const { left, top, width, height } =
                magnet.element.getBoundingClientRect();
              const centerX = left + width / 2;
              const centerY = top + height / 2;
              const distX = Math.abs(centerX - pointerX);
              const distY = Math.abs(centerY - pointerY);
              if (distX < width / 2 + 20 && distY < height / 2 + 20) {
                magnet.active = true;
                magnet.x(Math.max(-9, Math.min(9, (pointerX - centerX) / 7)));
                magnet.y(Math.max(-7, Math.min(7, (pointerY - centerY) / 7)));
              } else if (magnet.active) {
                magnet.x(0);
                magnet.y(0);
                magnet.active = false;
              }
            }
          };
          const move = (event: PointerEvent) => {
            if (event.pointerType === "touch" || document.hidden) return;
            pointerX = event.clientX;
            pointerY = event.clientY;
            if (!pointerFrame)
              pointerFrame = window.requestAnimationFrame(updatePointer);
          };
          const leave = () => {
            window.cancelAnimationFrame(pointerFrame);
            pointerFrame = 0;
            reset();
          };
          scope.addEventListener("pointermove", move, { passive: true });
          scope.addEventListener("pointerleave", leave);
          window.addEventListener("scroll", leave, { passive: true });
          const hidePointer = () => { if (document.hidden) leave(); };
          document.addEventListener("visibilitychange", hidePointer);
          localCleanups.push(() => {
            window.cancelAnimationFrame(pointerFrame);
            magnetObserver.disconnect();
            scope.removeEventListener("pointermove", move);
            scope.removeEventListener("pointerleave", leave);
            window.removeEventListener("scroll", leave);
            document.removeEventListener("visibilitychange", hidePointer);
            magnets.forEach(magnet => {
              magnet.x.tween.kill();
              magnet.y.tween.kill();
            });
          });
        }
      });

      // Keep touch scrolling native; pointer devices get the deliberate inertia.
      if (finePointer.matches) {
        lenis = new LenisConstructor({
          lerp: 0.085,
          smoothWheel: true,
          syncTouch: false,
          anchors: { offset: -88 },
          prevent: node =>
            node.matches(
              '[data-lenis-prevent], #siteNav, textarea, dialog, [role="dialog"]'
            ),
        });
        lenis.on("scroll", ScrollTrigger.update);
        localCleanups.push(initPremiumMenuScrollGuard(lenis, reduced));
        const tick = (time: number) => lenis?.raf(time * 1000);
        gsap.ticker.lagSmoothing(0);
        let tickerAttached = false;
        pauseTicker = () => {
          if (tickerAttached) gsap.ticker.remove(tick);
          tickerAttached = false;
        };
        resumeTicker = () => {
          if (tickerAttached || document.hidden) return;
          gsap.ticker.add(tick);
          tickerAttached = true;
        };
        resumeTicker();
        localCleanups.push(() => {
          pauseTicker?.();
          pauseTicker = undefined;
          resumeTicker = undefined;
          lenis?.destroy();
          lenis = undefined;
        });
      }
      // Font/image settling can change the section positions after hydration.
      void document.fonts?.ready.then(() => {
        if (!disposed && request === generation) refresh();
      });
      const observer = new ResizeObserver(queueRefresh);
      observer.observe(scope);
      localCleanups.push(() => observer.disconnect());
      refresh();
    } catch {
      teardownInner?.();
      teardownInner = undefined;
      // Copy, anchors, forms and the static artwork remain usable if enhancement fails.
    }
  };

  const visibility = () => {
    if (document.hidden) pauseTicker?.();
    else resumeTicker?.();
  };
  const pageHide = (event: PageTransitionEvent) => {
    generation += 1;
    teardownInner?.();
    teardownInner = undefined;
    if (!event.persisted) cleanup();
  };
  const pageShow = (event: PageTransitionEvent) => {
    if (event.persisted) void start();
  };
  const preference = () => void start();
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    generation += 1;
    teardownInner?.();
    teardownInner = undefined;
    cleanupAmbient();
    reduced.removeEventListener("change", preference);
    finePointer.removeEventListener("change", preference);
    document.removeEventListener("visibilitychange", visibility);
    document.removeEventListener("astro:before-swap", cleanup);
    document.removeEventListener("discoverystack:motion-change", preference);
    window.removeEventListener("pagehide", pageHide);
    window.removeEventListener("pageshow", pageShow);
    if (activeCleanup === cleanup) activeCleanup = undefined;
  };
  activeCleanup = cleanup;
  reduced.addEventListener("change", preference);
  finePointer.addEventListener("change", preference);
  document.addEventListener("visibilitychange", visibility);
  document.addEventListener("astro:before-swap", cleanup);
  document.addEventListener("discoverystack:motion-change", preference);
  window.addEventListener("pagehide", pageHide);
  window.addEventListener("pageshow", pageShow);
  void start();
  return cleanup;
}
