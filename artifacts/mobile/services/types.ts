export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  address: string;
  client: string;
  /** "active" | "on-hold" | "complete" — but backend may return other strings, so we keep it loose. */
  status: string;
  createdAt: string;
  updatedAt: string;
  /** Optional fields surfaced from the web backend. */
  description?: string;
  photoCount?: number;
  color?: string;
  tags?: string[];
  latitude?: number;
  longitude?: number;
  coverPhotoUrl?: string;
  /**
   * Per-project timestamp-overlay override. true/false override the
   * account default; null/undefined inherits it.
   */
  photoOverlayEnabled?: boolean | null;
  /** True when this record originated from the backend (not a local draft). */
  remote?: boolean;
}

export interface AnnotationStroke {
  /**
   * Forward-compat discriminator for stroke kinds. When omitted (legacy
   * data, mobile-locally-created strokes), treated as "pencil" — that
   * matches the only kind the mobile renderer supports today. The web
   * app introduced additional kinds (e.g. "text") in 2026-Q2; mobile
   * skips unknown kinds at render time via isRenderablePencilStroke().
   */
  type?: string;
  color: string;
  size: number;
  points: { x: number; y: number }[];
  /** Width of the canvas the stroke was drawn on (px). */
  canvasW?: number;
  /** Height of the canvas the stroke was drawn on (px). */
  canvasH?: number;
}

/**
 * Canonical wire-format conventions (confirmed empirically against the
 * production web client bundle, 2026-07):
 *
 *  - `points` / `x`,`y` are normalized 0..1 against the displayed box.
 *  - `width` units are AMBIGUOUS historically: the web client writes and
 *    reads raw display px (integer slider 1..8); older mobile builds
 *    wrote 1000-virtual-canvas units. services/annotations.ts owns the
 *    read-time resolution, keyed on stroke-id provenance: bare base-36
 *    ids (legacy mobile) are 1000-units, everything else (web UUID,
 *    web `s-` fallback, new mobile `fv-` UUIDs) is raw px. New mobile
 *    strokes write integer px to match the web.
 *  - `fontSize` is display px (web renders `${fontSize}px`).
 *  - `type` is a required enum on the wire; "text" strokes carry no
 *    points and instead use {x, y, content, fontSize}.
 */
export interface StrokePoint {
  x: number;
  y: number;
}

/**
 * Fields shared by every stroke on the wire.
 *
 * Per-stroke stable `id` is REQUIRED on the wire — the web backend's Zod
 * union validates `id: z.string()` on every stroke (vector + text), and
 * rejects the whole annotation row 400 if any stroke lacks it. Assigned
 * once at creation and preserved across every later save (never
 * regenerated); web-authored strokes round-tripped through mobile keep
 * their original id.
 */
export interface StrokeBase {
  id: string;
  color?: string;
}

/** Freehand stroke: n points, 0..1 normalized. */
export interface PencilStroke extends StrokeBase {
  type: "pencil";
  points?: StrokePoint[];
  width?: number;
}

/** Straight segment: points = [start, end]. */
export interface LineStroke extends StrokeBase {
  type: "line";
  points?: StrokePoint[];
  width?: number;
}

/**
 * Arrow: points = [start, end] (tail → tip). The head is NOT stored —
 * renderers derive it (length max(12, widthPx*4) px, half-angle π/6 off
 * the shaft; matches the production web canvas renderer).
 */
export interface ArrowStroke extends StrokeBase {
  type: "arrow";
  points?: StrokePoint[];
  width?: number;
}

/**
 * Circle: points = [center, radiusPoint]. NOT bounding-box corners — the
 * production web renderer deserializes points[0] as the center and draws
 * a perfect circle with r = distance(center, points[1]) in display px
 * (`ctx.arc`). Confirmed from the deployed web bundle.
 */
export interface CircleStroke extends StrokeBase {
  type: "circle";
  points?: StrokePoint[];
  width?: number;
}

/** Rectangle: points = [start, end] — two opposite corners, any order. */
export interface RectangleStroke extends StrokeBase {
  type: "rectangle";
  points?: StrokePoint[];
  width?: number;
}

/**
 * Text: x/y at TOP LEVEL (no points array), normalized 0..1, anchored at
 * the TOP-left of the glyph box (web renders with textBaseline="top").
 * fontSize is in display px (web convention); no width field.
 */
export interface TextStroke extends StrokeBase {
  type: "text";
  x?: number;
  y?: number;
  content?: string;
  fontSize?: number;
  /**
   * Height-normalized font size: typedPx / fittedRectHeight at authoring
   * time. Server schema (mirrored from web):
   *   fontSizeNorm: z.number().positive().max(4).optional()
   * Cap is 4, not 1 — typedPx / fittedHeight legitimately exceeds 1 on
   * small rects. `fontSize` stays required and unchanged in meaning
   * (legacy raw px). Omit the key when absent; never write undefined.
   */
  fontSizeNorm?: number;
}

/**
 * Tolerated catch-all for stroke types this client doesn't know about
 * (authored by a newer web client). MUST pass through read and save
 * unchanged — never dropped, never narrowed, so mobile can round-trip a
 * user's full annotation row without destroying newer data. All fields
 * optional so it can also describe partial / malformed payloads;
 * conversion helpers in services/annotations.ts fill the gaps for the
 * known types and leave unknown types untouched.
 */
export interface UnknownStroke extends StrokeBase {
  type?: string;
  points?: StrokePoint[];
  width?: number;
  x?: number;
  y?: number;
  content?: string;
  fontSize?: number;
  fontSizeNorm?: number;
}

export type KnownCanonicalStroke =
  | PencilStroke
  | LineStroke
  | ArrowStroke
  | CircleStroke
  | RectangleStroke
  | TextStroke;

/**
 * Canonical, cross-platform stroke shape — the wire format stored in
 * `media_annotations.strokes` and shared with the web client. A
 * discriminated union on `type` for the six known kinds, plus the
 * UnknownStroke pass-through member for forward compatibility.
 */
export type CanonicalStroke = KnownCanonicalStroke | UnknownStroke;

export const KNOWN_STROKE_TYPES = [
  "pencil",
  "line",
  "arrow",
  "circle",
  "rectangle",
  "text",
] as const;
export type KnownStrokeType = (typeof KNOWN_STROKE_TYPES)[number];

export function isKnownStrokeType(t: unknown): t is KnownStrokeType {
  return (
    typeof t === "string" && (KNOWN_STROKE_TYPES as readonly string[]).includes(t)
  );
}

/**
 * A stroke as it may exist in local storage / in flight: canonical fields
 * PLUS the legacy mobile px fields (`size`, `canvasW`, `canvasH`). The
 * render/save converters accept this union so a single code path handles
 * both server-canonical strokes and pre-existing AsyncStorage px strokes.
 */
export interface StoredStroke extends UnknownStroke {
  /** Legacy px stroke width (mobile pre-sync builds). */
  size?: number;
  canvasW?: number;
  canvasH?: number;
}

/** One row of media_annotations (one per user per media). */
export interface MediaAnnotationRow {
  id: string | number;
  mediaId: string | number;
  userId: string | number;
  strokes: StoredStroke[];
  createdAt?: string;
  updatedAt?: string;
}

/** A stroke resolved to px coordinates against a concrete render box. */
export interface PixelStroke {
  type?: string;
  color: string;
  size: number;
  points: { x: number; y: number }[];
}

/**
 * Render-time guard for the pencil-only mobile SVG renderer.
 *
 * Returns true iff `s` is structurally a pencil stroke we can hand to
 * pointsToPath without crashing: explicit kind "pencil" OR untyped
 * (legacy/local), AND a non-empty `points` array of {x,y} pairs.
 *
 * Mobile has no Zod validation between server JSON and the renderer —
 * this is the only defensive layer. When the web schema gains new
 * discriminated-union members ("text", "arrow", "rectangle", "circle",
 * "line", ...), mobile silently skips them rather than throwing inside
 * the SVG path builder. Drop-in safe for `.filter(isRenderablePencilStroke)`
 * before any `.map` over a strokes array — type predicate narrows the
 * result to AnnotationStroke[].
 */
export function isRenderablePencilStroke(s: unknown): s is AnnotationStroke {
  if (!s || typeof s !== "object") return false;
  const o = s as { type?: unknown; points?: unknown };
  if (o.type !== undefined && o.type !== "pencil") return false;
  if (!Array.isArray(o.points) || o.points.length === 0) return false;
  // Spot-check the first point — defensive against malformed payloads
  // (server contract says number, but JSON is ultimately untyped wire).
  const first = o.points[0] as { x?: unknown; y?: unknown } | undefined;
  if (!first || typeof first.x !== "number" || typeof first.y !== "number") {
    return false;
  }
  return true;
}

export interface Photo {
  id: string;
  projectId: string;
  uri: string;
  remoteUrl?: string;
  /** Server-generated ~400px rendition (CloudFront). Grids prefer this
   *  over `uri`; the full-screen viewer keeps using the original. */
  thumbUrl?: string;
  /**
   * True when this media item is a video rather than a still image.
   * Derived from the backend media row's `mimeType` (video/*) in
   * mapBackendMedia, and set explicitly for locally-captured recordings.
   * Render paths branch on this so a video URL never reaches <Image>.
   */
  isVideo?: boolean;
  takenAt: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  note?: string;
  /**
   * AI-generated caption from the server media row (media.aiCaption).
   * NOT the same as `note` (user-authored media.caption) — never
   * collapse the two. May hold the internal sentinel "UNCLEAR", which
   * must never be displayed.
   */
  aiCaption?: string;
  uploaded: boolean;
  /** Links a local photo to its background-upload queue item until reconciled. */
  uploadQueueId?: string;
  /**
   * Server-side Media row id. Populated for two cases:
   *  - photos that originated on the backend (set by mapBackendMedia), and
   *  - locally-captured photos AFTER the upload queue reconciles (mirrored
   *    from QueuedUpload.uploadedMediaId). The local photo's `id` field
   *    remains the locally-generated UUID for stable list keys, so any
   *    code that needs the *server* id (e.g. attaching to a checklist
   *    item) must read mediaId, not id.
   */
  mediaId?: number;
  tags?: string[];
  /**
   * Uploading user, from the server's additive `uploader` field on media
   * rows. Absent when the uploader was deleted (server omits the field)
   * and for locally-captured photos that haven't come back from a project
   * refetch. Names may be null — display "Unknown user" in that case.
   */
  uploader?: {
    id: string;
    firstName: string | null;
    lastName: string | null;
  };
  remote?: boolean;
  /**
   * Render set for this photo: the UNION of every user's strokes, in
   * canonical (or tolerated-legacy) form. Populated from the server on
   * photo open (see DataContext.loadPhotoAnnotations). For not-yet-
   * uploaded local photos this holds the owner's own strokes only.
   */
  annotations?: StoredStroke[];
}

/** Task status — mirrors the server enum exactly (tasks.status). */
export type TaskStatus = "todo" | "in_progress" | "done";

/** Task priority — mirrors the server enum exactly (tasks.priority). */
export type TaskPriority = "low" | "medium" | "high";

export interface Task {
  id: string;
  projectId: string;
  title: string;
  /** Maps to BackendTask.description on the wire. */
  notes?: string;
  /**
   * Convenience derived from `status === "done"` so legacy callers
   * (checkbox UIs) don't have to know the enum. Always populated by
   * mapBackendTask + by the optimistic createTask path.
   */
  done: boolean;
  status?: TaskStatus;
  priority?: TaskPriority;
  /** User id of the assignee (single, nullable; FK to users.id). */
  assignedToId?: string;
  /**
   * Display name joined server-side from the assignee user row.
   * On optimistic create/update this is set from the picker so the
   * row renders the right name before the PATCH response lands.
   */
  assignedToName?: string;
  /** User id of the creator (server-stamped). */
  createdById?: string;
  dueDate?: string;
  /**
   * Photos that must be attached to THIS task (task_photos join) before
   * it can be marked done. 0/undefined = no requirement. Server-computed;
   * mobile has no attach UI yet (Phase 1+) — photos are attached from
   * the web app for now.
   */
  requiredPhotoCount?: number;
  /** Server-computed count of photos currently attached to this task. */
  attachedPhotoCount?: number;
  createdAt: string;
  remote?: boolean;
}

// Legacy local-only Checklist / ChecklistItem types removed in the v2
// rewrite (mobile checklists field-MVP). Real checklists are now fetched
// from the server via api.listChecklistsForProject + the
// useProjectChecklists hook; their shape lives in services/api.ts as
// BackendChecklist + BackendChecklistSection + BackendChecklistItem.

export type Id = string;
