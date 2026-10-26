// Fit and zoom arithmetic for the map canvas.
import { describe, it, expect } from "vitest";
import { fitTransform, zoomTransform } from "../src/map/usePanZoom.js";

describe("fitTransform", () => {
  it("uses identity with an offset when the canvas has no size yet", () => {
    expect(fitTransform({ width: 0, height: 0 }, { width: 100, height: 100 }, true)).toEqual({ x: 8, y: 8, k: 1 });
  });

  it("centers a level that fits, capped at 1.4", () => {
    expect(fitTransform({ width: 1000, height: 648 }, { width: 100, height: 100 }, false)).toEqual({
      k: 1.4,
      x: 430,
      y: 230,
    });
  });

  it("keeps a wide level readable from the left edge", () => {
    const tf = fitTransform({ width: 400, height: 448 }, { width: 4000, height: 400 }, true);
    expect(tf).toEqual({ k: 0.6, x: 8, y: 8 });
  });

  it("shrinks a wide level fully when readability is not asked for", () => {
    expect(fitTransform({ width: 400, height: 448 }, { width: 4000, height: 400 }, false).k).toBe(0.1);
  });
});

describe("zoomTransform", () => {
  it("zooms around a point and clamps the scale", () => {
    expect(zoomTransform({ x: 0, y: 0, k: 1 }, 2, 100, 100)).toEqual({ k: 2, x: -100, y: -100 });
    expect(zoomTransform({ x: 0, y: 0, k: 3 }, 2, 0, 0).k).toBe(4);
    expect(zoomTransform({ x: 0, y: 0, k: 0.2 }, 0.5, 0, 0).k).toBe(0.15);
  });
});
