import { useCallback, useEffect, useRef, useState } from "react";

import {
  ApiError,
  api,
  type BackendReport,
  type BackendReportSection,
  type BackendReportSectionPhoto,
} from "@/services/api";

/** Server-enforced cap on total photos per report (PDF generation guard). */
export const REPORT_PHOTO_CAP = 50;

export type SectionWithPhotos = BackendReportSection & {
  photos: BackendReportSectionPhoto[];
};

/**
 * Detail-view state for a single report (Mobile Reports R1).
 *
 * Mirrors the useChecklistDetail pattern:
 *  - Single `getReport` call returns the full tree (sections + photos
 *    with presigned media URLs).
 *  - All mutations are optimistic with revert on failure.
 *  - A per-id monotonic version counter prevents stale PATCH responses
 *    (or failures) from clobbering newer in-flight optimistic state.
 *    Each entity family — report meta, sections, photos — has its own
 *    versions Map keyed by stringified id.
 */
export interface ReportDetailState {
  report: BackendReport | null;
  sections: SectionWithPhotos[];
  /** Total photos across all sections — drives the PHOTO_CAP UI. */
  totalPhotoCount: number;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updateReportMeta: (patch: {
    title?: string;
    description?: string | null;
  }) => Promise<void>;
  addSection: (input: {
    title: string;
    summary?: string;
  }) => Promise<BackendReportSection>;
  updateSection: (
    sectionId: string | number,
    patch: { title?: string; summary?: string | null },
  ) => Promise<void>;
  deleteSection: (sectionId: string | number) => Promise<void>;
  attachPhotos: (
    sectionId: string | number,
    mediaIds: number[],
  ) => Promise<BackendReportSectionPhoto[]>;
  updatePhoto: (
    sectionId: string | number,
    photoId: string | number,
    patch: { caption?: string | null; description?: string | null },
  ) => Promise<void>;
  detachPhoto: (
    sectionId: string | number,
    photoId: string | number,
  ) => Promise<void>;
}

export function useReportDetail(
  reportId: string | undefined,
): ReportDetailState {
  const [report, setReport] = useState<BackendReport | null>(null);
  const [sections, setSections] = useState<SectionWithPhotos[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs so the callbacks below can read current state without
  // re-creating themselves on every render.
  const reportRef = useRef(report);
  reportRef.current = report;
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;

  // Per-entity monotonic versions. Each call bumps its counter; if a
  // newer call has started while we were in flight, our response
  // (success or failure) is dropped — the newer call owns the commit.
  const reportVersionRef = useRef(0);
  const sectionVersionsRef = useRef<Map<string, number>>(new Map());
  const photoVersionsRef = useRef<Map<string, number>>(new Map());

  const refresh = useCallback(async () => {
    if (!reportId) return;
    setLoading(true);
    setError(null);
    try {
      const tree = await api.getReport(reportId);
      const { sections: secs, ...rest } = tree;
      setReport(rest as BackendReport);
      setSections(
        (Array.isArray(secs) ? secs : [])
          .slice()
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((s) => ({
            ...s,
            photos: (s.photos ?? [])
              .slice()
              .sort((a, b) => a.sortOrder - b.sortOrder),
          })),
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(e instanceof Error ? e.message : "Couldn't load report.");
    } finally {
      setLoading(false);
    }
  }, [reportId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateReportMeta = useCallback(
    async (patch: { title?: string; description?: string | null }) => {
      const prev = reportRef.current;
      if (!prev || !reportId) return;
      const myVersion = ++reportVersionRef.current;
      const isLatest = () => reportVersionRef.current === myVersion;
      setReport({ ...prev, ...patch });
      try {
        const updated = await api.updateReport(reportId, patch);
        if (!isLatest()) return;
        setReport(updated);
      } catch (e) {
        if (!isLatest()) return;
        setReport(prev);
        throw e;
      }
    },
    [reportId],
  );

  const addSection = useCallback(
    async (input: { title: string; summary?: string }) => {
      if (!reportId) throw new Error("reportId is required");
      const created = await api.addReportSection(reportId, input);
      setSections((curr) => [...curr, { ...created, photos: [] }]);
      return created;
    },
    [reportId],
  );

  const updateSection = useCallback(
    async (
      sectionId: string | number,
      patch: { title?: string; summary?: string | null },
    ) => {
      const key = String(sectionId);
      const prev = sectionsRef.current.find((s) => String(s.id) === key);
      if (!prev) return;
      const versions = sectionVersionsRef.current;
      const myVersion = (versions.get(key) ?? 0) + 1;
      versions.set(key, myVersion);
      const isLatest = () => versions.get(key) === myVersion;

      setSections((curr) =>
        curr.map((s) => (String(s.id) === key ? { ...s, ...patch } : s)),
      );
      try {
        const updated = await api.updateReportSection(sectionId, patch);
        if (!isLatest()) return;
        setSections((curr) =>
          curr.map((s) =>
            String(s.id) === key
              ? { ...s, ...updated, photos: s.photos }
              : s,
          ),
        );
      } catch (e) {
        if (!isLatest()) return;
        setSections((curr) =>
          curr.map((s) => (String(s.id) === key ? prev : s)),
        );
        throw e;
      }
    },
    [],
  );

  const deleteSection = useCallback(async (sectionId: string | number) => {
    const key = String(sectionId);
    let snapshot: SectionWithPhotos[] = [];
    setSections((curr) => {
      snapshot = curr;
      return curr.filter((s) => String(s.id) !== key);
    });
    try {
      await api.deleteReportSection(sectionId);
    } catch (e) {
      setSections(snapshot);
      throw e;
    }
  }, []);

  const attachPhotos = useCallback(
    async (sectionId: string | number, mediaIds: number[]) => {
      if (mediaIds.length === 0) return [];
      const created = await api.attachPhotosToSection(sectionId, mediaIds);
      const key = String(sectionId);
      setSections((curr) =>
        curr.map((s) => {
          if (String(s.id) !== key) return s;
          // Idempotent merge by junction id — a refresh racing with
          // this attach must not introduce duplicates.
          const existingIds = new Set(s.photos.map((p) => String(p.id)));
          const newOnes = created.filter(
            (p) => !existingIds.has(String(p.id)),
          );
          return {
            ...s,
            photos: [...s.photos, ...newOnes].sort(
              (a, b) => a.sortOrder - b.sortOrder,
            ),
          };
        }),
      );
      return created;
    },
    [],
  );

  const updatePhoto = useCallback(
    async (
      sectionId: string | number,
      photoId: string | number,
      patch: { caption?: string | null; description?: string | null },
    ) => {
      const skey = String(sectionId);
      const pkey = String(photoId);
      const prevSection = sectionsRef.current.find(
        (s) => String(s.id) === skey,
      );
      const prevPhoto = prevSection?.photos.find(
        (p) => String(p.id) === pkey,
      );
      if (!prevPhoto) return;
      const versions = photoVersionsRef.current;
      const myVersion = (versions.get(pkey) ?? 0) + 1;
      versions.set(pkey, myVersion);
      const isLatest = () => versions.get(pkey) === myVersion;

      setSections((curr) =>
        curr.map((s) =>
          String(s.id) !== skey
            ? s
            : {
                ...s,
                photos: s.photos.map((p) =>
                  String(p.id) === pkey ? { ...p, ...patch } : p,
                ),
              },
        ),
      );
      try {
        const updated = await api.updateSectionPhoto(photoId, patch);
        if (!isLatest()) return;
        setSections((curr) =>
          curr.map((s) =>
            String(s.id) !== skey
              ? s
              : {
                  ...s,
                  photos: s.photos.map((p) =>
                    String(p.id) === pkey ? { ...p, ...updated } : p,
                  ),
                },
          ),
        );
      } catch (e) {
        if (!isLatest()) return;
        setSections((curr) =>
          curr.map((s) =>
            String(s.id) !== skey
              ? s
              : {
                  ...s,
                  photos: s.photos.map((p) =>
                    String(p.id) === pkey ? prevPhoto : p,
                  ),
                },
          ),
        );
        throw e;
      }
    },
    [],
  );

  const detachPhoto = useCallback(
    async (sectionId: string | number, photoId: string | number) => {
      const skey = String(sectionId);
      const pkey = String(photoId);
      let snapshot: SectionWithPhotos[] = [];
      setSections((curr) => {
        snapshot = curr;
        return curr.map((s) =>
          String(s.id) !== skey
            ? s
            : { ...s, photos: s.photos.filter((p) => String(p.id) !== pkey) },
        );
      });
      try {
        await api.detachSectionPhoto(photoId);
      } catch (e) {
        setSections(snapshot);
        throw e;
      }
    },
    [],
  );

  const totalPhotoCount = sections.reduce((n, s) => n + s.photos.length, 0);

  return {
    report,
    sections,
    totalPhotoCount,
    loading,
    error,
    refresh,
    updateReportMeta,
    addSection,
    updateSection,
    deleteSection,
    attachPhotos,
    updatePhoto,
    detachPhoto,
  };
}
