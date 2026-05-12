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
  annotations?: AnnotationStroke[];
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  notes?: string;
  done: boolean;
  dueDate?: string;
  createdAt: string;
  remote?: boolean;
  /** Display name of the person assigned to this task. Mobile-local for now. */
  assignee?: string;
}

// Legacy local-only Checklist / ChecklistItem types removed in the v2
// rewrite (mobile checklists field-MVP). Real checklists are now fetched
// from the server via api.listChecklistsForProject + the
// useProjectChecklists hook; their shape lives in services/api.ts as
// BackendChecklist + BackendChecklistSection + BackendChecklistItem.

export type Id = string;
