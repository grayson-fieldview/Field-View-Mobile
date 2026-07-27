import type {
  AnnotationStroke,
  CanonicalStroke,
  KnownStrokeType,
  PixelStroke,
  StoredStroke,
  StrokePoint,
} from "./types.ts";
import { isKnownStrokeType } from "./types.ts";
import { newStrokeId } from "./id.ts";

/**
 * Coordinate-space conversions between the mobile renderer (px against a
 * concrete canvas box) and the canonical cross-platform wire format.
 * All boundary conversion lives here so the rest of the app can hold a
 * single tolerant model and convert only at the read/write edge.
 *
 * Canonical contract (confirmed against the production web bundle, 2026-07):
 *   points: [{x,y}] normalized 0..1, clamped, vs the displayed canvas box
 *   type:   "pencil" | "line" | "arrow" | "circle" | "rectangle" | "text"
 *           line/arrow/rectangle: points = [start, end]
 *           circle:               points = [center, radiusPoint]
 *   width:  see widthToPx() — web writes integer display px (slider 1..8);
 *           legacy mobile wrote non-integer 1000-virtual-canvas units.
 *           NEW mobile strokes write integer px to match the web.
 *   color:  string
 *   text strokes carry no points: { type:"text", x, y, content, color,
 *           fontSize } with fontSize in display px, anchored top-left.
 */

export const DEFAULT_STROKE_WIDTH = 3;

/**
 * Text-size resolution — mirrored EXACTLY from the web repo's
 * client/src/lib/annotation-svg.tsx (same constant, same helper name,
 * same signature; do not invent a variant). Stored fontSize is treated
 * as units in a 1000-tall reference space and scaled to the surface's
 * rendered height, so text keeps its proportion to the photo on every
 * surface (thumbnail, full viewer, server-side PDF flatten).
 */
export const FONT_REFERENCE_HEIGHT = 1000;

export function resolveFontSize(
  strokeFontSize: number,
  renderedHeightPx: number,
): number {
  return (strokeFontSize / FONT_REFERENCE_HEIGHT) * renderedHeightPx;
}
const DEFAULT_COLOR = "#ef4444";

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Width-unit discrimination (Task 0). The two clients historically
 * disagree on units:
 *   - Web writes/reads raw display px. Its picker is an integer slider
 *     (min 1, max 8, default 3) and its canvas renderer does
 *     `ctx.lineWidth = stroke.width` with no scaling.
 *   - Legacy mobile wrote 1000-virtual-canvas units, i.e.
 *     (penPx / canvasW) * 1000 — virtually always NON-integer
 *     (e.g. 5px on a 335px canvas → 14.925373...).
 *
 * Read-time-only resolution, in priority order (never rewrites storage;
 * no value inspection, no timestamp decoding):
 *   1. Local legacy `size`/`canvasW` metadata — authoritative px
 *      (handled by the callers before width is consulted).
 *   2. Bare base-36 id (the legacy mobile newId() format) →
 *      1000-units, ALWAYS. Legacy builds are the only base-36 minters;
 *      new mobile strokes mint `fv-` UUIDs (services/id.ts).
 *   3. Everything else → raw px: web crypto.randomUUID() ids, the web
 *      `s-${Date.now()}-...` insecure-context fallback, and new mobile
 *      `fv-` ids. Ids matching NONE of the known shapes still resolve
 *      as px but are reported (console.warn + Sentry breadcrumb) so we
 *      can measure whether the catch-all is load-bearing.
 */

/**
 * Legacy mobile stroke-id classifier: no dashes, <= 20 chars, lowercase
 * base-36 with at least one char in [g-z]. The [g-z] requirement is what
 * excludes UUIDs-without-dashes (pure hex): it is deterministically
 * satisfied by the id's FIRST char, because Date.now().toString(36) has
 * led with a char >= 'g' since Sep 2009 and will until the timestamp
 * grows to 9 base-36 digits on 2059-05-25 — after which this guarantee
 * would rest on the random suffix alone. (Legacy ids stopped being
 * minted in 2026, so the window is comfortably covered.)
 */
export function isLegacyMobileStrokeId(id: unknown): boolean {
  return (
    typeof id === "string" &&
    id.length <= 20 &&
    /^[0-9a-z]+$/.test(id) &&
    /[g-z]/.test(id)
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for id shapes known to mark raw-px widths. */
function isKnownPxStrokeId(id: unknown): boolean {
  return (
    typeof id === "string" &&
    (UUID_RE.test(id) || id.startsWith("s-") || id.startsWith("fv-"))
  );
}

/**
 * Hook for reporting ids that match none of the known shapes (step 3
 * catch-all). Kept as an injected callback so this module stays free of
 * React Native / Sentry imports and remains runnable under `node --test`;
 * services/sentry.ts wires it to a Sentry breadcrumb at app startup.
 */
let unclassifiedIdReporter: ((id: unknown, width: number) => void) | null =
  null;
/** Ids already reported this app run (String(id), so undefined dedupes too). */
const warnedUnclassifiedIds = new Set<string>();
/** Test hook: reset the per-run warn dedupe. */
export function resetUnclassifiedStrokeIdWarnings(): void {
  warnedUnclassifiedIds.clear();
}
export function setUnclassifiedStrokeIdReporter(
  fn: ((id: unknown, width: number) => void) | null,
): void {
  unclassifiedIdReporter = fn;
}

/**
 * Resolve a canonical `width` to display px against a render box of
 * width `boxW`, using the stroke's `id` for provenance (see above).
 */
export function widthToPx(
  width: number | undefined,
  boxW: number,
  id?: unknown,
): number {
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) {
    return DEFAULT_STROKE_WIDTH;
  }
  // Step 2: bare base-36 id → legacy mobile → 1000-units, always.
  if (isLegacyMobileStrokeId(id)) return (width * boxW) / 1000;
  // Step 3: everything else is px. Report shapes we don't recognize —
  // ONCE per id per app run: widthToPx is called from render-path
  // useMemos that re-run on every layout change, so an undeduped warn +
  // Sentry breadcrumb would fire repeatedly for the same stroke.
  if (!isKnownPxStrokeId(id) && !warnedUnclassifiedIds.has(String(id))) {
    warnedUnclassifiedIds.add(String(id));
    console.warn(
      `[annotations] stroke id matches no known shape; width read as px (id=${String(id)}, width=${width})`,
    );
    unclassifiedIdReporter?.(id, width);
  }
  return width;
}

/** fontSize is display px on both clients (web renders `${fontSize}px`). */
export const DEFAULT_FONT_SIZE = 18;
/**
 * Text tool size ladder. Deliberately NOT the pen set — {3,6,12} are
 * stroke widths in px and are unreadable as type. 18 is the web default.
 * Server clamps fontSize to 8..96; keep the ladder inside that range.
 */
export const TEXT_FONT_SIZES = [14, 18, 24, 32] as const;
/** Server contract: content is z.string().min(1).max(500). */
export const MAX_TEXT_CONTENT_LENGTH = 500;

/**
 * Build a canonical text stroke from a tap point (raw px, TOP-LEFT of the
 * text — web draws with canvas textBaseline="top") plus typed content.
 *
 * Returns null when the trimmed content is empty: an empty `content`
 * fails the server's z.string().min(1) and 400s the ENTIRE annotation
 * row, destroying every other stroke on the photo. Callers must treat
 * null as "user cancelled — commit nothing".
 */
export function textToCanonical(input: {
  xPx: number;
  yPx: number;
  content: string;
  color: string;
  fontSize: number;
  canvasW: number;
  canvasH: number;
}): CanonicalStroke | null {
  const content = input.content.trim().slice(0, MAX_TEXT_CONTENT_LENGTH);
  if (content.length === 0) return null;
  if (!(input.canvasW > 0) || !(input.canvasH > 0)) return null;
  return {
    id: newStrokeId(),
    type: "text",
    x: clamp01(input.xPx / input.canvasW),
    y: clamp01(input.yPx / input.canvasH),
    content,
    color: input.color,
    fontSize: Math.min(
      96,
      Math.max(8, Number.isFinite(input.fontSize) ? input.fontSize : DEFAULT_FONT_SIZE),
    ),
  };
}

/**
 * The rectangle a contain-fitted image occupies inside a container
 * (expo-image contentFit="contain", centered — same math as CSS
 * object-fit: contain). This is the coordinate basis the WEB editor
 * normalizes against; mobile must normalize/denormalize against this
 * rect, never the raw container box, or strokes land in a different
 * basis per client (the container includes letterbox bars the web's
 * basis excludes).
 *
 * Returns null until both boxes are known — callers must render NO
 * annotations and accept NO touches rather than fall back to the
 * container (drawing against the wrong basis for even a frame writes
 * wrong coordinates).
 */
export function fittedContainRect(
  containerW: number,
  containerH: number,
  imageW: number,
  imageH: number,
): { x: number; y: number; w: number; h: number } | null {
  if (
    !(containerW > 0) ||
    !(containerH > 0) ||
    !(imageW > 0) ||
    !(imageH > 0)
  ) {
    return null;
  }
  const scale = Math.min(containerW / imageW, containerH / imageH);
  const w = imageW * scale;
  const h = imageH * scale;
  return { x: (containerW - w) / 2, y: (containerH - h) / 2, w, h };
}

// ---------- Selection: hit-testing, bounds, translation ----------

/**
 * Finger-friendly tap tolerance for selecting a stroke, in DISPLAY px
 * (rect-space, same basis as the resolved RenderShape geometry). Never
 * express tolerance in normalized units — 20px of finger is 20px
 * regardless of photo aspect.
 */
export const HIT_TOLERANCE_PX = 20;

function distToPoint(px: number, py: number, x: number, y: number): number {
  return Math.hypot(px - x, py - y);
}

/** Distance from point to segment [a,b] (px). */
export function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return distToPoint(px, py, x1, y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return distToPoint(px, py, x1 + t * dx, y1 + t * dy);
}

/**
 * Hit metric for one resolved shape at a rect-space px point.
 * `d` = distance to the shape's drawn geometry; `contained` = the point
 * is inside the shape's closed bounds (rectangle interior / text box).
 * Contained-only hits are accepted regardless of `d`, but RANK by an
 * effective distance of min(d, tolerance) — so a small shape sitting
 * inside a large rectangle/text box wins when tapped directly (its d is
 * near 0; the big shape's effective distance floors at the tolerance).
 */
export function hitDistancePx(
  shape: RenderShape,
  px: number,
  py: number,
): { d: number; contained: boolean } {
  switch (shape.kind) {
    case "pencil": {
      const pts = shape.points;
      if (pts.length === 0) return { d: Infinity, contained: false };
      if (pts.length === 1)
        return { d: distToPoint(px, py, pts[0].x, pts[0].y), contained: false };
      let best = Infinity;
      for (let i = 1; i < pts.length; i++) {
        best = Math.min(
          best,
          distToSegment(px, py, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y),
        );
      }
      return { d: best, contained: false };
    }
    case "line":
    case "arrow":
      // Arrow: the head is derived decoration off the same segment —
      // testing the shaft alone is the contract.
      return {
        d: distToSegment(px, py, shape.x1, shape.y1, shape.x2, shape.y2),
        contained: false,
      };
    case "circle":
      return {
        d: Math.abs(distToPoint(px, py, shape.cx, shape.cy) - shape.r),
        contained: false,
      };
    case "rectangle": {
      const x2 = shape.x + shape.w;
      const y2 = shape.y + shape.h;
      const d = Math.min(
        distToSegment(px, py, shape.x, shape.y, x2, shape.y),
        distToSegment(px, py, x2, shape.y, x2, y2),
        distToSegment(px, py, x2, y2, shape.x, y2),
        distToSegment(px, py, shape.x, y2, shape.x, shape.y),
      );
      const contained =
        px >= shape.x && px <= x2 && py >= shape.y && py <= y2;
      return { d, contained };
    }
    case "text": {
      const b = shapeBoundsPx(shape);
      const contained =
        px >= b.minX && px <= b.maxX && py >= b.minY && py <= b.maxY;
      const d = Math.min(
        distToSegment(px, py, b.minX, b.minY, b.maxX, b.minY),
        distToSegment(px, py, b.maxX, b.minY, b.maxX, b.maxY),
        distToSegment(px, py, b.maxX, b.maxY, b.minX, b.maxY),
        distToSegment(px, py, b.minX, b.maxY, b.minX, b.minY),
      );
      return { d, contained };
    }
  }
}

/**
 * Axis-aligned bounds of a resolved shape in rect-space px. Text width
 * is an approximation (~0.6em per glyph, weight 600) — SVG text can't
 * be measured synchronously in RN; good enough for tap targets and
 * drag clamping.
 */
export function shapeBoundsPx(shape: RenderShape): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  switch (shape.kind) {
    case "pencil": {
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const p of shape.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      if (shape.points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      return { minX, minY, maxX, maxY };
    }
    case "line":
    case "arrow":
      return {
        minX: Math.min(shape.x1, shape.x2),
        minY: Math.min(shape.y1, shape.y2),
        maxX: Math.max(shape.x1, shape.x2),
        maxY: Math.max(shape.y1, shape.y2),
      };
    case "circle":
      return {
        minX: shape.cx - shape.r,
        minY: shape.cy - shape.r,
        maxX: shape.cx + shape.r,
        maxY: shape.cy + shape.r,
      };
    case "rectangle":
      return {
        minX: shape.x,
        minY: shape.y,
        maxX: shape.x + shape.w,
        maxY: shape.y + shape.h,
      };
    case "text": {
      const w = Math.max(
        shape.fontSize * 0.6,
        shape.content.length * shape.fontSize * 0.6,
      );
      return {
        minX: shape.x,
        minY: shape.y,
        maxX: shape.x + w,
        maxY: shape.y + shape.fontSize,
      };
    }
  }
}

/**
 * Hit-test a rect-space px point against a list of stored strokes
 * resolved at (w × h) — the FITTED IMAGE RECT size, never the container.
 * Returns the stroke id of the best hit, or null.
 *
 * Overlap resolution: effective distance = contained ? min(d, tol) : d;
 * lowest wins; ties go to the LATER stroke in the array (topmost in
 * paint order) because iteration runs back-to-front with strict `<`.
 * Strokes without a stable id are unselectable (nothing to write back).
 */
export function hitTestStrokesPx(
  strokes: StoredStroke[],
  px: number,
  py: number,
  w: number,
  h: number,
  tol: number = HIT_TOLERANCE_PX,
): string | null {
  let bestId: string | null = null;
  let bestEff = Infinity;
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i];
    if (typeof s.id !== "string" || s.id.length === 0) continue;
    const shape = strokeToRenderShape(s, w, h);
    if (!shape) continue;
    const { d, contained } = hitDistancePx(shape, px, py);
    const eff = contained ? Math.min(d, tol) : d;
    if (eff > tol) continue;
    if (eff < bestEff) {
      bestEff = eff;
      bestId = s.id;
    }
  }
  return bestId;
}

/**
 * Translate a stroke by a NORMALIZED delta (fractions of the fitted
 * rect — callers convert px drag deltas via dx/rect.w, dy/rect.h and
 * pre-clamp so the stroke stays inside the rect; clamp01 here is a
 * safety net only). Returns a CANONICAL stroke: legacy px-basis strokes
 * are canonicalized first (toCanonicalForSave preserves ids), so a
 * moved stroke is always stored in the fitted-rect basis.
 */
export function translateStroke(
  s: StoredStroke,
  dxN: number,
  dyN: number,
): CanonicalStroke {
  const c = toCanonicalForSave(s);
  if (c.type === "text") {
    return {
      ...c,
      x: typeof c.x === "number" ? clamp01(c.x + dxN) : c.x,
      y: typeof c.y === "number" ? clamp01(c.y + dyN) : c.y,
    };
  }
  if (!Array.isArray((c as { points?: unknown }).points)) return c;
  const pts = (c as { points: { x: number; y: number }[] }).points;
  return {
    ...c,
    points: pts.map((p) => ({
      x: clamp01(p.x + dxN),
      y: clamp01(p.y + dyN),
    })),
  } as CanonicalStroke;
}

/** True when a stored stroke carries legacy px canvas metadata. */
export function hasCanvasMeta(s: StoredStroke): boolean {
  return (
    typeof s.canvasW === "number" &&
    typeof s.canvasH === "number" &&
    s.canvasW > 0 &&
    s.canvasH > 0
  );
}

/**
 * Resolve ANY stored stroke to px against the render box (w,h).
 *
 * Tolerant normalization (requirement #3): a stroke is first reduced to
 * 0..1, then scaled to px.
 *   - legacy px with canvasW/H -> divide by its own canvas
 *   - px without canvas metadata (any coord > 1) -> best-effort divide by
 *     the current render box
 *   - otherwise -> already 0..1
 * Width: canonical `width` (1000-units) wins; legacy `size` (px) is scaled
 * by its own canvas; else the default.
 */
export function toPixels(s: StoredStroke, w: number, h: number): PixelStroke {
  const pts = Array.isArray(s.points) ? s.points : [];
  let norm: { x: number; y: number }[];
  if (hasCanvasMeta(s)) {
    const cw = s.canvasW as number;
    const ch = s.canvasH as number;
    norm = pts.map((p) => ({ x: p.x / cw, y: p.y / ch }));
  } else if (pts.some((p) => p.x > 1 || p.y > 1)) {
    norm = pts.map((p) => ({ x: w ? p.x / w : 0, y: h ? p.y / h : 0 }));
  } else {
    norm = pts;
  }

  let sizePx: number;
  if (typeof s.width === "number") {
    sizePx = widthToPx(s.width, w, s.id);
  } else if (typeof s.size === "number" && hasCanvasMeta(s)) {
    // Gen-1 legacy px: use RAW px, unscaled — this must agree with what
    // toCanonicalForSave writes (Math.round(s.size)), or the same stroke
    // renders at one thickness before save and another after. Raw px is
    // also the web convention (web never scales widths by canvas).
    sizePx = s.size;
  } else if (typeof s.size === "number") {
    sizePx = (s.size * w) / 1000;
  } else {
    sizePx = DEFAULT_STROKE_WIDTH;
  }

  return {
    type: s.type,
    color: s.color ?? DEFAULT_COLOR,
    size: sizePx,
    points: norm.map((p) => ({ x: p.x * w, y: p.y * h })),
  };
}

/** Tolerantly reduce a stored stroke's points to normalized 0..1. */
function normalizedPoints(s: StoredStroke): StrokePoint[] {
  const pts = Array.isArray(s.points) ? s.points : [];
  if (hasCanvasMeta(s)) {
    const cw = s.canvasW as number;
    const ch = s.canvasH as number;
    return pts.map((p) => ({ x: p.x / cw, y: p.y / ch }));
  }
  return pts;
}

/**
 * A stroke resolved to concrete display geometry against a render box —
 * everything the SVG layer needs, one variant per renderable kind.
 * Derived, never stored.
 */
export type RenderShape =
  | { kind: "pencil"; color: string; strokeWidth: number; points: StrokePoint[] }
  | {
      kind: "line" | "arrow";
      color: string;
      strokeWidth: number;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    }
  | {
      kind: "circle";
      color: string;
      strokeWidth: number;
      cx: number;
      cy: number;
      r: number;
    }
  | {
      kind: "rectangle";
      color: string;
      strokeWidth: number;
      x: number;
      y: number;
      w: number;
      h: number;
    }
  | { kind: "text"; color: string; x: number; y: number; content: string; fontSize: number };

/**
 * Resolve ANY stored stroke to a renderable shape against box (w,h) px.
 * Returns null for unknown/unrenderable strokes — the renderer skips
 * them, but they are still preserved in the data and on save.
 *
 * Geometry matches the production web canvas renderer:
 *   line/arrow/rectangle: points[0] = start, points[1] = end
 *   circle:               points[0] = center, points[1] = a point on the
 *                         circumference; r = px distance between them
 *                         (a true circle, not an ellipse)
 *   text:                 top-level x/y (normalized), top-left anchored,
 *                         fontSize raw px
 */
export function strokeToRenderShape(
  s: StoredStroke,
  w: number,
  h: number,
): RenderShape | null {
  if (!w || !h) return null;
  const color = s.color ?? DEFAULT_COLOR;
  const type = (s.type ?? "pencil") as KnownStrokeType | string;

  if (type === "text") {
    if (
      typeof s.x !== "number" ||
      typeof s.y !== "number" ||
      typeof s.content !== "string" ||
      s.content.length === 0
    ) {
      return null;
    }
    return {
      kind: "text",
      color,
      x: clamp01(s.x) * w,
      y: clamp01(s.y) * h,
      content: s.content,
      // RAW stored px — the full-size viewer's fitted rect is the basis
      // these values were authored against. resolveFontSize is applied
      // ONLY by callers whose render basis is the 1000-unit reference
      // space (the thumbnail overlay), never here.
      fontSize:
        typeof s.fontSize === "number" && s.fontSize > 0
          ? s.fontSize
          : DEFAULT_FONT_SIZE,
    };
  }

  const pts = normalizedPoints(s);
  const strokeWidth =
    typeof s.width === "number"
      ? widthToPx(s.width, w, s.id)
      : // Gen-1 legacy px: raw, unscaled — must agree with the saved
        // width (toCanonicalForSave writes Math.round(s.size)).
        typeof s.size === "number" && hasCanvasMeta(s)
        ? s.size
        : typeof s.size === "number"
          ? (s.size * w) / 1000
          : DEFAULT_STROKE_WIDTH;

  if (type === "pencil") {
    if (pts.length === 0) return null;
    return {
      kind: "pencil",
      color,
      strokeWidth,
      points: pts.map((p) => ({ x: p.x * w, y: p.y * h })),
    };
  }

  if (type === "line" || type === "arrow" || type === "rectangle" || type === "circle") {
    if (pts.length < 2) return null;
    const a = { x: pts[0].x * w, y: pts[0].y * h };
    const b = { x: pts[1].x * w, y: pts[1].y * h };
    if (type === "circle") {
      return {
        kind: "circle",
        color,
        strokeWidth,
        cx: a.x,
        cy: a.y,
        r: Math.hypot(b.x - a.x, b.y - a.y),
      };
    }
    if (type === "rectangle") {
      return {
        kind: "rectangle",
        color,
        strokeWidth,
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        w: Math.abs(b.x - a.x),
        h: Math.abs(b.y - a.y),
      };
    }
    return { kind: type, color, strokeWidth, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  }

  // Unknown/future stroke type: not renderable here, but NEVER dropped
  // from the data — toCanonicalForSave passes it through unchanged.
  return null;
}

/**
 * Arrowhead geometry, derived (never stored) — matches the web renderer:
 * head length max(12, strokeWidthPx * 4) px, half-angle π/6 off the shaft.
 */
export function arrowHeadPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  strokeWidthPx: number,
): string {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.max(12, strokeWidthPx * 4);
  const a1 = angle - Math.PI / 6;
  const a2 = angle + Math.PI / 6;
  const f = (n: number) => n.toFixed(1);
  return (
    `M${f(x2)} ${f(y2)} L${f(x2 - len * Math.cos(a1))} ${f(y2 - len * Math.sin(a1))} ` +
    `M${f(x2)} ${f(y2)} L${f(x2 - len * Math.cos(a2))} ${f(y2 - len * Math.sin(a2))}`
  );
}

/**
 * Convert a freshly-drawn raw px stroke (carrying canvasW/H) to canonical
 * form: points clamped to 0..1, width in integer display px (the web
 * convention — see widthToPx), type from the active tool (Phase 1: the
 * editor only produces "pencil").
 */
export function rawToCanonical(
  s: AnnotationStroke,
  type: KnownStrokeType = "pencil",
): CanonicalStroke {
  const cw = s.canvasW && s.canvasW > 0 ? s.canvasW : 1;
  const ch = s.canvasH && s.canvasH > 0 ? s.canvasH : 1;
  return {
    // Freshly-drawn stroke: stamp a stable `fv-` id once, at creation —
    // the id shape marks this stroke's width as raw px (see widthToPx).
    id: newStrokeId(),
    type,
    points: (s.points ?? []).map((p) => ({
      x: clamp01(p.x / cw),
      y: clamp01(p.y / ch),
    })),
    color: s.color ?? DEFAULT_COLOR,
    // Integer px, matching what the web writes and renders. Legacy mobile
    // wrote (size/canvasW)*1000 here, which the web rendered ~3x too
    // thick; the read-time heuristic still honors those old values.
    width: typeof s.size === "number" ? Math.max(1, Math.round(s.size)) : DEFAULT_STROKE_WIDTH,
  };
}

/**
 * The mobile pen set — sourced from git history, not inferred: every
 * revision that ever defined the pen-size UI used exactly [3, 6, 12]
 * (git log -G "SIZES = [" shows only this array, from the first photo
 * editor commit onward). So the observed production width 14.9254 is
 * pen 6 authored on a 402pt canvas (6/402*1000), not pen 5 on 335pt —
 * 5 was never a mobile pen.
 */
export const LEGACY_PEN_SIZES_PX = [3, 6, 12] as const;

/**
 * Real iOS logical widths a legacy stroke could have been authored on.
 * Phones + iPads; used to INVERT the legacy unit formula rather than
 * assuming a canvas width (a fixed 375 assumption converts every
 * tablet-authored stroke one pen step too thin: iPad 768 pen 6 →
 * 2.93 → "3").
 */
export const IOS_LOGICAL_WIDTHS = [
  320, 375, 390, 393, 402, 414, 428, 430, // phones
  744, 768, 810, 820, 834, 1024, 1080, 1112, 1133, // iPads
] as const;

/**
 * Recover the authoring pen (px) from a legacy 1000-unit width by
 * inverse solve: u = 1000p/c → c = 1000p/u for each pen p; keep the
 * pen whose implied canvas width matches a real device width.
 * Uniqueness: a collision would need one real width to be exactly 2×
 * (or 4×) another; none are, at the 0.75pt tolerance used here (the
 * nearest near-misses are 744 vs 2×372≈375 and 834 vs 2×417≈414,
 * ~3pt apart — stored units carry full float precision, so a genuine
 * match lands within ~1e-9).
 * Returns null when NO pen maps to a real width — callers must log
 * for manual review, never convert on a guess.
 */
export function recoverLegacyPen(units: number): number | null {
  if (!Number.isFinite(units) || units <= 0) return null;
  const matches: number[] = [];
  for (const p of LEGACY_PEN_SIZES_PX) {
    const c = (1000 * p) / units;
    if (IOS_LOGICAL_WIDTHS.some((w) => Math.abs(c - w) <= 0.75)) {
      matches.push(p);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Convert ANY stored stroke into canonical wire form for the server.
 *   - "text" strokes are preserved, with x/y clamped to 0..1 and
 *     fontSize clamped to 8..96 on write (the server clamps fontSize
 *     but NOT coordinates — confirmed from the deployed schema).
 *     Phase 4 note: `content` is z.string().min(1) server-side — an
 *     EMPTY text stroke 400s the ENTIRE row and loses every annotation
 *     on the photo. The text tool must never save empty content.
 *   - UNKNOWN/future stroke types pass through UNCHANGED (aside from a
 *     guaranteed id) — a newer web client's data must never be narrowed
 *     or destroyed by a mobile round-trip.
 *   - legacy px (canvasW/H) strokes are normalized + stamped "pencil",
 *     with width converted to integer px (web convention).
 *   - ID-LESS strokes with a bare `width` are, by construction, from the
 *     post-5f1409c / pre-22a8844 window — inside the 1000-unit era. Their
 *     width is NORMALIZED to px via inverse pen recovery (recoverLegacyPen)
 *     BEFORE an `fv-` id is minted, so the new id honestly self-describes
 *     a px width instead of mislabeling a 1000-unit one. Units matching no
 *     real device width are logged and kept VERBATIM — never converted on
 *     a guess. (The canvasMeta check above must stay first: Gen-1 id-less
 *     px strokes are unaffected.)
 *   - already-canonical strokes (with ids) pass through with a
 *     guaranteed valid type; their width value is preserved VERBATIM
 *     (the id-based read heuristic handles both unit conventions, so
 *     rewriting stored widths would only lose information).
 * Strokes the mobile renderer can't draw are NEVER discarded — the save
 * payload must round-trip the user's full row.
 */
export function toCanonicalForSave(s: StoredStroke): CanonicalStroke {
  // Preserve an existing stable id (web-authored / previously-saved strokes
  // already carry one); only mint a new id when the stroke has none. Never
  // regenerate — ids must be stable across saves.
  const hadId = typeof s.id === "string" && s.id.length > 0;
  const id = hadId ? (s.id as string) : newStrokeId();
  if (s.type === "text") {
    return {
      id,
      type: "text",
      x: typeof s.x === "number" ? clamp01(s.x) : s.x,
      y: typeof s.y === "number" ? clamp01(s.y) : s.y,
      content: s.content,
      color: s.color,
      fontSize:
        typeof s.fontSize === "number"
          ? Math.min(96, Math.max(8, s.fontSize))
          : s.fontSize,
    };
  }
  if (s.type !== undefined && !isKnownStrokeType(s.type)) {
    // Forward-compat pass-through: keep EVERY field exactly as stored —
    // including any local px metadata (size/canvasW/canvasH) if present.
    // The server strips unknown keys (Zod strip mode), so extra fields
    // are harmless on the wire; narrowing here could only lose data.
    return { ...s, id };
  }
  if (hasCanvasMeta(s)) {
    const cw = s.canvasW as number;
    const ch = s.canvasH as number;
    return {
      id,
      type: s.type ?? "pencil",
      points: (s.points ?? []).map((p) => ({
        x: clamp01(p.x / cw),
        y: clamp01(p.y / ch),
      })),
      color: s.color ?? DEFAULT_COLOR,
      width:
        typeof s.size === "number"
          ? Math.max(1, Math.round(s.size))
          : typeof s.width === "number"
            ? s.width
            : DEFAULT_STROKE_WIDTH,
    };
  }
  // Id-less + no canvas metadata → definitively the 1000-unit era (see
  // doc block): recover the authoring pen FIRST, then let the
  // freshly-minted `fv-` id describe the px width truthfully.
  let width: number;
  if (typeof s.width !== "number" || !Number.isFinite(s.width) || s.width <= 0) {
    width = DEFAULT_STROKE_WIDTH;
  } else if (hadId) {
    width = s.width; // stored widths with ids are never rewritten
  } else {
    const pen = recoverLegacyPen(s.width);
    if (pen !== null) {
      width = pen;
    } else {
      // No real device width explains these units — flag for manual
      // review and keep the value verbatim rather than guessing.
      console.warn(
        `[annotations] id-less legacy width matches no device (units=${s.width}); kept verbatim`,
      );
      width = s.width;
    }
  }
  return {
    id,
    type: s.type ?? "pencil",
    points: Array.isArray(s.points)
      ? s.points.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }))
      : undefined,
    color: s.color ?? DEFAULT_COLOR,
    width,
  };
}

/**
 * Minimum drag distance (px on the touch canvas) for a stroke to count
 * as intentional. The server schema has NO min-length on `points`, so a
 * bare tap would otherwise produce a zero-length arrow/circle/rect that
 * validates and syncs. Kept LOW (2px): a short pencil dab is a
 * legitimate annotation — this only rejects same-spot touch jitter.
 * (A pure one-point tap has always been discarded by the points<2
 * check, before and after this guard existed.)
 */
export const MIN_DRAG_PX = 2;

/** True when raw px points span at least MIN_DRAG_PX from their origin. */
export function hasMinDrag(points: { x: number; y: number }[]): boolean {
  if (points.length < 2) return false;
  const [o] = points;
  return points.some(
    (p) => Math.hypot(p.x - o.x, p.y - o.y) >= MIN_DRAG_PX,
  );
}
