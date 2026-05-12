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
      let snapshot: BackendReport[] = [];
      setReports((curr) => {
        snapshot = curr;
        return curr.filter((r) => String(r.id) !== target);
      });
      try {
        await api.deleteReport(id);
      } catch (e) {
        setReports(snapshot);
        throw e;
      }
    },
    [],
  );

  return { reports, loading, error, refresh, createReport, deleteReport };
}
