// Wheel zoom, drag pan and fit for the map canvas. The first fit after a
// layout keeps text readable: a wide level starts at the left edge at
// scale 0.6. A view the reader comes back to replaces the first fit.
import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";

export interface Transform {
  x: number;
  y: number;
  k: number;
}
interface Size {
  width: number;
  height: number;
}

const LEGEND_SPACE = 48;
const READABLE = 0.6;
const MAX_FIT = 1.4;

/** The transform that fits `size` into `box`; `readable` caps shrinking and pins the left edge. */
export function fitTransform(box: Size, size: Size, readable: boolean): Transform {
  if (box.width <= 0 || box.height <= 0) return { x: 8, y: 8, k: 1 };
  const k = Math.min(box.width / size.width, (box.height - LEGEND_SPACE) / size.height, MAX_FIT);
  if (readable && k < READABLE) {
    return { k: Math.max(0.15, Math.min(READABLE, ((box.height - LEGEND_SPACE) / size.height) * 1.6)), x: 8, y: 8 };
  }
  return { k, x: (box.width - size.width * k) / 2, y: Math.max(8, (box.height - LEGEND_SPACE - size.height * k) / 2) };
}

export function zoomTransform(tf: Transform, factor: number, cx: number, cy: number): Transform {
  const k = Math.min(4, Math.max(0.15, tf.k * factor));
  return { k, x: cx - ((cx - tf.x) * k) / tf.k, y: cy - ((cy - tf.y) * k) / tf.k };
}

export function usePanZoom(
  ref: RefObject<HTMLDivElement | null>,
  size: Size | null,
  onBackgroundClick: () => void,
  restore: Transform | null = null,
) {
  const [tf, setTf] = useState<Transform>({ x: 0, y: 0, k: 1 });
  const restored = useRef(restore);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  const box = useCallback((): Size => {
    const r = ref.current!.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }, [ref]);
  const fit = useCallback((readable = false) => size && setTf(fitTransform(box(), size, readable)), [box, size]);
  const zoomCenter = useCallback(
    (factor: number) => setTf((t) => zoomTransform(t, factor, box().width / 2, box().height / 2)),
    [box],
  );

  useEffect(() => {
    if (!size) return;
    if (restored.current) setTf(restored.current);
    else fit(true);
    restored.current = null;
  }, [fit, size]);

  useEffect(() => {
    const el = ref.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setTf((t) => zoomTransform(t, Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref]);

  const pointer = {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if ((e.target as Element).closest(".d-node, .d-port, .d-edge, .cmap-legend")) return;
      drag.current = { x: e.clientX, y: e.clientY, tx: tf.x, ty: tf.y, moved: false };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      setTf((t) => ({ ...t, x: d.tx + dx, y: d.ty + dy }));
    },
    onPointerUp: () => {
      if (drag.current && !drag.current.moved) onBackgroundClick();
      drag.current = null;
    },
  };

  return {
    tf,
    transform: `translate(${tf.x},${tf.y}) scale(${tf.k})`,
    fit: () => fit(false),
    zoomIn: () => zoomCenter(1.25),
    zoomOut: () => zoomCenter(0.8),
    pointer,
  };
}
