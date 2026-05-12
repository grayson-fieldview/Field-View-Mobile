import { useCallback, useEffect, useState } from "react";

import { ApiError, api, type BackendReport } from "@/services/api";

/**
 * Project-scoped reports list (Mobile Reports R1).
 *
 * Owns its own loading + error state and re-fetches whenever the
 * project id changes. Optimistic insert on create + optimistic remove
 * on delete (with revert on failure). Templates are NOT managed here —
 * the picker modal fetches them on open.
 */
export interface ProjectReportsState {
  reports: BackendReport[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Create a report — optionally instantiated from a template. */
  createReport: (input: {
    title: string;
    description?: string;
    templateId?: string | number;
  }) => Promise<BackendReport>;
  /** Optimistic delete with revert on failure. */
  deleteReport: (id: string | number) => Promise<void>;
}

export function useProjectReports(
  projectId: string | undefined,
): ProjectReportsState {
  const [reports, setReports] = useState<BackendReport[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const list = await api.listReportsForProject(projectId);
      setReports(Array.isArray(list) ? list : []);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(e instanceof Error ? e.message : "Couldn't load reports.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createReport = useCallback(
    async (input: {
      title: string;
      description?: string;
      templateId?: string | number;
    }) => {
      if (!projectId) {
        throw new Error("projectId is required to create a report");
      }
      const created = await api.createReport(projectId, input);
      setReports((curr) => [created, ...curr]);
      return created;
    },
    [projectId],
  );

  const deleteReport = useCallback(
    async (id: string | number) => {
      const target = String(id);
      // Per-entity rollback: capture only the removed report and its
      // original index. On failure we re-insert *just that row* iff
      // no other state op has already re-introduced it. A whole-array
      // snapshot restore would resurrect rows that a concurrent delete
      // successfully removed (the race the architect flagged).
      let removed: BackendReport | undefined;
      let removedIndex = -1;
      setReports((curr) => {
        removedIndex = curr.findIndex((r) => String(r.id) === target);
        if (removedIndex < 0) return curr;
        removed = curr[removedIndex];
        return curr.filter((_, i) => i !== removedIndex);
      });
      try {
        await api.deleteReport(id);
      } catch (e) {
        if (removed) {
          const restored = removed;
          const idx = removedIndex;
          setReports((curr) => {
            if (curr.some((r) => String(r.id) === target)) return curr;
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

  return { reports, loading, error, refresh, createReport, deleteReport };
}
