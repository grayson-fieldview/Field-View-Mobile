import type {
  BackendMedia,
  BackendProject,
  BackendTask,
} from "./api";
import type { Photo, Project, Task, TaskPriority, TaskStatus } from "./types";

const VALID_STATUS = new Set<TaskStatus>(["todo", "in_progress", "done"]);
const VALID_PRIORITY = new Set<TaskPriority>(["low", "medium", "high"]);

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
    photoCount: typeof b.photoCount === "number" ? b.photoCount : undefined,
    color: b.color ?? undefined,
    tags: b.tags ?? undefined,
    latitude: b.latitude ?? undefined,
    longitude: b.longitude ?? undefined,
    coverPhotoUrl: b.recentPhotos?.[0]?.url,
    remote: true,
  };
}

export function mapBackendMedia(m: BackendMedia): Photo {
  return {
    id: String(m.id),
    projectId: String(m.projectId),
    uri: m.url,
    remoteUrl: m.url,
    isVideo: typeof m.mimeType === "string" && m.mimeType.startsWith("video/"),
    takenAt: m.createdAt,
    latitude: m.latitude ?? undefined,
    longitude: m.longitude ?? undefined,
    note: m.caption ?? undefined,
    tags: m.tags ?? undefined,
    uploaded: true,
    remote: true,
    mediaId: typeof m.id === "number" ? m.id : Number(m.id),
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
    createdAt: t.createdAt,
    remote: true,
  };
}
