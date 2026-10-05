// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gsap } from "gsap";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { initPremiumMenuScrollGuard, initPremiumMotion, initPremiumReveals, initPremiumServiceAccordion, initPremiumStoryLayers } from "../src/lib/premium-motion";

class ResizeObserverHarness {
  static instances: ResizeObserverHarness[] = [];
  observed = new Set<Element>();
  constructor(private callback: ResizeObserverCallback) { ResizeObserverHarness.instances.push(this); }
  observe(element: Element) { this.observed.add(element); }
  unobserve(element: Element) { this.observed.delete(element); }
  disconnect() { this.observed.clear(); }
  deliver(element: Element, width: number, height: number) {
    if (!this.observed.has(element)) return;
    this.callback([{ target: element, contentRect: { width, height } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

class IntersectionObserverHarness {
  static instances: IntersectionObserverHarness[] = [];
  observed = new Set<Element>();
  constructor(private callback: IntersectionObserverCallback) { IntersectionObserverHarness.instances.push(this); }
  observe(element: Element) { this.observed.add(element); }
  unobserve(element: Element) { this.observed.delete(element); }
  disconnect() { this.observed.clear(); }
  deliver(element: Element, visible: boolean) {
    if (!this.observed.has(element)) return;
    this.callback([{ target: element, isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

let cleanup: (() => void) | undefined;
let scope: HTMLElement;
let services: HTMLDetailsElement[];
let panels: HTMLElement[];
let heights: number[];
const settle = () => {
  gsap.globalTimeline.time(gsap.globalTimeline.time() + 2, false);
  gsap.ticker.sleep();
};
const click = (index: number) => services[index]!.querySelector("summary")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverHarness);
  vi.stubGlobal("IntersectionObserver", IntersectionObserverHarness);
  ResizeObserverHarness.instances = [];
  IntersectionObserverHarness.instances = [];
  document.body.innerHTML = `<div class="premium-home">${[0, 1, 2].map(index => `<details data-service name="premium-services" ${index === 0 ? "open" : ""} style="border-top:1px solid"><summary>Service ${index}</summary><div class="premium-service-detail"><div>Visual</div><div>Content</div><a href="#next">Learn more</a></div></details>`).join("")}</div>`;
  scope = document.querySelector(".premium-home")!;
  services = [...scope.querySelectorAll<HTMLDetailsElement>("details")];
  panels = [...scope.querySelectorAll<HTMLElement>(".premium-service-detail")];
  heights = [130, 140, 150];
  services.forEach((service, index) => {
    vi.spyOn(service, "getBoundingClientRect").mockImplementation(() => ({
      height: parseFloat(service.style.height) || 73 + (service.open ? heights[index]! : 0),
      width: 800, top: 0, bottom: 0, left: 0, right: 800, x: 0, y: 0, toJSON: () => {},
    }));
    vi.spyOn(service.querySelector("summary")!, "getBoundingClientRect").mockReturnValue({
      height: 72, width: 800, top: 0, bottom: 72, left: 0, right: 800, x: 0, y: 0, toJSON: () => {},
    });
    vi.spyOn(panels[index]!, "getBoundingClientRect").mockImplementation(() => ({
      height: heights[index]!, width: 800, top: 72, bottom: 72 + heights[index]!, left: 0, right: 800, x: 0, y: 72, toJSON: () => {},
    }));
  });
  gsap.globalTimeline.clear();
  gsap.ticker.sleep();
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  gsap.globalTimeline.clear();
  gsap.ticker.sleep();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  delete document.documentElement.dataset.motionPaused;
  delete document.documentElement.dataset.menuOpen;
});

describe("premium service accordion", () => {
  it("preserves SSR content, transitions between services and releases fixed height", () => {
    const layout = vi.fn();
    cleanup = initPremiumServiceAccordion(scope, gsap, layout);
    expect(services[0]!.open).toBe(true);
    expect(services[0]!.style.height).toBe("");
    click(1);
    expect(services[0]!.querySelector("summary")!.getAttribute("aria-expanded")).toBe("false");
    expect(services[1]!.querySelector("summary")!.getAttribute("aria-expanded")).toBe("true");
    expect(services[1]!.style.overflow).toBe("hidden");
    settle();
    expect(services.map(service => service.open)).toEqual([false, true, false]);
    services.forEach(service => { expect(service.style.height).toBe(""); expect(service.style.overflow).toBe(""); });
    expect(panels[1]!.children[1]!.getAttribute("style") || "").not.toContain("opacity");
    expect(layout).toHaveBeenCalled();
  });

  it("honors the last intent during rapid opening, closing and switching", () => {
    cleanup = initPremiumServiceAccordion(scope, gsap);
    click(1);
    gsap.globalTimeline.time(gsap.globalTimeline.time() + 0.12, false);
    click(1);
    click(2);
    click(1);
    settle();
    expect(services.map(service => service.open)).toEqual([false, true, false]);
    expect(services[1]!.querySelector("summary")!.getAttribute("aria-expanded")).toBe("true");
    services.forEach(service => expect(service.style.height).toBe(""));
  });

  it("retargets a moving panel when wrapping or content height changes", () => {
    cleanup = initPremiumServiceAccordion(scope, gsap);
    const observer = ResizeObserverHarness.instances[0]!;
    observer.deliver(panels[1]!, 800, 140);
    click(1);
    gsap.globalTimeline.time(gsap.globalTimeline.time() + 0.2, false);
    heights[1] = 280;
    observer.deliver(panels[1]!, 620, 280);
    settle();
    expect(services[1]!.open).toBe(true);
    expect(services[1]!.style.height).toBe("");
    expect(services[1]!.getBoundingClientRect().height).toBe(353);
  });

  it("cleans an interrupted transition and restores native grouping and inline styles", () => {
    (panels[1]!.children[0] as HTMLElement).style.opacity = "0.85";
    cleanup = initPremiumServiceAccordion(scope, gsap);
    click(1);
    cleanup();
    expect(services.map(service => service.open)).toEqual([false, true, false]);
    expect(services.every(service => service.getAttribute("name") === "premium-services")).toBe(true);
    expect((panels[1]!.children[0] as HTMLElement).style.opacity).toBe("0.85");
    expect(services[1]!.querySelector("summary")!.hasAttribute("aria-expanded")).toBe(false);
    expect(ResizeObserverHarness.instances[0]!.observed.size).toBe(0);
    // A native summary click still works after the enhancement listener is removed.
    click(1);
    expect(services[1]!.open).toBe(false);
    settle();
    services.forEach(service => expect(service.style.height).toBe(""));
  });

  it("keeps requested content readable when GSAP cannot create a transition", () => {
    const failingMotion = { ...gsap, to: () => { throw new Error("renderer unavailable"); } } as typeof gsap;
    cleanup = initPremiumServiceAccordion(scope, failingMotion);
    click(1);
    expect(services.map(service => service.open)).toEqual([false, true, false]);
    expect(services[1]!.style.height).toBe("");
    expect(services[1]!.style.overflow).toBe("");
  });
});

describe("ambient CSS playback", () => {
  it("stays static under reduced motion and pauses when outside the viewport or cleaned", () => {
    const reduced = new EventTarget() as MediaQueryList;
    Object.defineProperty(reduced, "matches", { value: true, writable: true });
    const pointer = new EventTarget() as MediaQueryList;
    Object.defineProperty(pointer, "matches", { value: false });
    vi.stubGlobal("matchMedia", (query: string) => query.includes("reduced") ? reduced : pointer);
    scope.innerHTML = '<div data-ambient>Signal</div>';
    const signal = scope.querySelector<HTMLElement>("[data-ambient]")!;
    cleanup = initPremiumMotion();
    const observer = IntersectionObserverHarness.instances[0]!;
    observer.deliver(signal, true);
    expect(signal.style.getPropertyValue("--ambient-play-state")).toBe("paused");
    Object.defineProperty(reduced, "matches", { value: false });
    reduced.dispatchEvent(new Event("change"));
    expect(signal.style.getPropertyValue("--ambient-play-state")).toBe("running");
    const hidden = vi.spyOn(document, "hidden", "get");
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(signal.style.getPropertyValue("--ambient-play-state")).toBe("paused");
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(signal.style.getPropertyValue("--ambient-play-state")).toBe("running");
    const hide = new Event("pagehide");
    Object.defineProperty(hide, "persisted", { value: true });
    window.dispatchEvent(hide);
    expect(signal.style.getPropertyValue("--ambient-play-state")).toBe("paused");
    const show = new Event("pageshow");
    Object.defineProperty(show, "persisted", { value: true });
    window.dispatchEvent(show);
    expect(signal.style.getPropertyValue("--ambient-play-state")).toBe("running");
    observer.deliver(signal, false);
    expect(signal.style.getPropertyValue("--ambient-play-state")).toBe("paused");
    observer.deliver(signal, true);
    cleanup();
    expect(signal.style.getPropertyValue("--ambient-play-state")).toBe("paused");
    expect(observer.observed.size).toBe(0);
  });

  it("honors the site pause button and removes its event listener on cleanup", () => {
    const reduced = new EventTarget() as MediaQueryList;
    Object.defineProperty(reduced, "matches", { value: false, writable: true });
    const pointer = new EventTarget() as MediaQueryList;
    Object.defineProperty(pointer, "matches", { value: false });
    vi.stubGlobal("matchMedia", (query: string) => query.includes("reduced") ? reduced : pointer);
    document.documentElement.dataset.motionPaused = "true";
    scope.innerHTML = '<div data-ambient>Signal</div>';
    const signal = scope.querySelector<HTMLElement>("[data-ambient]")!;
    cleanup = initPremiumMotion();
    const observer = IntersectionObserverHarness.instances[0]!;
    observer.deliver(signal, true);
    expect(signal.style.getPropertyValue("--ambient-play-state")).toBe("paused");
    document.documentElement.dataset.motionPaused = "false";
    document.dispatchEvent(new Event("discoverystack:motion-change"));
    expect(signal.style.getPropertyValue("--ambient-play-state")).toBe("running");
    document.documentElement.dataset.motionPaused = "true";
    document.dispatchEvent(new Event("discoverystack:motion-change"));
    expect(signal.style.getPropertyValue("--ambient-play-state")).toBe("paused");
    cleanup();
    signal.style.setProperty("--ambient-play-state", "sentinel");
    document.documentElement.dataset.motionPaused = "false";
    document.dispatchEvent(new Event("discoverystack:motion-change"));
    expect(signal.style.getPropertyValue("--ambient-play-state")).toBe("sentinel");
  });
});

describe("layered entrance and scroll vocabulary", () => {
  it("uses distinct entrances, shared tokens and one owner for staggered rows", () => {
    scope.innerHTML = `<h2 data-reveal data-reveal-kind="title">Title</h2><details data-reveal data-reveal-kind="line"><summary>Readable row</summary></details><div data-reveal data-reveal-kind="image">Interface</div><div data-reveal-stagger=".08"><article data-reveal data-reveal-kind="card">A</article><article data-reveal data-reveal-kind="card">B</article></div>`;
    scope.style.setProperty("--motion-reveal", "680ms");
    scope.style.setProperty("--motion-distance", "20px");
    const tweens: { revert: ReturnType<typeof vi.fn>, delay: ReturnType<typeof vi.fn>, scrollTrigger: { kill: ReturnType<typeof vi.fn> } }[] = [];
    const from = vi.fn((_targets?: HTMLElement[], _vars?: gsap.TweenVars) => {
      const tween = { revert: vi.fn(), delay: vi.fn(), scrollTrigger: { kill: vi.fn() } };
      tweens.push(tween);
      return tween;
    });
    const fromTo = vi.fn((targets: HTMLElement[], start: gsap.TweenVars) => from(targets, start));
    cleanup = initPremiumReveals(scope, { from, fromTo } as unknown as typeof gsap);
    expect(from).toHaveBeenCalledTimes(5);
    const calls = from.mock.calls as unknown as [HTMLElement[], gsap.TweenVars][];
    const title = calls.find(([targets]) => targets[0]?.tagName === "H2")![1];
    expect(title.rotationX).toBe(8);
    expect(title.duration).toBeCloseTo(.78);
    const row = calls.find(([targets]) => targets[0]?.tagName === "DETAILS")![1];
    expect(row["--reveal-line-progress"]).toBe(0);
    expect(row.scaleX).toBeUndefined();
    const image = calls.find(([targets]) => targets[0]?.dataset.revealKind === "image")![1];
    expect(image.clipPath).toBe("inset(9% 0% 9% 0%)");
    expect(tweens[1]!.delay).toHaveBeenCalledWith(.08);
    cleanup();
    tweens.forEach(tween => { expect(tween.revert).toHaveBeenCalledOnce(); expect(tween.scrollTrigger.kill).toHaveBeenCalledOnce(); });
  });

  it("keeps natural scroll on CSS channels and restores the original layer style", () => {
    scope.innerHTML = '<section data-scroll-story><div data-story-layer="-18" data-story-rotate="3" style="--story-y:7px;transform:rotate(2deg)">Art</div></section>';
    const layer = scope.querySelector<HTMLElement>("[data-story-layer]")!;
    const kill = vi.fn(), killTrigger = vi.fn();
    const fromTo = vi.fn((target: HTMLElement, from: Record<string, string>) => {
      Object.entries(from).forEach(([name, value]) => target.style.setProperty(name, value));
      return { kill, scrollTrigger: { kill: killTrigger } };
    });
    cleanup = initPremiumStoryLayers(scope, { fromTo } as unknown as typeof gsap);
    const to = (fromTo.mock.calls as unknown as [HTMLElement, object, gsap.TweenVars][])[0]![2];
    expect(to.scrollTrigger).toMatchObject({ start: "top 85%", end: "bottom 25%", scrub: .7 });
    expect(to.scrollTrigger).not.toHaveProperty("pin");
    expect(to).not.toHaveProperty("y");
    expect(layer.style.transform).toBe("rotate(2deg)");
    cleanup();
    expect(kill).toHaveBeenCalledOnce();
    expect(killTrigger).toHaveBeenCalledOnce();
    expect(layer.style.getPropertyValue("--story-y")).toBe("7px");
    expect(layer.style.getPropertyValue("--story-rotate")).toBe("");
  });
});

describe("navigation scroll boundary", () => {
  it("stops wheel inertia behind an open menu, resumes only when allowed, and removes the listener", () => {
    const reduced = { matches: false } as MediaQueryList;
    const controller = { stop: vi.fn(), start: vi.fn() };
    document.documentElement.dataset.menuOpen = "true";
    cleanup = initPremiumMenuScrollGuard(controller, reduced);
    expect(controller.stop).toHaveBeenCalledOnce();
    expect(controller.start).not.toHaveBeenCalled();
    document.documentElement.dataset.menuOpen = "false";
    document.dispatchEvent(new Event("discoverystack:menu-change"));
    expect(controller.start).toHaveBeenCalledOnce();
    document.documentElement.dataset.motionPaused = "true";
    document.dispatchEvent(new Event("discoverystack:menu-change"));
    expect(controller.stop).toHaveBeenCalledTimes(2);
    delete document.documentElement.dataset.motionPaused;
    Object.defineProperty(reduced, "matches", { value: true });
    document.dispatchEvent(new Event("discoverystack:menu-change"));
    expect(controller.stop).toHaveBeenCalledTimes(3);
    cleanup();
    document.dispatchEvent(new Event("discoverystack:menu-change"));
    expect(controller.stop).toHaveBeenCalledTimes(3);
    expect(controller.start).toHaveBeenCalledOnce();
  });
});

describe("learning narrative lifecycle", () => {
  it("keeps scroll and direct selection stable, caches path geometry, and suspends all playback", async () => {
    scope.innerHTML = `<section data-learning-engine data-stage="0"><div data-le-scene><svg>${[0, 1, 2, 3].map(index => `<path data-le-flow="${index}"/><circle data-le-traveller/>`).join("")}<g class="le-neuron"/></svg></div><button data-le-play data-play-label="Play" data-pause-label="Pause" hidden><span data-le-play-label></span><span data-le-play-icon></span></button>${[0, 1, 2, 3].map(index => `<button data-le-step="${index}">Step</button>`).join("")}</section>`;
    const engine = scope.querySelector<HTMLElement>("[data-learning-engine]")!;
    const scene = engine.querySelector<HTMLElement>("[data-le-scene]")!;
    const buttons = [...engine.querySelectorAll<HTMLButtonElement>("[data-le-step]")];
    const point = vi.fn((distance: number) => ({ x: distance, y: 40 }));
    engine.querySelectorAll("path").forEach(path => {
      Object.defineProperty(path, "getTotalLength", { value: () => 200 });
      Object.defineProperty(path, "getPointAtLength", { value: point });
    });
    const reduced = new EventTarget() as MediaQueryList;
    Object.defineProperty(reduced, "matches", { value: false, writable: true });
    vi.stubGlobal("matchMedia", () => reduced);
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
    vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
    const advance = (time: number) => [...frames].forEach(([frame, callback]) => { frames.delete(frame); callback(time); });
    const updates: { onUpdate: (trigger: { progress: number }) => void }[] = [];
    const contexts = new Set<object>();
    const mockGsap = {
      registerPlugin: vi.fn(),
      context: () => {
        const context = { add: (callback: () => void) => callback(), revert: () => contexts.delete(context) };
        contexts.add(context);
        return context;
      },
      from: () => ({ paused: vi.fn() }),
      fromTo: () => ({ paused: vi.fn() }),
    };
    const mockTrigger = { create: (options: typeof updates[number]) => updates.push(options) };
    const source = readFileSync(resolve(process.cwd(), "src/components/LearningEngine.astro"), "utf8");
    const script = source.match(/<script>([\s\S]*?)<\/script>/)![1]!
      .replace("import('gsap')", "Promise.resolve({ gsap: motionModules.gsap })")
      .replace("import('gsap/ScrollTrigger')", "Promise.resolve({ ScrollTrigger: motionModules.ScrollTrigger })");
    const compiled = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const run = new Function("motionModules", compiled);
    run({ gsap: mockGsap, ScrollTrigger: mockTrigger });
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    const observer = IntersectionObserverHarness.instances.at(-1)!;
    observer.deliver(scene, true);
    expect(frames.size).toBe(1);
    updates[0]!.onUpdate({ progress: .4 });
    expect(engine.dataset.stage).toBe("1");
    buttons[3]!.click(); buttons[0]!.click(); buttons[2]!.click();
    updates[0]!.onUpdate({ progress: .45 });
    expect(engine.dataset.stage).toBe("2");
    updates[0]!.onUpdate({ progress: .9 });
    expect(engine.dataset.stage).toBe("3");
    expect(buttons[3]!.getAttribute("aria-pressed")).toBe("true");
    const geometryCalls = point.mock.calls.length;
    advance(10); advance(30); advance(50);
    expect(frames.size).toBe(1);
    expect(point).toHaveBeenCalledTimes(geometryCalls);
    const hidden = vi.spyOn(document, "hidden", "get");
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(frames.size).toBe(0);
    hidden.mockReturnValue(false);
    document.documentElement.dataset.motionPaused = "true";
    document.dispatchEvent(new Event("discoverystack:motion-change"));
    expect(engine.style.getPropertyValue("--le-play-state")).toBe("paused");
    expect(contexts.size).toBe(0);
    // Repeated toggles during async imports cannot leave duplicate animations alive.
    document.documentElement.dataset.motionPaused = "false";
    document.dispatchEvent(new Event("discoverystack:motion-change"));
    document.documentElement.dataset.motionPaused = "true";
    document.dispatchEvent(new Event("discoverystack:motion-change"));
    document.documentElement.dataset.motionPaused = "false";
    document.dispatchEvent(new Event("discoverystack:motion-change"));
    await vi.waitFor(() => expect(contexts.size).toBe(1));
    expect(frames.size).toBe(1);
    Object.defineProperty(reduced, "matches", { value: true });
    reduced.dispatchEvent(new Event("change"));
    expect(frames.size).toBe(0);
    expect(contexts.size).toBe(0);
    buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect(engine.dataset.stage).toBe("1");
    Object.defineProperty(reduced, "matches", { value: false });
    reduced.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(contexts.size).toBe(1));
    observer.deliver(scene, false);
    expect(frames.size).toBe(0);
    document.dispatchEvent(new Event("astro:before-swap"));
    expect(contexts.size).toBe(0);
    expect(observer.observed.size).toBe(0);
    buttons[3]!.click();
    expect(engine.dataset.stage).toBe("1");
    expect(engine.querySelectorAll('[data-le-traveller][style="opacity: 0;"]')).toHaveLength(4);
  });
});
