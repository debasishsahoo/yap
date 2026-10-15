export type LayoutDiagnosticSample = {
  atUs: number;
  canvas: { width: number; height: number };
  texts: readonly {
    id: string;
    bounds: { x: number; y: number; width: number; height: number };
    glyphs?: readonly string[] | undefined;
    fallback?: string | undefined;
  }[];
};

export type LayoutDiagnosticIssue = {
  code: "text-clipped" | "text-off-canvas" | "text-overlap" | "missing-glyph" | "font-fallback";
  message: string;
  textIds: string[];
  evidence: Record<string, unknown>;
};

const intersects = (
  a: LayoutDiagnosticSample["texts"][number]["bounds"],
  b: LayoutDiagnosticSample["texts"][number]["bounds"],
) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Pure sampled evidence. It intentionally says nothing about unsampled frames or editorial quality. */
export function layoutDiagnostics(samples: readonly LayoutDiagnosticSample[], maxIssues = 100) {
  const issues: LayoutDiagnosticIssue[] = [];
  for (const sample of samples) {
    const { width, height } = sample.canvas;
    for (const text of sample.texts) {
      const { x, y, width: w, height: h } = text.bounds;
      const right = x + w;
      const bottom = y + h;
      if (x < 0 || y < 0 || right > width || bottom > height)
        issues.push({
          code: "text-off-canvas",
          message: `Text ${text.id} extends outside the sampled canvas.`,
          textIds: [text.id],
          evidence: { atUs: sample.atUs, bounds: text.bounds, canvas: sample.canvas },
        });
      if (x < 0 || y < 0 || right > width || bottom > height)
        issues.push({
          code: "text-clipped",
          message: `Text ${text.id} may be clipped at the sampled canvas edge.`,
          textIds: [text.id],
          evidence: { atUs: sample.atUs, bounds: text.bounds, canvas: sample.canvas },
        });
      if (text.glyphs?.some((glyph) => glyph.length === 0 || glyph === "missing"))
        issues.push({
          code: "missing-glyph",
          message: `Text ${text.id} contains an unavailable glyph observation.`,
          textIds: [text.id],
          evidence: { atUs: sample.atUs },
        });
      if (text.fallback)
        issues.push({
          code: "font-fallback",
          message: `Text ${text.id} used font fallback: ${text.fallback}.`,
          textIds: [text.id],
          evidence: { atUs: sample.atUs, fallback: text.fallback },
        });
    }
    for (let i = 0; i < sample.texts.length; i++)
      for (let j = i + 1; j < sample.texts.length; j++) {
        const a = sample.texts[i]!,
          b = sample.texts[j]!;
        if (!intersects(a.bounds, b.bounds)) continue;
        issues.push({
          code: "text-overlap",
          message: `Text ${a.id} overlaps text ${b.id} at the sampled time.`,
          textIds: [a.id, b.id],
          evidence: { atUs: sample.atUs },
        });
      }
    if (issues.length >= maxIssues) break;
  }
  return {
    version: 1,
    coverage: { state: "sampled", samples: samples.length, complete: false },
    issues: issues.slice(0, maxIssues),
  };
}
