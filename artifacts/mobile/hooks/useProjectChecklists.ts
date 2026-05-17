import { useCallback, useEffect, useRef, useState } from "react";

import {
  ApiError,
  api,
  type BackendChecklist,
  type BackendChecklistItem,
  type BackendChecklistItemOption,
  type BackendChecklistItemPhoto,
  type BackendChecklistSection,
} from "@/services/api";

/**
 * Server-backed checklist hooks for the v2 schema (mobile field-MVP).
 *
 * Two surfaces:
 *  - useProjectChecklists(projectId): list view for the project tab.
 *  - useChecklistDetail(checklistId): detail view (sections + items +
 *    options + photos), with optimistic write helpers.
 *
 * Both hooks own their own loading / error state and expose a `refresh`
 * function callers can wire to pull-to-refresh or after a write that
 * affects the list.
 */

// ---------------- list hook ----------------

export interface ProjectChecklistsState {
  checklists: BackendChecklist[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /**
   * Apply a template → spawn a new checklist instance on the project.
   * `title` is required because the server does not auto-derive it
   * from the template — caller forwards the template's own title.
   */
  applyTemplate: (
    templateId: string | number,
    title: string,
  ) => Promise<BackendChecklist>;
  /**
   * Optimistic delete of a checklist instance. Removes it from local
   * state immediately, calls DELETE, and reverts on failure (re-throws
   * so the caller can show a toast). FK cascade on the server removes
   * sections/items/photo joins automatically — no extra cleanup here.
   */
  deleteChecklist: (id: string | number) => Promise<void>;
}

export function useProjectChecklists(
  projectId: string | undefined,
): ProjectChecklistsState {
  const [checklists, setChecklists] = useState<BackendChecklist[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const list = await api.listChecklistsForProject(projectId);
      setChecklists(Array.isArray(list) ? list : []);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(e instanceof Error ? e.message : "Couldn't load checklists.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const applyTemplate = useCallback(
    async (templateId: string | number, title: string) => {
      if (!projectId) throw new Error("projectId is required to apply a template");
      const created = await api.applyChecklistTemplate(
        projectId,
        templateId,
        title,
      );
      setChecklists((curr) => [created, ...curr]);
      return created;
    },
    [projectId],
  );

  const deleteChecklist = useCallback(
    async (id: string | number) => {
      const target = String(id);
      // Per-entity rollback (matches useProjectReports.deleteReport):
      // capture just the removed row + index inside the setter, so on
      // failure we re-insert that one row iff no other state op has
      // already re-introduced it. A whole-array snapshot restore would
      // resurrect rows that a concurrent delete successfully removed.
      let removed: BackendChecklist | undefined;
      let removedIndex = -1;
      setChecklists((curr) => {
        removedIndex = curr.findIndex((c) => String(c.id) === target);
        if (removedIndex < 0) return curr;
        removed = curr[removedIndex];
        return curr.filter((_, i) => i !== removedIndex);
      });
      try {
        await api.deleteChecklist(id);
      } catch (e) {
        if (removed) {
          const restored = removed;
          const idx = removedIndex;
          setChecklists((curr) => {
            if (curr.some((c) => String(c.id) === target)) return curr;
            const next = curr.slice();
            next.splice(Math.min(idx, next.length), 0, restored);
            return next;
          });
        }
        throw e;
      }
    },
    [],
  );

  return {
    checklists,
    loading,
    error,
    refresh,
    applyTemplate,
    deleteChecklist,
  };
}

// ---------------- detail hook ----------------

export interface ChecklistDetailState {
  sections: BackendChecklistSection[];
  items: BackendChecklistItem[];
  optionsByItemId: Record<string, BackendChecklistItemOption[]>;
  photosByItemId: Record<string, BackendChecklistItemPhoto[]>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Refetch photos for one item (e.g. after a background upload completes). */
  refreshItemPhotos: (itemId: string) => Promise<void>;
  /**
   * Optimistic patch: mutates local item state immediately, then PATCHes
   * the server. On failure the local change is reverted and the error is
   * re-thrown so the caller can show a toast.
   */
  updateItem: (
    itemId: string,
    patch: Partial<BackendChecklistItem>,
  ) => Promise<void>;
  /** Append an attached-photo junction row locally (no extra round-trip). */
  attachPhotoLocal: (itemId: string, photo: BackendChecklistItemPhoto) => void;
  /** Server detach + local removal. */
  detachPhoto: (
    itemId: string,
    junctionId: string | number,
  ) => Promise<void>;
}

const SERVER_PATCH_KEYS: Array<keyof BackendChecklistItem> = [
  "valueBool",
  "valueRating",
  "valueText",
  "selectedOptionId",
  "notes",
  "assignedToUserId",
  "completedAt",
];

export function useChecklistDetail(
  checklistId: string | undefined,
): ChecklistDetailState {
  const [sections, setSections] = useState<BackendChecklistSection[]>([]);
  const [items, setItems] = useState<BackendChecklistItem[]>([]);
  const [optionsByItemId, setOptionsByItemId] = useState<
    Record<string, BackendChecklistItemOption[]>
  >({});
  const [photosByItemId, setPhotosByItemId] = useState<
    Record<string, BackendChecklistItemPhoto[]>
  >({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Used by updateItem so it can read the current item to revert on failure
  // without forcing a re-render of the callback.
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Per-item monotonic version. Incremented on every updateItem call so
  // that an older in-flight request whose response (or failure) arrives
  // *after* a newer call cannot clobber the newer optimistic state. We
  // simply ignore stale responses entirely — the newer call owns the
  // final commit/revert.
  const itemVersionsRef = useRef<Map<string, number>>(new Map());

  const refresh = useCallback(async () => {
    if (!checklistId) return;
    setLoading(true);
    setError(null);
    try {
      const [secs, its] = await Promise.all([
        api.listChecklistSections(checklistId),
        api.listChecklistItems(checklistId),
      ]);
      const itsArr = Array.isArray(its) ? its : [];
      setSections(Array.isArray(secs) ? secs : []);
      setItems(itsArr);

      // Fetch options for MC items + photos for items with photosRequired>0
      // OR any item that already has at least one photo. Fire in parallel;
      // ignore individual failures so one 404 doesn't break the whole page.
      const mcItems = itsArr.filter((i) => i.fieldType === "multiple_choice");
      const optResults = await Promise.all(
        mcItems.map(async (i) => {
          try {
            const opts = await api.listChecklistItemOptions(i.id);
            return [String(i.id), Array.isArray(opts) ? opts : []] as const;
          } catch {
            return [String(i.id), []] as const;
          }
        }),
      );
      const photoResults = await Promise.all(
        itsArr.map(async (i) => {
          try {
            const ph = await api.listChecklistItemPhotos(i.id);
            return [String(i.id), Array.isArray(ph) ? ph : []] as const;
          } catch {
            return [String(i.id), []] as const;
          }
        }),
      );
      setOptionsByItemId(Object.fromEntries(optResults));
      setPhotosByItemId(Object.fromEntries(photoResults));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(e instanceof Error ? e.message : "Couldn't load checklist.");
    } finally {
      setLoading(false);
    }
  }, [checklistId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshItemPhotos = useCallback(async (itemId: string) => {
    try {
      const ph = await api.listChecklistItemPhotos(itemId);
      setPhotosByItemId((curr) => ({
        ...curr,
        [itemId]: Array.isArray(ph) ? ph : [],
      }));
    } catch {
      /* swallow — non-fatal background refresh */
    }
  }, []);

  const updateItem = useCallback(
    async (itemId: string, patch: Partial<BackendChecklistItem>) => {
      const prev = itemsRef.current.find((i) => String(i.id) === itemId);
      if (!prev) return;
      // Bump the per-item version BEFORE we mutate state so concurrent
      // calls each see a fresh value and the latest one always wins.
      const versions = itemVersionsRef.current;
      const myVersion = (versions.get(itemId) ?? 0) + 1;
      versions.set(itemId, myVersion);
      const isLatest = () => versions.get(itemId) === myVersion;

      // Optimistic: apply patch locally first.
      setItems((curr) =>
        curr.map((i) => (String(i.id) === itemId ? { ...i, ...patch } : i)),
      );
      // Forward only the value-shaped keys to the server (drop label /
      // sortOrder / etc. that the caller has no business changing here).
      const wirePatch: Record<string, unknown> = {};
      for (const k of SERVER_PATCH_KEYS) {
        if (k in patch) wirePatch[k] = (patch as Record<string, unknown>)[k];
      }
      try {
        const updated = await api.updateChecklistItem(itemId, wirePatch);
        // If a newer call started while we were in-flight, drop our
        // server response on the floor — the newer call's optimistic
        // state is what the user sees and what they expect to win.
        if (!isLatest()) return;
        setItems((curr) =>
          curr.map((i) => (String(i.id) === itemId ? updated : i)),
        );
      } catch (e) {
        // Same rule for failures: only revert if we're still the
        // newest in-flight call. Otherwise the newer call will commit
        // its own state and our revert would clobber it.
        if (!isLatest()) return;
        setItems((curr) =>
          curr.map((i) => (String(i.id) === itemId ? prev : i)),
        );
        throw e;
      }
    },
    [],
  );

  const attachPhotoLocal = useCallback(
    (itemId: string, photo: BackendChecklistItemPhoto) => {
      setPhotosByItemId((curr) => {
        const existing = curr[itemId] ?? [];
        // Idempotent on (itemId, junction id) so a refresh-race doesn't dupe.
        if (existing.some((p) => String(p.id) === String(photo.id))) return curr;
        return { ...curr, [itemId]: [...existing, photo] };
      });
    },
    [],
  );

  const detachPhoto = useCallback(
    async (itemId: string, junctionId: string | number) => {
      const prev = photosByItemId[itemId] ?? [];
      // Optimistic remove.
      setPhotosByItemId((curr) => ({
        ...curr,
        [itemId]: (curr[itemId] ?? []).filter(
          (p) => String(p.id) !== String(junctionId),
        ),
      }));
      try {
        await api.detachPhotoFromItem(junctionId);
      } catch (e) {
        // Revert on failure.
        setPhotosByItemId((curr) => ({ ...curr, [itemId]: prev }));
        throw e;
      }
    },
    [photosByItemId],
  );

  return {
    sections,
    items,
    optionsByItemId,
    photosByItemId,
    loading,
    error,
    refresh,
    refreshItemPhotos,
    updateItem,
    attachPhotoLocal,
    detachPhoto,
  };
}
