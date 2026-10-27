// Text width for diagram geometry: canvas measurement when the browser has
// one, otherwise an estimate from the font size (jsdom, early renders).
let context: CanvasRenderingContext2D | null | undefined;

function canvasContext(): CanvasRenderingContext2D | null {
  if (context === undefined) {
    try {
      context = document.createElement("canvas").getContext("2d");
    } catch {
      context = null;
    }
  }
  return context;
}

export function measureText(text: string, font: string): number {
  const ctx = canvasContext();
  if (ctx) {
    ctx.font = font;
    return Math.ceil(ctx.measureText(text).width);
  }
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 13);
  return Math.ceil(size * 0.6 * text.length);
}
