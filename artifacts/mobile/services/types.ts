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
 * Canonical, cross-platform stroke shape — the wire format stored in
 * `media_annotations.strokes` and shared with the web client.
 *
 *  - `points` are normalized 0..1 against the displayed canvas box.
 *  - `width` is in 1000-virtual-canvas units (NOT px, NOT 0..1).
 *  - `type` is a required enum on the wire ("pencil" | "line" | "arrow" |
 *    "rectangle" | "circle"); "text" strokes carry no points and instead
 *    use {x, y, content, fontSize}.
 *
 * All fields are optional here so the type can also describe partial /
 * tolerated payloads; conversion helpers in services/annotations.ts fill
 * the gaps and enforce the canonical form at the read/write edge.
 */
export interface CanonicalStroke {
  /**
   * Per-stroke stable id. REQUIRED on the wire — the web backend's Zod
   * union validates `id: z.string()` on every stroke (vector + text), and
   * rejects the whole annotation row 400 if any stroke lacks it. Assigned
   * once at creation and preserved across every later save (never
   * regenerated); web-authored strokes round-tripped through mobile keep
   * their original id.
   */
  id: string;
  type?: string;
  points?: { x: number; y: number }[];
  color?: string;
  width?: number;
  /** text-stroke fields (web-authored; mobile preserves but doesn't render) */
  x?: number;
  y?: number;
  content?: string;
  fontSize?: number;
}

/**
 * A stroke as it may exist in local storage / in flight: canonical fields
 * PLUS the legacy mobile px fields (`size`, `canvasW`, `canvasH`). The
 * render/save converters accept this union so a single code path handles
 * both server-canonical strokes and pre-existing AsyncStorage px strokes.
 */
export interface StoredStroke extends CanonicalStroke {
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
  createdAt: string;
  remote?: boolean;
}

// Legacy local-only Checklist / ChecklistItem types removed in the v2
// rewrite (mobile checklists field-MVP). Real checklists are now fetched
// from the server via api.listChecklistsForProject + the
// useProjectChecklists hook; their shape lives in services/api.ts as
// BackendChecklist + BackendChecklistSection + BackendChecklistItem.

export type Id = string;
