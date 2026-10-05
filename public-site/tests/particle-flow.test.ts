import { describe, expect, it } from "vitest";
import { clampUnit, pointerFieldWeight, sectionScrollPhase, stepSpring, travellingWave } from "../src/lib/particle-flow";

describe("woven particle flow math", () => {
  it("gives the same critically damped response at 30 and 120 frames per second", () => {
    const simulate = (fps: number) => {
      let state = { value: 0, velocity: 0 };
      for (let frame = 0; frame < fps; frame += 1) state = stepSpring(state, 1, 1 / fps, 8.5);
      return state;
    };
    expect(simulate(30).value).toBeCloseTo(simulate(120).value, 12);
    expect(simulate(30).velocity).toBeCloseTo(simulate(120).velocity, 12);
    expect(simulate(30).value).toBeGreaterThan(.99);
    expect(simulate(30).value).toBeLessThan(1);
  });

  it("keeps momentum continuous during rapid changes and safely caps a resumed frame", () => {
    let state = { value: 0, velocity: 0 };
    for (let frame = 0; frame < 300; frame += 1) {
      state = stepSpring(state, frame % 13 < 6 ? -1 : 1, 1 / 30, 8.5);
      expect(Number.isFinite(state.value + state.velocity)).toBe(true);
      expect(Math.abs(state.value)).toBeLessThanOrEqual(1.1);
      expect(Math.abs(state.velocity)).toBeLessThan(8);
    }
    expect(stepSpring(state, 0, 20)).toEqual(stepSpring(state, 0, .064));
    expect(stepSpring(state, 0, -1)).toEqual(state);
    expect(stepSpring({ value: NaN, velocity: Infinity }, NaN, NaN)).toEqual({ value: 0, velocity: 0 });
  });

  it("returns gently to rest after the pointer leaves", () => {
    let state = { value: .85, velocity: 2 };
    for (let frame = 0; frame < 90; frame += 1) state = stepSpring(state, 0, 1 / 30, 8.5);
    expect(Math.abs(state.value)).toBeLessThan(.000001);
    expect(Math.abs(state.velocity)).toBeLessThan(.000001);
  });

  it("keeps the pointer field local, bounded and smooth at its outer edge", () => {
    expect(pointerFieldWeight(0, 0, .88)).toBe(1);
    expect(pointerFieldWeight(1, 0, .88)).toBe(0);
    expect(pointerFieldWeight(20, 20, .88)).toBe(0);
    expect(pointerFieldWeight(Math.sqrt(.88) - .001, 0, .88)).toBeLessThan(.00000002);
    expect(pointerFieldWeight(.4, -.3, .88)).toBe(pointerFieldWeight(-.4, .3, .88));
    expect(pointerFieldWeight(NaN, 0, 1)).toBe(0);
    expect(pointerFieldWeight(0, 0, 0)).toBe(0);
  });

  it("carries a wave along the material rather than translating all points together", () => {
    const wave = (position: number, phase: number) => travellingWave(Math.sin(position), Math.cos(position), Math.sin(phase), Math.cos(phase));
    expect(wave(.7, .2)).toBeCloseTo(Math.sin(.5), 12);
    const motionA = wave(-1, .6) - wave(-1, 0);
    const motionB = wave(1, .6) - wave(1, 0);
    expect(motionA).not.toBeCloseTo(motionB, 2);
    for (let step = 0; step < 200; step += 1) expect(Math.abs(wave(step / 7, step / 11))).toBeLessThanOrEqual(1.0000000001);
  });

  it("maps only the existing section's departure into a bounded scroll phase", () => {
    expect(sectionScrollPhase(100, 800)).toBe(0);
    expect(sectionScrollPhase(0, 800)).toBe(0);
    expect(sectionScrollPhase(-340, 800)).toBe(.5);
    expect(sectionScrollPhase(-1600, 800)).toBe(1);
    expect(sectionScrollPhase(-10, 0)).toBe(0);
    expect(sectionScrollPhase(NaN, 800)).toBe(0);
    expect(clampUnit(Infinity)).toBe(0);
  });
});
