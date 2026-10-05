// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import ParticleSculpture from "../src/components/ParticleSculpture.vue";

const effect = vi.hoisted(() => ({ create: vi.fn(), destroy: vi.fn(), dispose: vi.fn(), loss: vi.fn(), loop: vi.fn(), resize: vi.fn() }));
vi.mock("three", () => ({}));
vi.mock("vanta/dist/vanta.waves.min.js", () => ({ default: effect.create }));

class ObserverHarness {
  static all: ObserverHarness[] = [];
  elements = new Set<Element>();
  constructor(private callback: (entries: any[]) => void) { ObserverHarness.all.push(this); }
  observe(element: Element) { this.elements.add(element); }
  disconnect() { this.elements.clear(); }
  deliver(visible: boolean) { this.callback([...this.elements].map(target => ({ target, isIntersecting: visible }))); }
}

let wrapper: ReturnType<typeof mount> | undefined;
let reduced: MediaQueryList;
let frames: Map<number, FrameRequestCallback>;
let draws: number;
let particles: number;
let heroTop: number;
let lastPoints: number[][];

const advance = (time: number) => [...frames].forEach(([id, callback]) => { frames.delete(id); callback(time); });
const playbackEvent = () => document.dispatchEvent(new Event("discoverystack:motion-change"));
const pageEvent = (type: string, persisted: boolean) => {
  const event = new Event(type);
  Object.defineProperty(event, "persisted", { value: persisted });
  window.dispatchEvent(event);
};

beforeEach(() => {
  frames = new Map();
  draws = 0; particles = 0; heroTop = 0; lastPoints = [];
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("IntersectionObserver", ObserverHarness);
  vi.stubGlobal("ResizeObserver", ObserverHarness);
  ObserverHarness.all = [];
  reduced = new EventTarget() as MediaQueryList;
  Object.defineProperty(reduced, "matches", { value: false, writable: true });
  const fine = new EventTarget() as MediaQueryList;
  Object.defineProperty(fine, "matches", { value: true });
  const narrow = new EventTarget() as MediaQueryList;
  Object.defineProperty(narrow, "matches", { value: false });
  vi.stubGlobal("matchMedia", (query: string) => query.includes("reduced") ? reduced : query.includes("pointer") ? fine : narrow);
  vi.stubGlobal("devicePixelRatio", 3);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const height = this.tagName === "SECTION" ? 800 : 600;
    return { width: 600, height, top: heroTop, bottom: heroTop + height, left: 0, right: 600, x: 0, y: heroTop, toJSON: () => {} };
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform: () => {}, beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => {},
    clearRect: () => { draws += 1; particles = 0; lastPoints = []; },
    fillRect: (x: number, y: number) => { particles += 1; if (lastPoints.length < 8) lastPoints.push([x, y]); },
  } as unknown as CanvasRenderingContext2D);
  effect.create.mockImplementation(({ el }: { el: HTMLElement }) => {
    const canvas = document.createElement("canvas");
    el.append(canvas);
    return {
      req: 900000, resize: effect.resize, animationLoop: effect.loop,
      destroy: () => { effect.destroy(); canvas.remove(); },
      renderer: { domElement: canvas, dispose: effect.dispose, forceContextLoss: effect.loss },
    };
  });
  document.body.innerHTML = '<section id="particle-test"></section>';
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  frames.clear();
  document.body.innerHTML = "";
  delete document.documentElement.dataset.motionPaused;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.values(effect).forEach(mock => mock.mockClear());
});

describe("fluid sculpture lifecycle and frame budget", () => {
  it("renders bounded material, damps pointer/scroll movement, and pauses safely through every lifecycle", async () => {
    wrapper = mount(ParticleSculpture, { attachTo: document.querySelector("section")! });
    await vi.waitFor(() => expect(effect.create).toHaveBeenCalledOnce());
    expect(frames.size).toBe(1);
    expect(particles).toBe(4800);
    const canvas = wrapper.get(".particle-sculpture__canvas").element as HTMLCanvasElement;
    expect(canvas.width).toBe(1200); // DPR is capped at two even on a 3x display.
    const initial = lastPoints.map(point => [...point]);
    const initialDraws = draws;
    const parent = document.querySelector("section")!;
    const pointer = new Event("pointermove");
    Object.assign(pointer, { clientX: 345, clientY: 330, pointerType: "mouse" });
    parent.dispatchEvent(pointer);
    for (let time = 16; time <= 1000; time += 16) advance(time);
    expect(draws - initialDraws).toBeLessThanOrEqual(30);
    expect(draws - initialDraws).toBeGreaterThan(15);
    expect(lastPoints).not.toEqual(initial);
    expect(lastPoints.flat().every(Number.isFinite)).toBe(true);
    expect(particles).toBe(4800);
    heroTop = -280;
    window.dispatchEvent(new Event("scroll"));
    advance(1050); advance(1100);
    const flowing = draws;
    document.documentElement.dataset.motionPaused = "true";
    playbackEvent();
    expect(frames.size).toBe(0);
    advance(3000);
    expect(draws).toBe(flowing);
    document.documentElement.dataset.motionPaused = "false";
    playbackEvent(); playbackEvent();
    expect(frames.size).toBe(1);
    expect(effect.loop).toHaveBeenCalledOnce();
    pageEvent("pagehide", true);
    expect(frames.size).toBe(0);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(frames.size).toBe(0); // BFCache suspension cannot be restarted by visibility.
    pageEvent("pageshow", true);
    expect(frames.size).toBe(1);
    ObserverHarness.all[0]!.deliver(false);
    expect(frames.size).toBe(0);
    ObserverHarness.all[0]!.deliver(true);
    expect(frames.size).toBe(1);
    Object.defineProperty(reduced, "matches", { value: true });
    reduced.dispatchEvent(new Event("change"));
    expect(frames.size).toBe(0);
    expect(effect.destroy).toHaveBeenCalledOnce();
    expect(effect.dispose).toHaveBeenCalledOnce();
    expect(effect.loss).toHaveBeenCalledOnce();
    expect(particles).toBe(4800); // A complete static aesthetic remains visible.
    Object.defineProperty(reduced, "matches", { value: false });
    reduced.dispatchEvent(new Event("change"));
    await flushPromises();
    expect(effect.create).toHaveBeenCalledTimes(2);
    document.dispatchEvent(new Event("astro:before-swap"));
    expect(frames.size).toBe(0);
    expect(ObserverHarness.all.every(observer => observer.elements.size === 0)).toBe(true);
    const cleanedDraws = draws;
    playbackEvent(); pageEvent("pageshow", true); parent.dispatchEvent(pointer);
    advance(5000);
    expect(draws).toBe(cleanedDraws);
    expect(effect.destroy).toHaveBeenCalledTimes(2);
  });

  it("does not construct Vanta if the global pause arrives while modules are loading", async () => {
    wrapper = mount(ParticleSculpture, { attachTo: document.querySelector("section")! });
    document.documentElement.dataset.motionPaused = "true";
    playbackEvent();
    await flushPromises();
    expect(effect.create).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(particles).toBe(4800);
    document.documentElement.dataset.motionPaused = "false";
    playbackEvent();
    await flushPromises();
    expect(effect.create).toHaveBeenCalledOnce();
    expect(frames.size).toBe(1);
  });

  it("keeps mobile touch native and uses the smaller static/reduced-motion budget", async () => {
    const desktopMatchMedia = window.matchMedia;
    vi.stubGlobal("matchMedia", (query: string) => query.includes("max-width") ? { matches: true } : desktopMatchMedia(query));
    Object.defineProperty(reduced, "matches", { value: true });
    wrapper = mount(ParticleSculpture, { attachTo: document.querySelector("section")! });
    await flushPromises();
    expect(frames.size).toBe(0);
    expect(particles).toBe(2600);
    expect((wrapper.get(".particle-sculpture__canvas").element as HTMLCanvasElement).width).toBe(900);
    expect(effect.create).not.toHaveBeenCalled();
    Object.defineProperty(reduced, "matches", { value: false });
    reduced.dispatchEvent(new Event("change"));
    expect(frames.size).toBe(1);
    const touch = new Event("pointermove", { cancelable: true });
    Object.assign(touch, { clientX: 345, clientY: 330, pointerType: "touch" });
    document.querySelector("section")!.dispatchEvent(touch);
    expect(touch.defaultPrevented).toBe(false);
    advance(50); advance(100);
    expect(particles).toBe(2600);
    expect(effect.create).not.toHaveBeenCalled();
  });
});
