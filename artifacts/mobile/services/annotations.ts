import type {
  AnnotationStroke,
  CanonicalStroke,
  KnownStrokeType,
  PixelStroke,
  StoredStroke,
  StrokePoint,
} from "./types.ts";
import { isKnownStrokeType } from "./types.ts";
import { newId } from "./id.ts";

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
 * Read-time-only resolution, in priority order (never rewrites storage):
 *   1. Local legacy `size`/`canvasW` metadata — authoritative px
 *      (handled by the callers before width is consulted).
 *   2. Stroke id provenance:
 *      - mobile ids are base-36 `Date.now().toString(36) + random`
 *        (services/id.ts, unchanged since the first commit — mobile
 *        never minted UUIDs). A mobile id whose embedded timestamp
 *        predates WIDTH_PX_CUTOVER_MS is DEFINITIVELY 1000-units.
 *      - web ids are crypto.randomUUID() (or an `s-`-prefixed fallback
 *        in insecure contexts) — raw px.
 *      - mobile ids minted AFTER the cutover are ambiguous: updated
 *        builds write integer px, stale builds still in the field write
 *        non-integer 1000-units → fall through to the numeric test
 *        (documented case, no warn).
 *   3. Integer/non-integer numeric test as a last resort, with a
 *      console.warn so we can measure whether it's load-bearing.
 */

/**
 * Date this client started writing integer-px widths. Mobile base-36 ids
 * with an embedded mint-timestamp before this are guaranteed 1000-units.
 */
export const WIDTH_PX_CUTOVER_MS = Date.UTC(2026, 6, 26);

/**
 * If `id` looks like a mobile-minted base-36 id, return its embedded
 * mint timestamp (ms); otherwise null. Mobile ids are 9–18 lowercase
 * base-36 chars whose first 8 chars decode to a plausible epoch-ms
 * (8-char base-36 prefixes cover ~2015–2059). UUIDs (dashes, or 32 hex
 * chars) and web `s-` fallback ids never match.
 */
export function mobileIdTimestamp(id: unknown): number | null {
  if (typeof id !== "string" || !/^[0-9a-z]{9,18}$/.test(id)) return null;
  const ts = parseInt(id.slice(0, 8), 36);
  return ts >= Date.UTC(2015, 0, 1) && ts < Date.UTC(2059, 0, 1) ? ts : null;
}

/** Last-resort numeric discrimination: integer=px, non-integer=1000-units. */
function widthByNumericTest(width: number, boxW: number): number {
  return Number.isInteger(width) ? width : (width * boxW) / 1000;
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
  const ts = mobileIdTimestamp(id);
  if (ts !== null) {
    // Definitive: pre-cutover mobile builds only ever wrote 1000-units.
    if (ts < WIDTH_PX_CUTOVER_MS) return (width * boxW) / 1000;
    // Post-cutover mobile id: updated build (integer px) vs stale build
    // (non-integer 1000-units). Documented ambiguity — numeric test.
    return widthByNumericTest(width, boxW);
  }
  if (typeof id === "string" && id.length > 0) {
    // Non-mobile id (UUID / hex / web `s-` fallback): web-authored → px.
    return width;
  }
  // No usable id at all — numeric test is load-bearing here; measure it.
  console.warn(
    `[annotations] width heuristic fell back to integer test (id=${String(id)}, width=${width})`,
  );
  return widthByNumericTest(width, boxW);
}

/** fontSize is display px on both clients (web renders `${fontSize}px`). */
export const DEFAULT_FONT_SIZE = 18;

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
    // Legacy raw px on its own canvas → scale to this box.
    sizePx = (s.size / (s.canvasW as number)) * w;
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
      : typeof s.size === "number" && hasCanvasMeta(s)
        ? (s.size / (s.canvasW as number)) * w
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
    // Freshly-drawn stroke: stamp a stable id once, at creation.
    id: newId(),
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
 * Convert ANY stored stroke into canonical wire form for the server.
 *   - "text" strokes are preserved untouched (never stripped).
 *   - UNKNOWN/future stroke types pass through UNCHANGED (aside from a
 *     guaranteed id) — a newer web client's data must never be narrowed
 *     or destroyed by a mobile round-trip.
 *   - legacy px (canvasW/H) strokes are normalized + stamped "pencil",
 *     with width converted to integer px (web convention).
 *   - already-canonical strokes pass through with a guaranteed valid
 *     type; their width value is preserved VERBATIM (the read-time
 *     heuristic in widthToPx handles both unit conventions, so rewriting
 *     stored widths would only lose information).
 * Strokes the mobile renderer can't draw are NEVER discarded — the save
 * payload must round-trip the user's full row.
 */
export function toCanonicalForSave(s: StoredStroke): CanonicalStroke {
  // Preserve an existing stable id (web-authored / previously-saved strokes
  // already carry one); only mint a new id when the stroke has none. Never
  // regenerate — ids must be stable across saves.
  const id = typeof s.id === "string" && s.id ? s.id : newId();
  if (s.type === "text") {
    return {
      id,
      type: "text",
      x: s.x,
      y: s.y,
      content: s.content,
      color: s.color,
      fontSize: s.fontSize,
    };
  }
  if (s.type !== undefined && !isKnownStrokeType(s.type)) {
    // Forward-compat pass-through: keep every field exactly as stored
    // (minus mobile-local legacy px metadata, which was never on the wire
    // for these strokes — they can only have arrived FROM the wire).
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
  return {
    id,
    type: s.type ?? "pencil",
    points: Array.isArray(s.points)
      ? s.points.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }))
      : undefined,
    color: s.color ?? DEFAULT_COLOR,
    width: typeof s.width === "number" ? s.width : DEFAULT_STROKE_WIDTH,
  };
}
