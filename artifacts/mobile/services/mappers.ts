import type {
  BackendMedia,
  BackendProject,
  BackendProjectContact,
  BackendTask,
  ContactType,
} from "./api";
import type {
  Photo,
  Project,
  ProjectContact,
  Task,
  TaskPriority,
  TaskStatus,
} from "./types";

const VALID_STATUS = new Set<TaskStatus>(["todo", "in_progress", "done"]);
const VALID_PRIORITY = new Set<TaskPriority>(["low", "medium", "high"]);
const VALID_CONTACT_TYPE = new Set<ContactType>([
  "owner",
  "renter",
  "property_manager",
  "gc",
  "other",
]);

/**
 * Normalize a project-contact join row. Tolerates both wire shapes
 * (nested `contact` object or flattened fields). Rows with no usable
 * contact id are dropped by the caller (returns null) — without the
 * id we can't PATCH/DELETE the join row.
 */
export function mapBackendProjectContact(
  r: BackendProjectContact,
): ProjectContact | null {
  const c = r.contact;
  const rawId = r.contactId ?? c?.id;
  if (rawId === undefined || rawId === null) return null;
  const contactType: ContactType = VALID_CONTACT_TYPE.has(
    r.contactType as ContactType,
  )
    ? (r.contactType as ContactType)
    : "other";
  const pick = (a?: string | null, b?: string | null) =>
    (a ?? b ?? undefined) || undefined;
  return {
    contactId: String(rawId),
    contactType,
    firstName: pick(c?.firstName, r.firstName) ?? "",
    lastName: pick(c?.lastName, r.lastName),
    email: pick(c?.email, r.email),
    phone: pick(c?.phone, r.phone),
    address: pick(c?.address, r.address),
    notes: pick(c?.notes, r.notes),
  };
}

/**
 * GET /api/projects serializes photoCount from a SQL COUNT — depending
 * on the driver/serializer this can arrive as a number OR a numeric
 * string. The old `typeof === "number"` check silently dropped string
 * counts, leaving every list card at 0 photos on fresh login (empty
 * cache, nothing to fall back on). Coerce both shapes; anything else
 * maps to undefined (never 0 — 0 is a real count).
 */
function coerceCount(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function mapBackendProject(b: BackendProject): Project {
  return {
    id: String(b.id),
    name: b.name ?? "",
    address: b.address ?? "",
    // Web backend uses `description` for the project description and `name`
    // for the primary label. We surface description as the "client" subtitle
    // on cards until we have a dedicated field.
    client: b.description ?? "",
    description: b.description ?? undefined,
    status: (b.status ?? "active").toString(),
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    photoCount: coerceCount(b.photoCount),
    color: b.color ?? undefined,
    tags: b.tags ?? undefined,
    latitude: b.latitude ?? undefined,
    longitude: b.longitude ?? undefined,
    coverPhotoUrl: b.recentPhotos?.[0]?.url,
    // Tri-state passthrough: absent on old payloads normalizes to null
    // (= inherit account default), never to false.
    photoOverlayEnabled: b.photoOverlayEnabled ?? null,
    remote: true,
  };
}

export function mapBackendMedia(m: BackendMedia): Photo {
  return {
    id: String(m.id),
    projectId: String(m.projectId),
    uri: m.url,
    remoteUrl: m.url,
    thumbUrl: m.thumbUrl ?? undefined,
    isVideo: typeof m.mimeType === "string" && m.mimeType.startsWith("video/"),
    // Capture time when the client reported one; upload time otherwise
    // (pre-takenAt rows and rejected values are null server-side).
    takenAt: m.takenAt ?? m.createdAt,
    latitude: m.latitude ?? undefined,
    longitude: m.longitude ?? undefined,
    note: m.caption ?? undefined,
    // Deliberately NOT folded into `note` — different field, different
    // meaning (AI vision caption vs user-authored caption).
    aiCaption: m.aiCaption ?? undefined,
    tags: m.tags ?? undefined,
    uploaded: true,
    remote: true,
    mediaId: typeof m.id === "number" ? m.id : Number(m.id),
    // Absent for deleted uploaders — keep it absent (undefined) so filter
    // logic can distinguish "no uploader" from "uploader with null names".
    uploader: m.uploader ?? undefined,
  };
}

export function mapBackendTask(t: BackendTask): Task {
  // Status / priority are server-controlled enums; defensively narrow
  // unknown values to a sane default so the UI never has to handle
  // arbitrary strings.
  const rawStatus = (t.status ?? "todo") as TaskStatus;
  const status: TaskStatus = VALID_STATUS.has(rawStatus) ? rawStatus : "todo";
  const rawPriority = t.priority as TaskPriority | undefined | null;
  const priority: TaskPriority | undefined =
    rawPriority && VALID_PRIORITY.has(rawPriority) ? rawPriority : undefined;

  // Display name comes from the server join. It may be absent on
  // POST/PATCH responses; in that case we leave it undefined and let
  // the optimistic-update path in DataContext preserve whatever the
  // picker set.
  const assignedToName = t.assignedTo
    ? `${t.assignedTo.firstName ?? ""} ${t.assignedTo.lastName ?? ""}`.trim() ||
      undefined
    : undefined;

  return {
    id: String(t.id),
    projectId: String(t.projectId),
    title: t.title ?? "",
    notes: t.description ?? undefined,
    done: status === "done",
    status,
    priority,
    assignedToId: t.assignedToId ?? undefined,
    assignedToName,
    createdById: t.createdById ?? undefined,
    dueDate: t.dueDate ?? undefined,
    requiredPhotoCount:
      typeof t.requiredPhotoCount === "number" && t.requiredPhotoCount > 0
        ? t.requiredPhotoCount
        : undefined,
    attachedPhotoCount:
      typeof t.attachedPhotoCount === "number"
        ? t.attachedPhotoCount
        : undefined,
    createdAt: t.createdAt,
    remote: true,
  };
}
