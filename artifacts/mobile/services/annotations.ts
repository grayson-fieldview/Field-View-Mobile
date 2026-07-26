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
  // Step 3: everything else is px. Report shapes we don't recognize.
  if (!isKnownPxStrokeId(id)) {
    console.warn(
      `[annotations] stroke id matches no known shape; width read as px (id=${String(id)}, width=${width})`,
    );
    unclassifiedIdReporter?.(id, width);
  }
  return width;
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
 * Nominal canvas width used to normalize an ID-LESS 1000-unit width to
 * px when the caller can't supply the real render box (typical phone
 * canvas was ~335–430pt; the exact value only shifts the result within
 * one pen size). Callers that know their box should pass it explicitly.
 */
export const LEGACY_NORMALIZE_BOX_W = 375;

/**
 * The mobile pen set — sourced from git history, not inferred: every
 * revision that ever defined the pen-size UI used exactly [3, 6, 12]
 * (git log -G "SIZES = [" shows only this array, from the first photo
 * editor commit onward). So the observed production width 14.9254 is
 * pen 6 authored on a 402pt canvas (6/402*1000), not pen 5 on 335pt —
 * 5 was never a mobile pen. Legacy 1000-unit widths therefore decode
 * to one of these three px values; SNAP to the nearest (don't round):
 * pen 6 on 430pt → 13.95 units → ×0.375 = 5.23 → round gives 5 (wrong),
 * snap gives 6 (right). The three unit bands don't overlap at any
 * plausible canvas width, so snapping is unambiguous.
 */
export const LEGACY_PEN_SIZES_PX = [3, 6, 12] as const;

/** Snap a px estimate to the nearest legacy pen size. */
export function snapToLegacyPen(px: number): number {
  let best: number = LEGACY_PEN_SIZES_PX[0];
  for (const s of LEGACY_PEN_SIZES_PX) {
    if (Math.abs(px - s) < Math.abs(px - best)) best = s;
  }
  return best;
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
 *     width is NORMALIZED to px against `boxW` BEFORE an `fv-` id is
 *     minted, so the new id honestly self-describes a px width instead
 *     of mislabeling a 1000-unit one. (The canvasMeta check above must
 *     stay first: Gen-1 id-less px strokes are unaffected.)
 *   - already-canonical strokes (with ids) pass through with a
 *     guaranteed valid type; their width value is preserved VERBATIM
 *     (the id-based read heuristic handles both unit conventions, so
 *     rewriting stored widths would only lose information).
 * Strokes the mobile renderer can't draw are NEVER discarded — the save
 * payload must round-trip the user's full row.
 */
export function toCanonicalForSave(
  s: StoredStroke,
  boxW: number = LEGACY_NORMALIZE_BOX_W,
): CanonicalStroke {
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
  // Id-less + no canvas metadata → definitively the 1000-unit era (see
  // doc block): normalize the width to integer px FIRST, then let the
  // freshly-minted `fv-` id describe it truthfully.
  const width =
    typeof s.width === "number" && Number.isFinite(s.width) && s.width > 0
      ? hadId
        ? s.width // stored widths with ids are never rewritten
        : snapToLegacyPen((s.width * boxW) / 1000)
      : DEFAULT_STROKE_WIDTH;
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
