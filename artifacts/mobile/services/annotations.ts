import type {
  AnnotationStroke,
  CanonicalStroke,
  PixelStroke,
  StoredStroke,
} from "./types";

/**
 * Coordinate-space conversions between the mobile renderer (px against a
 * concrete canvas box) and the canonical cross-platform wire format
 * (points normalized 0..1, width in 1000-virtual-canvas units, explicit
 * `type` enum). All boundary conversion lives here so the rest of the app
 * can hold a single tolerant model and convert only at the read/write edge.
 *
 * Canonical contract (locked, shared with the web client):
 *   points: [{x,y}] normalized 0..1, clamped, vs the displayed canvas box
 *   type:   "pencil" for freehand (enum pencil|line|arrow|rectangle|circle)
 *   width:  number in 1000-virtual-canvas units (default 3)
 *   color:  string
 *   text strokes carry no points: { type:"text", x, y, content, color, fontSize }
 */

export const DEFAULT_STROKE_WIDTH = 3;
const DEFAULT_COLOR = "#ef4444";

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

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

  let widthUnits: number;
  if (typeof s.width === "number") {
    widthUnits = s.width;
  } else if (typeof s.size === "number" && hasCanvasMeta(s)) {
    widthUnits = (s.size / (s.canvasW as number)) * 1000;
  } else if (typeof s.size === "number") {
    widthUnits = s.size;
  } else {
    widthUnits = DEFAULT_STROKE_WIDTH;
  }

  return {
    type: s.type,
    color: s.color ?? DEFAULT_COLOR,
    size: (widthUnits * w) / 1000,
    points: norm.map((p) => ({ x: p.x * w, y: p.y * h })),
  };
}

/**
 * Convert a freshly-drawn raw px stroke (carrying canvasW/H) to canonical
 * form: points clamped to 0..1, width in 1000-units, type stamped "pencil"
 * (mobile omits type while drawing).
 */
export function rawToCanonical(s: AnnotationStroke): CanonicalStroke {
  const cw = s.canvasW && s.canvasW > 0 ? s.canvasW : 1;
  const ch = s.canvasH && s.canvasH > 0 ? s.canvasH : 1;
  return {
    type: "pencil",
    points: (s.points ?? []).map((p) => ({
      x: clamp01(p.x / cw),
      y: clamp01(p.y / ch),
    })),
    color: s.color ?? DEFAULT_COLOR,
    width: typeof s.size === "number" ? (s.size / cw) * 1000 : DEFAULT_STROKE_WIDTH,
  };
}

/**
 * Convert ANY stored stroke into canonical wire form for the server.
 *   - "text" strokes are preserved untouched (never stripped).
 *   - legacy px (canvasW/H) strokes are normalized + stamped "pencil".
 *   - already-canonical strokes pass through with a guaranteed valid type.
 * Non-pencil strokes the mobile renderer can't draw are NEVER discarded —
 * the save payload must round-trip the user's full row.
 */
export function toCanonicalForSave(s: StoredStroke): CanonicalStroke {
  if (s.type === "text") {
    return {
      type: "text",
      x: s.x,
      y: s.y,
      content: s.content,
      color: s.color,
      fontSize: s.fontSize,
    };
  }
  if (hasCanvasMeta(s)) {
    const cw = s.canvasW as number;
    const ch = s.canvasH as number;
    return {
      type: s.type ?? "pencil",
      points: (s.points ?? []).map((p) => ({
        x: clamp01(p.x / cw),
        y: clamp01(p.y / ch),
      })),
      color: s.color ?? DEFAULT_COLOR,
      width:
        typeof s.size === "number"
          ? (s.size / cw) * 1000
          : typeof s.width === "number"
            ? s.width
            : DEFAULT_STROKE_WIDTH,
    };
  }
  return {
    type: s.type ?? "pencil",
    points: Array.isArray(s.points)
      ? s.points.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }))
      : undefined,
    color: s.color ?? DEFAULT_COLOR,
    width: typeof s.width === "number" ? s.width : DEFAULT_STROKE_WIDTH,
  };
}
