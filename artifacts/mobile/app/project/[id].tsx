import { Feather } from "@expo/vector-icons";
import { FlashList } from "@shopify/flash-list";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { Calendar, type DateData } from "react-native-calendars";
import * as VideoThumbnails from "expo-video-thumbnails";
import Svg from "react-native-svg";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AssigneePickerSheet, type AssigneeSelection } from "@/components/AssigneePickerSheet";
import { renderShape } from "@/components/AnnotationEditor";
import {
  strokeToRenderShape,
  type RenderShape,
} from "@/services/annotations";
import { TaskStatusPill } from "@/components/TaskStatusPill";
import { buildDuePresets } from "@/services/dueDate";
import { AssignUserToProjectModal } from "@/components/AssignUserToProjectModal";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import KebabIcon from "@/components/KebabIcon";
import { Input } from "@/components/Input";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { ThumbImage } from "@/components/ThumbImage";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { mapBackendMedia } from "@/services/mappers";
import { ApplyReportTemplateModal } from "@/components/ApplyReportTemplateModal";
import { ReportListItem } from "@/components/ReportListItem";
import { TemplatePickerModal } from "@/components/TemplatePickerModal";
import { ChecklistGenerateSheet } from "@/components/ChecklistGenerateSheet";
import { ProjectContactsSection } from "@/components/ProjectContactsSection";
import { AiActionsSheet } from "@/components/AiActionsSheet";
import { ProjectMessagesSheet } from "@/components/ProjectMessagesSheet";
import { GenerateReportSheet } from "@/components/GenerateReportSheet";
import { TitlePromptModal } from "@/components/TitlePromptModal";
import * as DocumentPicker from "expo-document-picker";
import * as WebBrowser from "expo-web-browser";

import { useProjectFiles } from "@/hooks/useProjectFiles";
import {
  downloadAndShareProjectFile,
  fileDisplayName,
  formatFileSize,
  uploadProjectFiles,
  validateUploadFile,
  type PickedUploadFile,
  type UploadItemStatus,
} from "@/services/projectFiles";
import { useAuth } from "@/contexts/AuthContext";
import { useData } from "@/contexts/DataContext";
import { useToast } from "@/contexts/ToastContext";
import { useUploadStatus } from "@/contexts/UploadStatusContext";
import { useColors } from "@/hooks/useColors";
import { useProjectChecklists } from "@/hooks/useProjectChecklists";
import { useProjectReports } from "@/hooks/useProjectReports";
import { prepareForUpload } from "@/services/imageProcessing";
import {
  api,
  ApiError,
  buildMediaReferencesMessage,
  type BackendProjectAssignment,
} from "@/services/api";
import {
  classifyUploadFailure,
  removeItem as removeUploadQueueItem,
  retryItem as retryUploadQueueItem,
  type QueuedUpload,
} from "@/services/uploadQueue";

type TabKey =
  | "photos"
  | "tasks"
  | "checklists"
  | "reports"
  | "files"
  | "team";

// ---------------------------------------------------------------------------
// Gallery filters (Photos tab). Client-side only — the project detail load
// returns the full media list, so no server round-trip is needed.
// Semantics: AND across categories, OR within one (tags, users).
// ---------------------------------------------------------------------------
type GalleryFilters = {
  sort: "newest" | "oldest";
  type: "all" | "photos" | "videos";
  /** Inclusive day range as local "YYYY-MM-DD". dateStart alone = single day. */
  dateStart: string | null;
  dateEnd: string | null;
  tags: string[];
  /** Selected uploader ids. Photos with no uploader (deleted users) are
   *  excluded only when this filter is active. */
  users: string[];
};

const DEFAULT_FILTERS: GalleryFilters = {
  sort: "newest",
  type: "all",
  dateStart: null,
  dateEnd: null,
  tags: [],
  users: [],
};

/** Chip label for an uploader: trimmed full name, or "Unknown user" when
 *  both names are null/empty. */
function uploaderLabel(u: {
  firstName: string | null;
  lastName: string | null;
}): string {
  return (
    [u.firstName, u.lastName].filter(Boolean).join(" ").trim() ||
    "Unknown user"
  );
}

/** Local calendar day of an ISO timestamp as "YYYY-MM-DD" (matches the
 *  dateString react-native-calendars emits, so range compares are plain
 *  string comparisons). */
function toDayString(iso: string | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export default function ProjectDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id, tab: tabParam } = useLocalSearchParams<{
    id: string;
    /** Optional initial tab (e.g. capture's walkthrough Done → reports). */
    tab?: string;
  }>();
  const { showToast } = useToast();
  const {
    projects,
    photos,
    tasks,
    deleteProject,
    createTask,
    cycleTaskStatus,
    deleteTask,
    deletePhoto,
    loadProjectDetail,
    addPhotosBatch,
  } = useData();
  const { user: currentUser } = useAuth();
  const isAdmin = currentUser?.role === "admin";

  // When opening a project that originated from the backend, pull its latest
  // photos / tasks / checklists so the tabs aren't empty.
  useEffect(() => {
    if (id) loadProjectDetail(String(id));
  }, [id, loadProjectDetail]);

  const project = useMemo(
    () => projects.find((p) => p.id === id),
    [projects, id],
  );
  const projectPhotos = useMemo(
    () => photos.filter((p) => p.projectId === id),
    [photos, id],
  );
  const projectTasks = useMemo(
    () => tasks.filter((t) => t.projectId === id),
    [tasks, id],
  );
  // Server-backed checklist instances for this project (v2 schema, 2026-05).
  // The hook owns its own loading + error state and refetches whenever the
  // project id changes; we just consume the array for the tab body and
  // forward the apply-template callback to the picker modal.
  const {
    checklists: projectChecklists,
    loading: checklistsLoading,
    error: checklistsError,
    refresh: refreshChecklists,
    applyTemplate,
    deleteChecklist: deleteChecklistInstance,
  } = useProjectChecklists(id);

  // Refetch checklists whenever this screen regains focus — covers the
  // case where the checklist detail screen deleted the current checklist
  // via the header kebab and called router.back(). Without this we'd
  // show a stale row. Cheap (one GET) so we don't worry about debounce.
  // Server-backed reports for this project (Mobile Reports R1).
  // Same pattern as checklists: hook owns its loading/error state,
  // refetches on project id change, and exposes optimistic create +
  // delete callbacks. The "+ New report" modal forwards to createReport.
  const {
    reports: projectReports,
    loading: reportsLoading,
    error: reportsError,
    refresh: refreshReports,
    createReport,
  } = useProjectReports(id);
  useFocusEffect(
    useCallback(() => {
      void refreshChecklists();
      // Reports too: a "generating" walkthrough row flips to done on the
      // server without any push to this list, so re-fetch on focus.
      void refreshReports();
    }, [refreshChecklists, refreshReports]),
  );
  // Read-only project files (uploads are web-only for now). Same hook
  // pattern as reports: fetches on project id change.
  const {
    files: projectFiles,
    loading: filesLoading,
    error: filesError,
    refresh: refreshFiles,
  } = useProjectFiles(id);
  // Row-level spinner while a tapped file downloads for Quick Look/share.
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(
    null,
  );
  // Active upload batch: name → status. RN fetch has no upload-progress
  // API, so each row shows a spinner + state, never a fake percentage.
  const [uploadStatuses, setUploadStatuses] = useState<
    { id: string; name: string; status: UploadItemStatus }[]
  >([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  // Real per-project team list (replaces the local-only ShareLink cache).
  // Loaded on demand when the Team tab is opened — no point pinging the
  // server for assignments the user may never view. Refreshed after a
  // successful invite or remove so the list stays in sync without a
  // full screen refresh.
  const [assignments, setAssignments] = useState<BackendProjectAssignment[]>([]);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [assignmentsError, setAssignmentsError] = useState<string | null>(null);

  // Seeded from the optional ?tab= search param (validated against the
  // real tab set; anything else falls back to photos). Read once on
  // mount — the param does not drive the state afterwards.
  const [tab, setTab] = useState<TabKey>(() =>
    tabParam === "photos" ||
    tabParam === "tasks" ||
    tabParam === "checklists" ||
    tabParam === "reports" ||
    tabParam === "files" ||
    tabParam === "team"
      ? tabParam
      : "photos",
  );
  // Messages moved from a tab pill to a slide-up sheet; ?tab=messages
  // (mention deep links) now seeds the sheet open instead.
  const [messagesSheetOpen, setMessagesSheetOpen] = useState(
    tabParam === "messages",
  );
  const [aiSheetOpen, setAiSheetOpen] = useState(false);
  // Unread message count for the cluster's messages badge. Loaded once
  // on mount; zeroed when the sheet marks the thread read.
  const [messagesUnread, setMessagesUnread] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api
      .projectUnreadCount(id)
      .then((r) => {
        if (!cancelled && typeof r?.unread === "number") {
          setMessagesUnread(r.unread);
        }
      })
      .catch(() => {
        /* badge stays 0 — non-fatal */
      });
    return () => {
      cancelled = true;
    };
  }, [id]);
  const [showTaskModal, setShowTaskModal] = useState(false);
  // Long-press suppression for task rows (same pattern as PhotoTile's
  // longPressed ref): RN Web fires onPress after onLongPress on release,
  // so a long-press delete would ALSO navigate to detail without this.
  // One ref covers all rows — only one press gesture is live at a time.
  const taskRowLongPressed = useRef(false);
  const [showChecklistModal, setShowChecklistModal] = useState(false);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [showCreateChecklistPrompt, setShowCreateChecklistPrompt] =
    useState(false);
  const [showReportGenerateSheet, setShowReportGenerateSheet] =
    useState(false);
  const [showCreateReportPrompt, setShowCreateReportPrompt] = useState(false);
  const [showAssignUserModal, setShowAssignUserModal] = useState(false);
  // Top-right kebab overflow menu. Houses destructive / infrequent
  // actions (Delete, plus manual Clock Out when the user is currently
  // clocked into THIS project — auto-exit is the happy path; the
  // kebab is the manual fallback).
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  // True while the share-token POST is in flight. Used to disable
  // the share button so impatient double-taps don't fire two POSTs.
  const [sharingProject, setSharingProject] = useState(false);

  const refreshAssignments = useCallback(async () => {
    if (!id) return;
    setAssignmentsLoading(true);
    setAssignmentsError(null);
    try {
      const rows = await api.listProjectAssignments(id);
      setAssignments(Array.isArray(rows) ? rows : []);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setAssignmentsError(
        e instanceof Error ? e.message : "Couldn't load team members.",
      );
    } finally {
      setAssignmentsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (tab !== "team") return;
    void refreshAssignments();
  }, [tab, refreshAssignments]);

  const removeMember = useCallback(
    (member: BackendProjectAssignment) => {
      const fullName = `${member.firstName} ${member.lastName}`.trim() || member.email;
      Alert.alert(
        `Remove ${fullName} from this project?`,
        "Their account is not deleted — they just lose access to this project.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            style: "destructive",
            onPress: async () => {
              try {
                await api.unassignUserFromProject(id, member.userId);
                showToast(`${fullName} removed`);
                await refreshAssignments();
              } catch (e) {
                showToast(
                  e instanceof Error ? e.message : "Couldn't remove member.",
                );
              }
            },
          },
        ],
      );
    },
    [id, refreshAssignments, showToast],
  );

  // Photos tab UI state. Grid is fixed at 2 columns (the old 1/2/3 toggle
  // was removed — it had no persistence and reset every mount anyway).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Selection mode is armed either explicitly (toolbar Select icon) or
  // implicitly whenever something is selected — the existing long-press /
  // checkbox paths keep working unchanged.
  const [selectArmed, setSelectArmed] = useState(false);
  const selectMode = selectArmed || selected.size > 0;

  // Gallery filters (client-side; the photo list is fully loaded).
  const [filters, setFilters] = useState<GalleryFilters>(DEFAULT_FILTERS);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  // Photo search (server-side, over AI captions). Empty query = normal
  // grid; search is never called with an empty q.
  const [photoQuery, setPhotoQuery] = useState("");
  const debouncedPhotoQuery = useDebouncedValue(photoQuery, 300);
  const [photoSearchResults, setPhotoSearchResults] = useState<
    import("@/services/types").Photo[] | null
  >(null);
  const [photoSearching, setPhotoSearching] = useState(false);
  const [photoSearchError, setPhotoSearchError] = useState<string | null>(
    null,
  );
  const photoSearchActive = photoQuery.trim().length > 0;

  useEffect(() => {
    const q = debouncedPhotoQuery.trim();
    if (!q) {
      setPhotoSearchResults(null);
      setPhotoSearching(false);
      setPhotoSearchError(null);
      return;
    }
    let cancelled = false;
    setPhotoSearching(true);
    setPhotoSearchError(null);
    api
      .searchMedia(q, { projectId: id, limit: 200 })
      .then((rows) => {
        if (cancelled) return;
        setPhotoSearchResults(rows.map(mapBackendMedia));
      })
      .catch((e) => {
        if (cancelled) return;
        setPhotoSearchResults(null);
        setPhotoSearchError(
          e instanceof Error ? e.message : "Search failed.",
        );
      })
      .finally(() => {
        if (!cancelled) setPhotoSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedPhotoQuery, id]);
  const filterActive =
    filters.sort !== "newest" ||
    filters.type !== "all" ||
    filters.dateStart !== null ||
    filters.tags.length > 0 ||
    filters.users.length > 0;

  // All tags present on this project's media, for the filter sheet chips.
  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const p of projectPhotos) for (const t of p.tags ?? []) s.add(t);
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [projectPhotos]);

  // Distinct uploaders among this project's loaded photos (deduped by
  // uploader.id), for the filter sheet's Users chips. Photos without an
  // uploader (deleted users) contribute no chip.
  const allUsers = useMemo(() => {
    const byId = new Map<string, { id: string; label: string }>();
    for (const p of projectPhotos) {
      if (p.uploader && !byId.has(p.uploader.id)) {
        byId.set(p.uploader.id, {
          id: p.uploader.id,
          label: uploaderLabel(p.uploader),
        });
      }
    }
    return Array.from(byId.values()).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
  }, [projectPhotos]);

  // AND across filter categories, OR within one (tags, users).
  const filteredPhotos = useMemo(() => {
    return projectPhotos.filter((p) => {
      if (filters.type === "photos" && p.isVideo) return false;
      if (filters.type === "videos" && !p.isVideo) return false;
      if (filters.dateStart) {
        const day = toDayString(p.takenAt);
        const start = filters.dateStart;
        const end = filters.dateEnd ?? filters.dateStart;
        if (day < start || day > end) return false;
      }
      if (filters.tags.length > 0) {
        const tags = p.tags ?? [];
        if (!filters.tags.some((t) => tags.includes(t))) return false;
      }
      if (filters.users.length > 0) {
        // Photos with no uploader (deleted users) are excluded only when
        // a Users filter is active.
        if (!p.uploader || !filters.users.includes(p.uploader.id))
          return false;
      }
      return true;
    });
  }, [projectPhotos, filters]);

  // Group photos by their taken-at calendar day (sort order per filter);
  // within each day, photos follow the same order.
  const photoGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        label: string;
        sortKey: number;
        ids: string[];
        photos: typeof projectPhotos;
      }
    >();
    for (const ph of filteredPhotos) {
      const d = ph.takenAt ? new Date(ph.takenAt) : new Date();
      const dayStart = new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate(),
      ).getTime();
      const dayKey = String(dayStart);
      const label = d.toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
      const g =
        groups.get(dayKey) ??
        { label, sortKey: dayStart, ids: [], photos: [] };
      g.ids.push(ph.id);
      g.photos.push(ph);
      groups.set(dayKey, g);
    }
    const list = Array.from(groups.values());
    const dir = filters.sort === "oldest" ? -1 : 1;
    for (const g of list) {
      g.photos.sort((a, b) => {
        const ta = a.takenAt ? Date.parse(a.takenAt) : 0;
        const tb = b.takenAt ? Date.parse(b.takenAt) : 0;
        return (tb - ta) * dir;
      });
      g.ids = g.photos.map((p) => p.id);
    }
    return list.sort((a, b) => (b.sortKey - a.sortKey) * dir);
  }, [filteredPhotos, filters.sort]);

  // Flattened, virtualization-friendly item list for the photos grid
  // (memory fix part A). Date-section headers span the full width, so
  // instead of FlashList numColumns (which cannot mix full-width rows
  // with tile rows) each item is either a header or an explicit row of
  // up to THREE photos — 3-up layout, one list item per row.
  type GridRowItem =
    | { kind: "header"; key: string; label: string; ids: string[] }
    | { kind: "row"; key: string; photos: typeof projectPhotos }
    | {
        // Server search result row: full-width, thumb + AI caption so
        // it's obvious why the photo matched.
        kind: "searchResult";
        key: string;
        photo: import("@/services/types").Photo;
      };
  const gridItems = useMemo<GridRowItem[]>(() => {
    const items: GridRowItem[] = [];
    for (const g of photoGroups) {
      items.push({
        kind: "header",
        key: `h-${g.label}`,
        label: g.label,
        ids: g.ids,
      });
      for (let i = 0; i < g.photos.length; i += 3) {
        items.push({
          kind: "row",
          key: `r-${g.photos[i].id}`,
          photos: g.photos.slice(i, i + 3),
        });
      }
    }
    return items;
  }, [photoGroups]);

  // While a search query is active the FlashList swaps to result rows —
  // same list component so the header (and its TextInput) stays mounted.
  const searchItems = useMemo<GridRowItem[]>(() => {
    if (!photoSearchResults) return [];
    return photoSearchResults.map((p) => ({
      kind: "searchResult" as const,
      key: `s-${p.id}`,
      photo: p,
    }));
  }, [photoSearchResults]);

  const exitSelectMode = () => {
    setSelected(new Set());
    setSelectArmed(false);
  };

  // Applying filters can hide photos that were already selected. Selection
  // must always operate on VISIBLE items (sharing a filtered selection
  // shares only those), so prune the selected set to the filtered view.
  const applyFilters = (next: GalleryFilters) => {
    setFilters(next);
    setFilterSheetOpen(false);
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(
        projectPhotos
          .filter((p) => {
            if (next.type === "photos" && p.isVideo) return false;
            if (next.type === "videos" && !p.isVideo) return false;
            if (next.dateStart) {
              const day = toDayString(p.takenAt);
              const end = next.dateEnd ?? next.dateStart;
              if (day < next.dateStart || day > end) return false;
            }
            if (next.tags.length > 0) {
              const tags = p.tags ?? [];
              if (!next.tags.some((t) => tags.includes(t))) return false;
            }
            if (next.users.length > 0) {
              if (!p.uploader || !next.users.includes(p.uploader.id))
                return false;
            }
            return true;
          })
          .map((p) => p.id),
      );
      const pruned = new Set(Array.from(prev).filter((i) => visible.has(i)));
      return pruned.size === prev.size ? prev : pruned;
    });
  };

  // Add-from-camera-roll: device library multi-select feeding the SAME
  // upload pipeline as captured photos (prepareForUpload → addPhotosBatch
  // → offline queue). GPS is optional in the pipeline; library imports
  // simply omit it, exactly like the capture screen's library flow.
  const [addingFromLibrary, setAddingFromLibrary] = useState(false);
  const onAddFromLibrary = async () => {
    if (!project || addingFromLibrary) return;
    setAddingFromLibrary(true);
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        selectionLimit: 20,
        quality: 0.7,
        exif: false,
      });
      if (res.canceled || res.assets.length === 0) return;
      const now = new Date().toISOString();
      const prepared = await Promise.all(
        res.assets.map(async (a) => ({
          a,
          p: await prepareForUpload(a.uri, a.mimeType ?? "image/jpeg"),
        })),
      );
      await addPhotosBatch(
        prepared.map(({ a, p }) => ({
          projectId: project.id,
          uri: p?.localUri ?? a.uri,
          takenAt: now,
          originalName: p?.originalName,
          mimeType: p?.mimeType,
          fileSize: p?.fileSize,
        })),
      );
      showToast(
        `Added ${res.assets.length} photo${res.assets.length === 1 ? "" : "s"} from library`,
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Couldn't add photos");
    } finally {
      setAddingFromLibrary(false);
    }
  };

  // True while the POST /api/galleries call for a selected-photos
  // share is in flight. Disables the hero share button so a
  // double-tap can't mint two gallery tokens.
  const [sharingSelection, setSharingSelection] = useState(false);
  // Snapshot vs Live choice modal for the gallery share link.
  // Snapshot (default) freezes the selected photos; Live tracks all
  // project photos over time. isLive is chosen inside the modal and
  // passed straight to the POST.
  const [shareChoiceVisible, setShareChoiceVisible] = useState(false);
  const [shareIsLive, setShareIsLive] = useState(false);

  const openShareChoice = () => {
    if (sharingSelection) return;
    if (selected.size === 0) return;
    setShareIsLive(false); // default Snapshot on every open
    setShareChoiceVisible(true);
  };

  const onShareSelected = async (isLive: boolean) => {
    if (!project) return;
    if (sharingSelection) return;
    if (selected.size === 0) return;
    // The selection set holds local photo ids (strings). The server
    // wants numeric media ids, and local-only photos (pending/failed
    // uploads) have no mediaId yet — they can't be in a share link.
    const photosById = new Map(photos.map((p) => [p.id, p]));
    const mediaIds: number[] = [];
    for (const pid of Array.from(selected)) {
      const mid = Number(photosById.get(pid)?.mediaId);
      if (Number.isFinite(mid)) mediaIds.push(mid);
    }
    if (mediaIds.length === 0) {
      showToast("Selected photos haven't finished uploading yet");
      return;
    }
    setSharingSelection(true);
    let token: string;
    try {
      const res = await api.createSharedGallery({
        projectId: Number(project.id),
        mediaIds,
        // Snapshot omits the flag entirely (pre-isLive server payload
        // parity); Live sends it explicitly. mediaIds are sent either
        // way — the server ignores them for live galleries.
        ...(isLive ? { isLive: true } : {}),
      });
      token = res.token;
    } catch (e) {
      // Stay in selection mode so the user can retry.
      showToast(shareLinkFailureMessage(e));
      setSharingSelection(false);
      return;
    }
    setSharingSelection(false);
    // Same hard-coded public web origin rationale as onShareProject:
    // recipients open this in Safari, so it must always point at the
    // public web host. NOTE: /gallery/<token>, not /p/<token>.
    const shareUrl = `https://app.field-view.com/gallery/${token}`;
    showToast("Share link ready");
    try {
      await Share.share({ url: shareUrl });
    } catch {
      /* user cancelled */
    }
    exitSelectMode();
  };

  const onShareProject = async () => {
    if (!project) return;
    if (sharingProject) return;
    // Project-level public share. Mint (or fetch existing) token
    // first; only open the share sheet on success.
    setSharingProject(true);
    let token: string;
    try {
      const res = await api.shareProject(project.id);
      token = res.shareToken;
    } catch (e) {
      showToast(shareLinkFailureMessage(e));
      setSharingProject(false);
      return;
    }
    setSharingProject(false);
    // Hard-coded public web origin (NOT EXPO_PUBLIC_API_BASE_URL):
    // recipients open the link in Safari, so it must always point
    // at the public marketing/web host regardless of which API base
    // the build was pinned to.
    const shareUrl = `https://app.field-view.com/p/${token}`;
    showToast("Share link ready");
    try {
      // url-only — passing both `url` and `message` causes iMessage
      // to render two link previews plus the body text. Keeping it
      // minimal is the fix for the double-preview bug.
      await Share.share({ url: shareUrl });
    } catch {
      /* user cancelled */
    }
  };

  const togglePhotoSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleGroupSelected = (ids: string[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = ids.every((i) => next.has(i));
      if (allSelected) for (const i of ids) next.delete(i);
      else for (const i of ids) next.add(i);
      return next;
    });
  };

  // Single-photo delete entry point used by PhotoTile.onDelete and by
  // anywhere else a "delete this one photo" action lives. Handles:
  //  - failed/pending uploads (no server media row) → local-only confirm
  //  - synced photos → fetch refs, show refs-aware confirm, server-first
  //    delete then local cleanup. Errors surface as toasts; 401 is silent.
  const confirmAndDeletePhoto = useCallback(
    async (photo: import("@/services/types").Photo) => {
      const mediaId = photo.mediaId;

      const doServerThenLocal = async () => {
        try {
          if (mediaId !== undefined) await api.deleteMedia(mediaId);
          await deletePhoto(photo.id);
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) return;
          showToast(
            e instanceof Error ? e.message : "Couldn't delete photo.",
          );
        }
      };

      // Local-only path (failed/pending upload — no server media row).
      if (mediaId === undefined) {
        if (Platform.OS === "web") return deletePhoto(photo.id);
        Alert.alert(
          "Delete photo?",
          "This will permanently remove the photo.",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Delete",
              style: "destructive",
              onPress: () => void deletePhoto(photo.id),
            },
          ],
        );
        return;
      }

      // Server-backed path: fetch refs, then refs-aware confirm.
      let refsMessage = "";
      try {
        const refs = await api.getMediaReferences(mediaId);
        refsMessage = buildMediaReferencesMessage(refs);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        showToast(
          e instanceof Error ? e.message : "Couldn't check references.",
        );
        return;
      }

      const body = refsMessage || "This will permanently remove the photo.";
      if (Platform.OS === "web") return doServerThenLocal();
      Alert.alert("Delete photo?", body, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: doServerThenLocal },
      ]);
    },
    [deletePhoto, showToast],
  );

  // Checklist-instance delete (long-press on a row). Confirmation copy
  // mirrors the spec; on confirm we call the hook's optimistic delete,
  // which removes the row immediately and rolls back on server failure.
  const confirmDeleteChecklist = useCallback(
    (checklistId: string | number, _title: string) => {
      const doIt = async () => {
        try {
          await deleteChecklistInstance(checklistId);
          showToast("Checklist deleted");
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) return;
          showToast(
            e instanceof Error ? e.message : "Couldn't delete checklist.",
          );
        }
      };
      if (Platform.OS === "web") return doIt();
      Alert.alert(
        "Delete checklist?",
        "This will permanently remove the checklist and all its sections, items, and recorded responses.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: () => void doIt() },
        ],
      );
    },
    [deleteChecklistInstance, showToast],
  );

  const deleteSelected = () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    // Build a parallel array of mediaIds so we know which photos need a
    // server DELETE vs which are local-only (failed/pending uploads).
    const photosById = new Map(photos.map((p) => [p.id, p]));
    const doIt = async () => {
      // Server-first per item: if the media DELETE fails we surface a
      // toast and continue to the next item — partial success is better
      // than stopping. Local cleanup always runs (matches the previous
      // local-only behavior; safe because deletePhoto is idempotent on
      // missing ids).
      //
      // INTENTIONAL: no per-item references check in batch mode. Doing
      // it N times would either spam dialogs or aggregate into something
      // unworkable. Trade-off: users batch-deleting from shared reports
      // won't get the "shared link will break" heads-up. See TECH_DEBT.md.
      // Strictly server-first: only remove locally if the server DELETE
      // succeeds (or the row was already gone — 404 counts as success
      // because the desired end state matches). Anything else leaves
      // the local row in place so the user sees the failure and can
      // retry rather than ending up with phantom-deleted photos that
      // still exist server-side. Failures are aggregated into one toast.
      let failureCount = 0;
      for (const pid of ids) {
        const ph = photosById.get(pid);
        if (ph?.mediaId !== undefined) {
          try {
            await api.deleteMedia(ph.mediaId);
          } catch (e) {
            if (e instanceof ApiError && e.status === 401) {
              exitSelectMode();
              return;
            }
            if (!(e instanceof ApiError && e.status === 404)) {
              failureCount += 1;
              continue; // skip local removal — keep row visible
            }
          }
        }
        await deletePhoto(pid);
      }
      if (failureCount > 0) {
        showToast(
          `Couldn't delete ${failureCount} photo${failureCount === 1 ? "" : "s"}.`,
        );
      }
      exitSelectMode();
    };
    if (Platform.OS === "web") return doIt();
    Alert.alert(
      `Delete ${ids.length} photo${ids.length === 1 ? "" : "s"}?`,
      undefined,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: doIt },
      ],
    );
  };

  if (!project) {
    return (
      <View style={[styles.wrap, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: "Project" }} />
        <EmptyState
          icon="alert-triangle"
          title="Project not found"
          description="This project may have been deleted."
        />
      </View>
    );
  }

  const onDelete = () => {
    const doIt = () =>
      deleteProject(project.id)
        .then(() => router.back())
        .catch((e: unknown) => {
          // Surface the server's reason so the user knows why it failed —
          // notably 409 "has time entries" and 403 permission. apiFetch
          // throws ApiError(status, serverMessage); fall back to a generic
          // line for anything else.
          const msg =
            e instanceof ApiError
              ? e.message
              : "Couldn't delete project. Please try again.";
          showToast(msg);
        });
    if (Platform.OS === "web") {
      doIt();
      return;
    }
    Alert.alert(
      "Delete project?",
      `"${project.name}" and all of its photos and tasks will be permanently removed.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: doIt },
      ],
    );
  };

  // Hero must never feed a video URL to <Image>. coverPhotoUrl comes from
  // the server (recentPhotos[0], which carries no media type), so if we can
  // see it's actually a video in the loaded media, skip it and fall back to
  // the first non-video photo.
  const coverIsKnownVideo = projectPhotos.some(
    (p) =>
      p.isVideo &&
      (p.remoteUrl === project.coverPhotoUrl || p.uri === project.coverPhotoUrl),
  );
  const heroPhoto =
    (coverIsKnownVideo ? undefined : project.coverPhotoUrl) ??
    projectPhotos.find((p) => !p.isVideo)?.uri ??
    projectPhotos[0]?.uri;
  const status = (project.status ?? "active").toLowerCase();
  const statusColor =
    status === "active"
      ? colors.primary
      : status === "complete" || status === "completed"
        ? colors.success
        : colors.mutedForeground;
  const doneTaskCount = projectTasks.filter((t) => t.done).length;
  const donePct =
    projectTasks.length === 0
      ? 0
      : Math.round((doneTaskCount / projectTasks.length) * 100);
  const totalPhotos =
    typeof project.photoCount === "number" && project.photoCount >= projectPhotos.length
      ? project.photoCount
      : projectPhotos.length;
  // Files tab: newest first (server order is not guaranteed).
  const sortedFiles = [...projectFiles].sort(
    (a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""),
  );

  const fileIconName = (
    mimeType: string,
  ): keyof typeof Feather.glyphMap => {
    const m = (mimeType || "").toLowerCase();
    if (m.startsWith("image/")) return "image";
    if (
      m === "application/pdf" ||
      m === "text/plain" ||
      m === "application/msword" ||
      m ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
      return "file-text";
    if (
      m === "text/csv" ||
      m === "application/vnd.ms-excel" ||
      m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
      return "grid";
    return "file";
  };

  // Tap = in-app browser viewer (SFSafariViewController / Chrome Custom
  // Tabs): a sheet over the app with a Done button, not an app switch
  // and not a share sheet. The explicit Share action on the row handles
  // sharing the actual file.
  const openProjectFile = async (file: (typeof projectFiles)[number]) => {
    try {
      await WebBrowser.openBrowserAsync(file.url, {
        dismissButtonStyle: "done",
        enableDefaultShareMenuItem: true,
        enableBarCollapsing: true,
        toolbarColor: "#FFFFFF",
        // Theme primary (palette.amber) — same hex in light and dark.
        controlsColor: colors.primary,
        showTitle: true,
      });
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Couldn't open that file.");
    }
  };

  // Row Share action: download the real file to cache, then hand it to
  // the native share sheet (mime/UTI derived in the service).
  const shareProjectFile = async (file: (typeof projectFiles)[number]) => {
    if (downloadingFileId) return;
    setDownloadingFileId(String(file.id));
    try {
      await downloadAndShareProjectFile(file);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Couldn't share that file.");
    } finally {
      setDownloadingFileId(null);
    }
  };

  const onAddFiles = async () => {
    if (uploadingFiles) return;
    let result: DocumentPicker.DocumentPickerResult;
    try {
      result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Couldn't open the picker.");
      return;
    }
    if (result.canceled || result.assets.length === 0) return;

    // Client-side pre-flight (ext + size) BEFORE any network round trip:
    // invalid files are reported immediately and never signed.
    const valid: PickedUploadFile[] = [];
    const rejected: { name: string; reason: string }[] = [];
    for (let i = 0; i < result.assets.length; i++) {
      const asset = result.assets[i];
      const picked: PickedUploadFile = {
        // Names can duplicate within a batch — the index-based id keys
        // all status tracking; the name is display-only.
        id: `${i}-${asset.uri}`,
        uri: asset.uri,
        name: asset.name,
        size: asset.size ?? undefined,
      };
      const reason = validateUploadFile(picked);
      if (reason) rejected.push({ name: picked.name, reason });
      else valid.push(picked);
    }
    if (rejected.length > 0) {
      Alert.alert(
        "Some files can't be uploaded",
        rejected.map((r) => `${r.name}: ${r.reason}`).join("\n"),
      );
    }
    if (valid.length === 0) return;

    setUploadingFiles(true);
    setUploadStatuses(
      valid.map((f) => ({ id: f.id, name: f.name, status: "pending" })),
    );
    const setStatus = (id: string, status: UploadItemStatus) =>
      setUploadStatuses((curr) =>
        curr.map((s) => (s.id === id ? { ...s, status } : s)),
      );
    try {
      const { succeeded, failed } = await uploadProjectFiles(
        project.id,
        valid,
        setStatus,
      );
      if (failed.length > 0) {
        // Partial failure: successes are kept; name each failed file.
        Alert.alert(
          succeeded.length > 0 ? "Some uploads failed" : "Upload failed",
          failed.map((f) => `${f.name}: ${f.reason}`).join("\n"),
        );
      } else if (succeeded.length > 0) {
        showToast(
          succeeded.length === 1
            ? "1 file uploaded"
            : `${succeeded.length} files uploaded`,
        );
      }
      if (succeeded.length > 0) await refreshFiles();
    } catch (e) {
      // Sign call (or another pre-PUT step) failed — nothing uploaded.
      Alert.alert(
        "Upload failed",
        e instanceof Error ? e.message : "Couldn't upload files.",
      );
    } finally {
      setUploadingFiles(false);
      setUploadStatuses([]);
    }
  };

  const createdLabel = project.createdAt
    ? new Date(project.createdAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  // Shared above-the-grid content: hero, summary card, tab pills. Used
  // as the FlashList header on the photos tab (which must own the
  // scroll container to virtualize) and inline in the ScrollView for
  // every other tab.
  const sharedHeader = (
    <>
        <View style={styles.heroWrap}>
          {heroPhoto ? (
            <Image
              source={{ uri: heroPhoto }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              transition={150}
            />
          ) : (
            <View
              style={[
                StyleSheet.absoluteFill,
                {
                  backgroundColor: colors.muted,
                  alignItems: "center",
                  justifyContent: "center",
                },
              ]}
            >
              <Feather
                name="image"
                size={36}
                color={colors.mutedForeground}
              />
            </View>
          )}
          <View style={[styles.heroScrim, { paddingTop: insets.top + 8 }]}>
            <Pressable
              onPress={() => router.back()}
              hitSlop={10}
              style={styles.heroBackBtn}
            >
              <Feather name="chevron-left" size={18} color="#fff" />
              <Text style={styles.heroBackTxt}>Projects</Text>
            </Pressable>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Pressable
                onPress={() => setShowProjectMenu(true)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="More options"
                style={styles.heroIconBtn}
              >
                <KebabIcon size={18} color="#fff" />
              </Pressable>
            </View>
          </View>
        </View>

        <View
          style={[
            styles.summaryCard,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <View style={styles.summaryTitleRow}>
            <Text
              style={[styles.summaryTitle, { color: colors.foreground }]}
              numberOfLines={2}
            >
              {project.name}
            </Text>
            <View
              style={[
                styles.statusPill,
                { backgroundColor: statusColor + "22" },
              ]}
            >
              <View
                style={[styles.statusDot, { backgroundColor: statusColor }]}
              />
              <Text
                style={[styles.statusText, { color: statusColor }]}
                numberOfLines={1}
              >
                {(project.status ?? "active").toString()}
              </Text>
            </View>
          </View>

          {project.address ? (
            <View style={styles.summaryMetaRow}>
              <Feather
                name="map-pin"
                size={13}
                color={colors.mutedForeground}
              />
              <Text
                style={[
                  styles.summaryMeta,
                  { color: colors.foreground },
                ]}
                numberOfLines={2}
              >
                {project.address}
              </Text>
            </View>
          ) : null}

          {createdLabel ? (
            <View style={styles.summaryMetaRow}>
              <Feather
                name="calendar"
                size={13}
                color={colors.mutedForeground}
              />
              <Text
                style={[
                  styles.summaryMeta,
                  { color: colors.mutedForeground },
                ]}
              >
                {createdLabel}
              </Text>
            </View>
          ) : null}

          <View style={[styles.statsRow, { borderTopColor: colors.border }]}>
            <View style={styles.statCol}>
              <Text style={[styles.statNum, { color: colors.primary }]}>
                {totalPhotos}
              </Text>
              <Text
                style={[styles.statLbl, { color: colors.mutedForeground }]}
              >
                PHOTOS
              </Text>
            </View>
            <View
              style={[
                styles.statDivider,
                { backgroundColor: colors.border },
              ]}
            />
            <View style={styles.statCol}>
              <Text
                style={[styles.statNum, { color: colors.foreground }]}
              >
                {projectTasks.length}
              </Text>
              <Text
                style={[styles.statLbl, { color: colors.mutedForeground }]}
              >
                TASKS
              </Text>
            </View>
            <View
              style={[
                styles.statDivider,
                { backgroundColor: colors.border },
              ]}
            />
            <View style={styles.statCol}>
              <Text style={[styles.statNum, { color: colors.success }]}>
                {donePct}%
              </Text>
              <Text
                style={[styles.statLbl, { color: colors.mutedForeground }]}
              >
                DONE
              </Text>
            </View>
          </View>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.pillTabsRow}
        >
          {(
            [
              { key: "photos", label: "Photos", count: projectPhotos.length },
              { key: "tasks", label: "Tasks", count: projectTasks.length },
              {
                key: "checklists",
                label: "Checklists",
                count: projectChecklists.length,
              },
              {
                key: "reports",
                label: "Reports",
                count: projectReports.length,
              },
              // NOTE: Messages is deliberately NOT a tab — the thread
              // lives in a slide-up sheet opened from the floating
              // cluster (unread badge sits on that icon).
              { key: "files", label: "Files", count: projectFiles.length },
              { key: "team", label: "Team", count: assignments.length },
            ] as { key: TabKey; label: string; count: number }[]
          ).map((t) => {
            const active = tab === t.key;
            return (
              <Pressable
                key={t.key}
                onPress={() => setTab(t.key)}
                style={[
                  styles.pillTab,
                  {
                    backgroundColor: active ? colors.muted : "transparent",
                  },
                ]}
              >
                <Text
                  style={[
                    styles.pillTabLabel,
                    {
                      color: active
                        ? colors.foreground
                        : colors.mutedForeground,
                      fontFamily: active
                        ? "Inter_700Bold"
                        : "Inter_500Medium",
                    },
                  ]}
                >
                  {t.label}
                </Text>
                <Text
                  style={[
                    styles.pillTabCount,
                    {
                      color: active
                        ? colors.mutedForeground
                        : colors.mutedForeground,
                    },
                  ]}
                >
                  {t.count}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
    </>
  );

  // Photos-tab list header: shared header + toolbar + empty states.
  // The grid rows themselves are FlashList items (virtualized).
  const photosListHeader = (
    <>
      {sharedHeader}
          {/* paddingBottom 0: the 12pt toolbar → date-header gap is
              owned by gridHeaderRow's paddingTop (single source). */}
          <View style={[styles.body, { paddingBottom: 0 }]}>
            {/* Search now lives in the row the Take Photo button used to
                occupy (capture moved to the floating action cluster). */}
            <View style={styles.photosToolbar}>
              <View
                style={[
                  styles.photoSearchWrap,
                  {
                    backgroundColor: colors.muted,
                    borderColor: colors.border,
                  },
                ]}
              >
                <Feather
                  name="search"
                  size={16}
                  color={colors.mutedForeground}
                />
                <TextInput
                  value={photoQuery}
                  onChangeText={setPhotoQuery}
                  placeholder="Search photos…"
                  placeholderTextColor={colors.mutedForeground}
                  style={[
                    styles.photoSearchInput,
                    { color: colors.foreground },
                  ]}
                  autoCorrect={false}
                  autoCapitalize="none"
                  returnKeyType="search"
                />
                {photoSearching ? (
                  <ActivityIndicator
                    size="small"
                    color={colors.mutedForeground}
                  />
                ) : photoQuery ? (
                  <Pressable
                    onPress={() => setPhotoQuery("")}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Clear photo search"
                  >
                    <Feather
                      name="x-circle"
                      size={16}
                      color={colors.mutedForeground}
                    />
                  </Pressable>
                ) : null}
              </View>
              <PhotosToolbar
                selectMode={selectMode}
                onToggleSelect={() => {
                  if (selectMode) exitSelectMode();
                  else setSelectArmed(true);
                }}
                filterActive={filterActive}
                onOpenFilter={() => setFilterSheetOpen(true)}
                addingFromLibrary={addingFromLibrary}
                onAddFromLibrary={() => void onAddFromLibrary()}
                colors={colors}
              />
            </View>

            {photoSearchActive ? (
              photoSearchError ? (
                <View style={{ paddingTop: 20 }}>
                  <EmptyState
                    icon="alert-circle"
                    title="Search failed"
                    description={photoSearchError}
                  />
                </View>
              ) : photoSearchResults !== null &&
                photoSearchResults.length === 0 &&
                !photoSearching ? (
                <View style={{ paddingTop: 20 }}>
                  <EmptyState
                    icon="search"
                    title="No matching photos"
                    description={`Nothing matches "${photoQuery.trim()}". Try different words.`}
                  />
                </View>
              ) : null
            ) : projectPhotos.length === 0 ? (
              <View style={{ paddingTop: 20 }}>
                <EmptyState
                  icon="camera"
                  title="No photos yet"
                  description="Tap the camera button below to capture burst-mode photos with GPS tagging."
                />
              </View>
            ) : filteredPhotos.length === 0 ? (
              <View style={{ paddingTop: 20 }}>
                <EmptyState
                  icon="filter"
                  title="No photos match your filters"
                  description="Adjust or clear the filters to see this project's photos."
                />
              </View>
            ) : null}
          </View>
    </>
  );

  const renderGridItem = ({ item }: { item: (typeof gridItems)[number] }) => {
    if (item.kind === "header") {
      const allSelected = item.ids.every((i) => selected.has(i));
      return (
        <View style={styles.gridHeaderRow}>
          <View style={styles.dateHeader}>
            <Pressable
              onPress={() => toggleGroupSelected(item.ids)}
              hitSlop={6}
              accessibilityRole="checkbox"
              accessibilityLabel={`Select all photos from ${item.label}`}
              accessibilityState={{ checked: allSelected }}
              style={[
                styles.dateCheckbox,
                {
                  borderColor: allSelected ? colors.primary : colors.border,
                  backgroundColor: allSelected
                    ? colors.primary
                    : "transparent",
                },
              ]}
            >
              {allSelected ? (
                <Feather
                  name="check"
                  size={12}
                  color={colors.primaryForeground}
                />
              ) : null}
            </Pressable>
            <Text style={[styles.dateLabel, { color: colors.foreground }]}>
              {item.label}
            </Text>
          </View>
        </View>
      );
    }
    if (item.kind === "searchResult") {
      const ph = item.photo;
      const caption =
        ph.aiCaption && ph.aiCaption !== "UNCLEAR" ? ph.aiCaption : null;
      return (
        <Pressable
          onPress={() => router.push(`/photo/${ph.id}`)}
          style={[
            styles.searchResultRow,
            { borderColor: colors.border, backgroundColor: colors.card },
          ]}
        >
          <View
            style={[
              styles.searchResultThumb,
              { backgroundColor: colors.muted },
            ]}
          >
            <ThumbImage
              cacheKey={ph.id}
              uri={ph.thumbUrl ?? ph.uri}
              style={StyleSheet.absoluteFill}
            />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            {caption ? (
              <Text
                style={[styles.searchResultCaption, { color: colors.foreground }]}
                numberOfLines={3}
              >
                {caption}
              </Text>
            ) : (
              <Text
                style={[
                  styles.searchResultCaption,
                  { color: colors.mutedForeground },
                ]}
              >
                Matched photo
              </Text>
            )}
          </View>
        </Pressable>
      );
    }
    return (
      <View style={styles.gridPairRow}>
        {item.photos.map((ph) => (
          <PhotoTile
            key={ph.id}
            photo={ph}
            borderColor={colors.border}
            selectMode={selectMode}
            selected={selected.has(ph.id)}
            primary={colors.primary}
            primaryForeground={colors.primaryForeground}
            onOpen={() => router.push(`/photo/${ph.id}`)}
            onToggleSelected={() => togglePhotoSelected(ph.id)}
            onDelete={() => void confirmAndDeletePhoto(ph)}
            onRemoveLocal={() => void deletePhoto(ph.id)}
          />
        ))}
        {/* Flex fillers keep short rows from stretching their tiles. */}
        {item.photos.length < 3
          ? Array.from({ length: 3 - item.photos.length }).map((_, i) => (
              <View key={`f-${i}`} style={{ flex: 1 }} />
            ))
          : null}
      </View>
    );
  };

  return (
    <View style={[styles.wrap, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />

      {tab === "photos" ? (
        <>
          <FlashList
            data={photoSearchActive ? searchItems : gridItems}
            keyExtractor={(it) => it.key}
            renderItem={renderGridItem}
            // Selection state lives outside the items — every selection
            // mutation replaces the Set immutably, so this object's
            // identity changes exactly when rows must re-render.
            extraData={{ selectMode, selected }}
            ListHeaderComponent={photosListHeader}
            contentContainerStyle={{
              // Extra bottom padding for the floating action cluster
              // (≈88px incl. margin) so it never covers the last photo
              // row, plus the floating selection bar when it's up.
              paddingBottom:
                insets.bottom + 24 + 88 + (selectMode ? 72 : 0),
            }}
          />
          <FilterSheet
            visible={filterSheetOpen}
            filters={filters}
            allTags={allTags}
            allUsers={allUsers}
            onApply={applyFilters}
            onClose={() => setFilterSheetOpen(false)}
            colors={colors}
          />
        </>
      ) : (
      <ScrollView
        // +88 clears the floating action cluster (visible on these tabs).
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 + 88 }}
      >
        {sharedHeader}

        {tab === "tasks" ? (
          <View style={styles.body}>
            {projectTasks.length === 0 ? (
              <EmptyState
                icon="check-square"
                title="No tasks yet"
                description="Create tasks to track open items on this project."
                action={
                  <Button
                    title="Add task"
                    onPress={() => setShowTaskModal(true)}
                  />
                }
              />
            ) : (
              <View style={{ gap: 8 }}>
                {projectTasks.map((t) => (
                  <Pressable
                    key={t.id}
                    // Whole row opens task detail; nested Pressables
                    // (status pill, camera chip) win the hit on their
                    // own area. Long-press keeps delete.
                    onPress={() => {
                      if (taskRowLongPressed.current) {
                        taskRowLongPressed.current = false;
                        return;
                      }
                      router.push(`/task/${t.id}`);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Open task: ${t.title}`}
                    onLongPress={() => {
                      taskRowLongPressed.current = true;
                      if (Platform.OS === "web") return deleteTask(t.id);
                      Alert.alert("Delete task?", undefined, [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Delete",
                          style: "destructive",
                          onPress: () => deleteTask(t.id),
                        },
                      ]);
                    }}
                    style={[
                      styles.taskRow,
                      {
                        backgroundColor: colors.card,
                        borderColor: colors.border,
                        alignItems: "flex-start",
                      },
                    ]}
                  >
                    <TaskStatusPill
                      status={t.status ?? "todo"}
                      onPress={() => cycleTaskStatus(t.id).catch(() => {})}
                    />
                    <View style={{ flex: 1 }}>
                      <Text
                        style={[
                          styles.taskTitle,
                          {
                            color: t.done
                              ? colors.mutedForeground
                              : colors.foreground,
                            textDecorationLine: t.done
                              ? "line-through"
                              : "none",
                          },
                        ]}
                      >
                        {t.title}
                      </Text>
                      {t.assignedToName ? (
                        <View
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 4,
                            marginTop: 3,
                          }}
                        >
                          <Feather
                            name="user"
                            size={11}
                            color={colors.mutedForeground}
                          />
                          <Text
                            style={[
                              styles.taskNotes,
                              { color: colors.mutedForeground },
                            ]}
                            numberOfLines={1}
                          >
                            {t.assignedToName}
                          </Text>
                        </View>
                      ) : null}
                      {t.notes ? (
                        <Text
                          style={[
                            styles.taskNotes,
                            { color: colors.mutedForeground },
                          ]}
                          numberOfLines={2}
                        >
                          {t.notes}
                        </Text>
                      ) : null}
                      {/* Camera chip — opens the task detail screen
                          (which owns photo attach/detach now). Amber
                          while a requirement is unmet. */}
                      <Pressable
                        onPress={(e) => {
                          // RN Web bubbles to the row's onPress; native
                          // picks the inner target. Same guard as the
                          // tasks-tab chevron. Row and chip both go to
                          // detail today, but keep the propagation
                          // contract explicit.
                          e?.stopPropagation?.();
                          router.push(`/task/${t.id}`);
                        }}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel="Task photos"
                        style={({ pressed }) => ({
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 4,
                          marginTop: 3,
                          opacity: pressed ? 0.6 : 1,
                          alignSelf: "flex-start",
                        })}
                      >
                        <Feather
                          name="camera"
                          size={11}
                          color={
                            !t.done &&
                            (t.attachedPhotoCount ?? 0) <
                              (t.requiredPhotoCount ?? 0)
                              ? "#D97706"
                              : colors.mutedForeground
                          }
                        />
                        <Text
                          style={[
                            styles.taskNotes,
                            {
                              color:
                                !t.done &&
                                (t.attachedPhotoCount ?? 0) <
                                  (t.requiredPhotoCount ?? 0)
                                  ? "#D97706"
                                  : colors.mutedForeground,
                            },
                          ]}
                        >
                          {(t.requiredPhotoCount ?? 0) > 0
                            ? `${t.attachedPhotoCount ?? 0} of ${t.requiredPhotoCount} photos`
                            : (t.attachedPhotoCount ?? 0) > 0
                              ? `${t.attachedPhotoCount} photo${t.attachedPhotoCount === 1 ? "" : "s"}`
                              : "Photos"}
                        </Text>
                      </Pressable>
                    </View>
                  </Pressable>
                ))}
                <Button
                  title="Add task"
                  variant="secondary"
                  onPress={() => setShowTaskModal(true)}
                />
              </View>
            )}
          </View>
        ) : null}

        {tab === "checklists" ? (
          <View style={styles.body}>
            {checklistsLoading && projectChecklists.length === 0 ? (
              <View style={{ paddingVertical: 32, alignItems: "center" }}>
                <ActivityIndicator color={colors.mutedForeground} />
              </View>
            ) : checklistsError && projectChecklists.length === 0 ? (
              <View style={{ gap: 10 }}>
                <Text
                  style={{
                    color: colors.destructive,
                    fontFamily: "Inter_500Medium",
                    fontSize: 14,
                  }}
                >
                  {checklistsError}
                </Text>
                <Button
                  title="Retry"
                  variant="secondary"
                  onPress={() => void refreshChecklists()}
                />
              </View>
            ) : projectChecklists.length === 0 ? (
              <EmptyState
                icon="list"
                title="No checklists yet"
                description="Generate one with AI from a quick description, or apply a template. New templates and items are managed on the web."
                action={
                  <View style={{ gap: 8 }}>
                    <Button
                      title="Generate with AI"
                      onPress={() => setShowGenerateModal(true)}
                    />
                    <Button
                      title="Apply template"
                      variant="secondary"
                      onPress={() => setShowChecklistModal(true)}
                    />
                    <Button
                      title="Create new"
                      variant="secondary"
                      onPress={() => setShowCreateChecklistPrompt(true)}
                    />
                  </View>
                }
              />
            ) : (
              <View style={{ gap: 12 }}>
                {projectChecklists.map((c) => {
                  // Tappable summary row — opens the detail screen which owns
                  // sections + items + photo workflow. We don't fetch counts
                  // here (would mean N+1); the detail screen shows progress.
                  // Long-press → delete confirm (mirrors tasks pattern).
                  return (
                    <Pressable
                      key={String(c.id)}
                      onPress={() =>
                        router.push({
                          pathname: "/checklist/[id]",
                          params: {
                            id: String(c.id),
                            title: c.title,
                            projectId: project.id,
                          },
                        })
                      }
                      onLongPress={() => confirmDeleteChecklist(c.id, c.title)}
                      style={({ pressed }) => [
                        styles.checklistCard,
                        {
                          backgroundColor: colors.card,
                          borderColor: colors.border,
                          opacity: pressed ? 0.85 : 1,
                        },
                      ]}
                    >
                      <View style={{ flex: 1, gap: 4 }}>
                        <Text
                          style={[
                            styles.checklistTitle,
                            { color: colors.foreground },
                          ]}
                        >
                          {c.title}
                        </Text>
                        {c.templateTitle ? (
                          <Text
                            style={[
                              styles.checklistMeta,
                              { color: colors.mutedForeground },
                            ]}
                          >
                            From: {c.templateTitle}
                          </Text>
                        ) : null}
                      </View>
                      <Feather
                        name="chevron-right"
                        size={18}
                        color={colors.mutedForeground}
                      />
                    </Pressable>
                  );
                })}
                <Button
                  title="Generate with AI"
                  onPress={() => setShowGenerateModal(true)}
                />
                <Button
                  title="Apply template"
                  variant="secondary"
                  onPress={() => setShowChecklistModal(true)}
                />
                <Button
                  title="Create new"
                  variant="secondary"
                  onPress={() => setShowCreateChecklistPrompt(true)}
                />
              </View>
            )}
          </View>
        ) : null}

        {tab === "reports" ? (
          <View style={styles.body}>
            {reportsLoading && projectReports.length === 0 ? (
              <View style={{ paddingVertical: 32, alignItems: "center" }}>
                <ActivityIndicator color={colors.mutedForeground} />
              </View>
            ) : reportsError && projectReports.length === 0 ? (
              <View style={{ gap: 10 }}>
                <Text
                  style={{
                    color: colors.destructive,
                    fontFamily: "Inter_500Medium",
                    fontSize: 14,
                  }}
                >
                  {reportsError}
                </Text>
                <Button
                  title="Retry"
                  variant="secondary"
                  onPress={() => void refreshReports()}
                />
              </View>
            ) : projectReports.length === 0 ? (
              <EmptyState
                icon="file-text"
                title="No reports yet"
                description="Create a blank report or apply a template to get started. Templates are managed on the web."
                action={
                  <View style={{ gap: 8 }}>
                    <Button
                      title="Generate with AI"
                      onPress={() => setShowReportGenerateSheet(true)}
                    />
                    <Button
                      title="Apply template"
                      variant="secondary"
                      onPress={() => setShowReportModal(true)}
                    />
                    <Button
                      title="Create new"
                      variant="secondary"
                      onPress={() => setShowCreateReportPrompt(true)}
                    />
                  </View>
                }
              />
            ) : (
              <View style={{ gap: 12 }}>
                {projectReports.map((r) => (
                  <ReportListItem
                    key={String(r.id)}
                    report={r}
                    onPress={() =>
                      router.push({
                        pathname: "/report/[id]",
                        params: {
                          id: String(r.id),
                          projectId: project.id,
                        },
                      })
                    }
                  />
                ))}
                <Button
                  title="Generate with AI"
                  onPress={() => setShowReportGenerateSheet(true)}
                />
                <Button
                  title="Apply template"
                  variant="secondary"
                  onPress={() => setShowReportModal(true)}
                />
                <Button
                  title="Create new"
                  variant="secondary"
                  onPress={() => setShowCreateReportPrompt(true)}
                />
              </View>
            )}
          </View>
        ) : null}

        {tab === "files" ? (
          <View style={styles.body}>
            {filesLoading && projectFiles.length === 0 ? (
              <View style={{ paddingVertical: 32, alignItems: "center" }}>
                <ActivityIndicator color={colors.mutedForeground} />
              </View>
            ) : filesError && projectFiles.length === 0 ? (
              <View style={{ gap: 10 }}>
                <Text
                  style={{
                    color: colors.destructive,
                    fontFamily: "Inter_500Medium",
                    fontSize: 14,
                  }}
                >
                  {filesError}
                </Text>
                <Button
                  title="Retry"
                  variant="secondary"
                  onPress={() => void refreshFiles()}
                />
              </View>
            ) : projectFiles.length === 0 && uploadStatuses.length === 0 ? (
              <EmptyState
                icon="file"
                title="No files yet"
                description="Add plans, specs, or documents to keep them with this project."
                action={
                  <Button
                    title="Add Files"
                    onPress={() => void onAddFiles()}
                    disabled={uploadingFiles}
                  />
                }
              />
            ) : (
              <View style={{ gap: 12 }}>
                <Button
                  title={uploadingFiles ? "Uploading…" : "Add Files"}
                  onPress={() => void onAddFiles()}
                  disabled={uploadingFiles}
                />
                {uploadStatuses.map((u) => (
                  <View
                    key={u.id}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 12,
                      borderWidth: 1,
                      borderColor: colors.border,
                      borderStyle: "dashed",
                      borderRadius: 12,
                      padding: 12,
                    }}
                  >
                    {u.status === "uploading" || u.status === "pending" ? (
                      <ActivityIndicator
                        size="small"
                        color={colors.mutedForeground}
                      />
                    ) : (
                      <Feather
                        name={u.status === "done" ? "check-circle" : "x-circle"}
                        size={18}
                        color={
                          u.status === "done"
                            ? colors.success
                            : colors.destructive
                        }
                      />
                    )}
                    <Text
                      numberOfLines={1}
                      style={{
                        flex: 1,
                        color: colors.foreground,
                        fontFamily: "Inter_500Medium",
                        fontSize: 13,
                      }}
                    >
                      {u.name}
                    </Text>
                    <Text
                      style={{
                        color: colors.mutedForeground,
                        fontFamily: "Inter_400Regular",
                        fontSize: 12,
                      }}
                    >
                      {u.status === "pending"
                        ? "Waiting"
                        : u.status === "uploading"
                          ? "Uploading"
                          : u.status === "done"
                            ? "Done"
                            : "Failed"}
                    </Text>
                  </View>
                ))}
                {sortedFiles.map((f) => {
                  const downloading = downloadingFileId === String(f.id);
                  const sizeLabel = formatFileSize(f.sizeBytes);
                  const dateLabel = f.createdAt
                    ? new Date(f.createdAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })
                    : null;
                  return (
                    <Pressable
                      key={String(f.id)}
                      onPress={() => void openProjectFile(f)}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 12,
                        borderWidth: 1,
                        borderColor: colors.border,
                        borderRadius: 12,
                        padding: 12,
                        backgroundColor: colors.card,
                        opacity: downloading ? 0.7 : 1,
                      }}
                    >
                      <View
                        style={{
                          width: 40,
                          height: 40,
                          borderRadius: 10,
                          alignItems: "center",
                          justifyContent: "center",
                          backgroundColor: colors.muted,
                        }}
                      >
                        <Feather
                          name={fileIconName(f.mimeType)}
                          size={18}
                          color={colors.primary}
                        />
                      </View>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text
                          numberOfLines={1}
                          style={{
                            color: colors.foreground,
                            fontFamily: "Inter_600SemiBold",
                            fontSize: 14,
                          }}
                        >
                          {fileDisplayName(f)}
                        </Text>
                        <Text
                          numberOfLines={1}
                          style={{
                            color: colors.mutedForeground,
                            fontFamily: "Inter_400Regular",
                            fontSize: 12,
                          }}
                        >
                          {[f.uploadedByName, dateLabel, sizeLabel]
                            .filter(Boolean)
                            .join(" · ")}
                        </Text>
                      </View>
                      {downloading ? (
                        <ActivityIndicator
                          size="small"
                          color={colors.mutedForeground}
                        />
                      ) : (
                        <Pressable
                          onPress={(e) => {
                            // RN Web propagates presses to the parent
                            // row Pressable — without this, tapping
                            // Share would ALSO open the viewer.
                            e.stopPropagation();
                            void shareProjectFile(f);
                          }}
                          disabled={downloadingFileId != null}
                          hitSlop={10}
                          style={{ padding: 6 }}
                          accessibilityLabel={`Share ${fileDisplayName(f)}`}
                        >
                          <Feather
                            name="share"
                            size={18}
                            color={colors.mutedForeground}
                          />
                        </Pressable>
                      )}
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
        ) : null}

        {tab === "team" ? (
          <View style={styles.body}>
            {assignmentsLoading && assignments.length === 0 ? (
              <View style={{ paddingVertical: 32, alignItems: "center" }}>
                <ActivityIndicator color={colors.mutedForeground} />
              </View>
            ) : assignmentsError ? (
              <View style={{ gap: 10 }}>
                <Text
                  style={{
                    color: colors.destructive,
                    fontFamily: "Inter_500Medium",
                    fontSize: 14,
                  }}
                >
                  {assignmentsError}
                </Text>
                <Button
                  title="Retry"
                  variant="secondary"
                  onPress={() => void refreshAssignments()}
                />
              </View>
            ) : assignments.length === 0 ? (
              <EmptyState
                icon="users"
                title="No team members assigned to this project yet."
                description={
                  isAdmin
                    ? "Tap 'Add user' to assign existing teammates."
                    : "Ask your admin to add teammates."
                }
                action={
                  isAdmin ? (
                    <Button
                      title="Add user"
                      icon={
                        <Feather
                          name="user-plus"
                          size={14}
                          color={colors.primaryForeground}
                        />
                      }
                      onPress={() => setShowAssignUserModal(true)}
                    />
                  ) : undefined
                }
              />
            ) : (
              <View style={{ gap: 10 }}>
                <Text
                  style={{
                    color: colors.mutedForeground,
                    fontSize: 12,
                    fontFamily: "Inter_500Medium",
                    textTransform: "uppercase",
                    letterSpacing: 1,
                    marginBottom: 2,
                  }}
                >
                  Has access ({assignments.length})
                </Text>
                {assignments.map((m) => {
                  const fullName =
                    `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim() ||
                    m.email;
                  const initials =
                    `${(m.firstName ?? "")[0] ?? ""}${(m.lastName ?? "")[0] ?? ""}`.toUpperCase() ||
                    (m.email[0]?.toUpperCase() ?? "?");
                  return (
                    <View
                      key={String(m.id)}
                      style={[
                        styles.memberCard,
                        {
                          backgroundColor: colors.card,
                          borderColor: colors.border,
                        },
                      ]}
                    >
                      <View
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 18,
                          backgroundColor: colors.muted,
                          alignItems: "center",
                          justifyContent: "center",
                          marginRight: 10,
                        }}
                      >
                        <Text
                          style={{
                            color: colors.foreground,
                            fontFamily: "Inter_700Bold",
                            fontSize: 13,
                          }}
                        >
                          {initials}
                        </Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text
                          style={[
                            styles.memberName,
                            { color: colors.foreground },
                          ]}
                          numberOfLines={1}
                        >
                          {fullName}
                        </Text>
                        <Text
                          style={[
                            styles.memberSub,
                            { color: colors.mutedForeground },
                          ]}
                          numberOfLines={1}
                        >
                          {m.email} · {m.role}
                        </Text>
                      </View>
                      {isAdmin && m.userId !== currentUser?.id ? (
                        <Pressable
                          onPress={() => removeMember(m)}
                          hitSlop={10}
                          accessibilityLabel={`Remove ${fullName} from project`}
                        >
                          <Feather
                            name="x"
                            size={18}
                            color={colors.mutedForeground}
                          />
                        </Pressable>
                      ) : null}
                    </View>
                  );
                })}
                {isAdmin ? (
                  <Button
                    title="Add user"
                    variant="secondary"
                    icon={
                      <Feather
                        name="user-plus"
                        size={14}
                        color={colors.foreground}
                      />
                    }
                    onPress={() => setShowAssignUserModal(true)}
                  />
                ) : null}
              </View>
            )}
            {/* Contacts — component self-gates to admin/manager (renders
                nothing and fires no request otherwise). */}
            <ProjectContactsSection projectId={project.id} />
          </View>
        ) : null}
      </ScrollView>
      )}

      {/* Task photos sheet — attach/detach existing project photos */}

      <TaskModal
        visible={showTaskModal}
        projectId={project.id}
        onClose={() => setShowTaskModal(false)}
        onSubmit={async ({ title, notes, assignee, dueDate, requiredPhotoCount }) => {
          try {
            await createTask(project.id, {
              title,
              description: notes,
              assignedToId: assignee?.userId ?? null,
              assignedToName: assignee?.displayName,
              dueDate: dueDate ?? undefined,
              requiredPhotoCount,
            });
            setShowTaskModal(false);
          } catch (e) {
            showToast(
              e instanceof Error ? e.message : "Couldn't create task.",
            );
            throw e;
          }
        }}
      />
      <ChecklistGenerateSheet
        visible={showGenerateModal}
        onClose={() => setShowGenerateModal(false)}
        projectId={project.id}
        onCreated={(checklistId) => {
          void refreshChecklists();
          router.push({
            pathname: "/checklist/[id]",
            params: { id: String(checklistId), projectId: project.id },
          });
        }}
      />
      <TemplatePickerModal
        visible={showChecklistModal}
        onClose={() => setShowChecklistModal(false)}
        onPick={async (template) => {
          try {
            const created = await applyTemplate(template.id, template.title);
            showToast(`Applied "${created.title}".`);
          } catch (e) {
            showToast(
              e instanceof Error ? e.message : "Couldn't apply template.",
            );
            throw e;
          }
        }}
      />
      <TitlePromptModal
        visible={showCreateChecklistPrompt}
        heading="New checklist"
        placeholder="Checklist title"
        submitLabel="Create"
        busyLabel="Creating…"
        onClose={() => setShowCreateChecklistPrompt(false)}
        onSubmit={async (title) => {
          // Throwing keeps the prompt open with the message inline.
          const created = await api.createChecklist(project.id, title);
          setShowCreateChecklistPrompt(false);
          void refreshChecklists();
          router.push({
            pathname: "/checklist/[id]",
            params: {
              id: String(created.id),
              title: created.title,
              projectId: project.id,
            },
          });
        }}
      />
      <TitlePromptModal
        visible={showCreateReportPrompt}
        heading="New report"
        placeholder="Report title"
        submitLabel="Create"
        busyLabel="Creating…"
        onClose={() => setShowCreateReportPrompt(false)}
        onSubmit={async (title) => {
          const created = await createReport({ title });
          setShowCreateReportPrompt(false);
          showToast(`Created "${created.title}".`);
          router.push({
            pathname: "/report/[id]",
            params: { id: String(created.id), projectId: project.id },
          });
        }}
      />
      <GenerateReportSheet
        visible={showReportGenerateSheet}
        projectId={project.id}
        onClose={() => setShowReportGenerateSheet(false)}
        onCreated={(reportId, excludedCount) => {
          setShowReportGenerateSheet(false);
          void refreshReports();
          showToast(
            excludedCount > 0
              ? `Report generated — ${excludedCount} photo${excludedCount === 1 ? "" : "s"} couldn't be used.`
              : "Report generated.",
          );
          router.push({
            pathname: "/report/[id]",
            params: { id: String(reportId), projectId: project.id },
          });
        }}
      />
      <ApplyReportTemplateModal
        visible={showReportModal}
        onClose={() => setShowReportModal(false)}
        onCreate={async (input) => {
          try {
            const created = await createReport(input);
            showToast(
              input.templateId
                ? `Created "${created.title}" from template.`
                : `Created "${created.title}".`,
            );
            // Jump straight into the new report so the user can start
            // editing immediately.
            router.push({
              pathname: "/report/[id]",
              params: {
                id: String(created.id),
                projectId: project.id,
              },
            });
          } catch (e) {
            showToast(
              e instanceof Error ? e.message : "Couldn't create report.",
            );
            throw e;
          }
        }}
      />
      <AssignUserToProjectModal
        visible={showAssignUserModal}
        projectId={project.id}
        currentlyAssignedUserIds={assignments.map((a) => a.userId)}
        currentUserId={currentUser?.id}
        onClose={() => setShowAssignUserModal(false)}
        onAssigned={() => {
          void refreshAssignments();
        }}
      />
      {/* Floating action cluster (CompanyCam pattern): camera center,
          messages left, AI right — each in a primary-filled circle (same
          treatment as the camera FAB, smaller proportions). Hidden in
          select mode (the floating selection bar owns the bottom edge). */}
      {!selectMode ? (
        <View
          pointerEvents="box-none"
          style={[styles.fabCluster, { bottom: insets.bottom + 16 }]}
        >
          <Pressable
            onPress={() => setMessagesSheetOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Open project messages"
            style={({ pressed }) => [
              styles.fabSide,
              {
                backgroundColor: colors.primary,
                opacity: pressed ? 0.9 : 1,
              },
            ]}
          >
            <Feather
              name="message-circle"
              size={22}
              color={colors.primaryForeground}
            />
            {messagesUnread > 0 ? (
              <View
                style={[
                  styles.fabBadge,
                  {
                    backgroundColor: colors.card,
                    borderColor: colors.border,
                  },
                ]}
              >
                <Text
                  style={[styles.fabBadgeText, { color: colors.foreground }]}
                >
                  {messagesUnread > 99 ? "99+" : messagesUnread}
                </Text>
              </View>
            ) : null}
          </Pressable>
          <Pressable
            onPress={() =>
              router.push({
                pathname: "/capture",
                params: { projectId: project.id },
              })
            }
            accessibilityRole="button"
            accessibilityLabel="Take photo"
            style={({ pressed }) => [
              styles.fabCamera,
              {
                backgroundColor: colors.primary,
                opacity: pressed ? 0.9 : 1,
              },
            ]}
          >
            <Feather
              name="camera"
              size={28}
              color={colors.primaryForeground}
            />
          </Pressable>
          <Pressable
            onPress={() => setAiSheetOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Open AI actions"
            style={({ pressed }) => [
              styles.fabSide,
              {
                backgroundColor: colors.primary,
                opacity: pressed ? 0.9 : 1,
              },
            ]}
          >
            <Feather name="zap" size={22} color={colors.primaryForeground} />
          </Pressable>
        </View>
      ) : null}
      <ProjectMessagesSheet
        visible={messagesSheetOpen}
        projectId={project.id}
        onClose={() => setMessagesSheetOpen(false)}
        onReadMarked={() => setMessagesUnread(0)}
      />
      <AiActionsSheet
        visible={aiSheetOpen}
        onClose={() => setAiSheetOpen(false)}
        onWalkthrough={() => {
          setAiSheetOpen(false);
          router.push({
            pathname: "/capture",
            params: { projectId: project.id, mode: "walkthru" },
          });
        }}
        onGenerateReport={() => {
          setAiSheetOpen(false);
          setShowReportGenerateSheet(true);
        }}
      />
      {/* Floating selection bar: pinned above the bottom safe area (this
          screen is a stack route — FloatingTabBar only renders inside the
          (tabs) layout, so there's no tab bar to stack above here). Shown
          while selection mode is armed or anything is selected. */}
      {selectMode && tab === "photos" ? (
        <View
          style={[
            styles.selectionBarFloating,
            {
              bottom: insets.bottom + 12,
              backgroundColor: colors.card,
              borderColor: colors.border,
            },
          ]}
        >
          <Pressable onPress={exitSelectMode} hitSlop={6}>
            <Text
              style={{
                color: colors.mutedForeground,
                fontFamily: "Inter_600SemiBold",
                fontSize: 14,
              }}
            >
              Cancel
            </Text>
          </Pressable>
          <Text
            style={{
              color: colors.foreground,
              fontFamily: "Inter_600SemiBold",
              fontSize: 14,
            }}
          >
            {selected.size} selected
          </Text>
          <Pressable
            onPress={openShareChoice}
            hitSlop={6}
            disabled={sharingSelection || selected.size === 0}
            accessibilityRole="button"
            accessibilityLabel="Share selected photos"
            accessibilityState={{
              disabled: sharingSelection || selected.size === 0,
              busy: sharingSelection,
            }}
          >
            {sharingSelection ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text
                style={{
                  color: colors.primary,
                  fontFamily: "Inter_700Bold",
                  fontSize: 14,
                  opacity: selected.size === 0 ? 0.4 : 1,
                }}
              >
                Share
              </Text>
            )}
          </Pressable>
          <Pressable
            onPress={deleteSelected}
            hitSlop={6}
            disabled={selected.size === 0}
          >
            <Text
              style={{
                color: colors.destructive,
                fontFamily: "Inter_700Bold",
                fontSize: 14,
                opacity: selected.size === 0 ? 0.4 : 1,
              }}
            >
              Delete
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* Snapshot vs Live gallery share choice. Defaults to Snapshot;
          Create link fires the POST with the chosen mode. */}
      <Modal
        visible={shareChoiceVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setShareChoiceVisible(false)}
      >
        <Pressable
          style={styles.shareChoiceBackdrop}
          onPress={() => setShareChoiceVisible(false)}
        >
          <Pressable
            style={[
              styles.shareChoiceSheet,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
            onPress={() => {}}
          >
            <Text
              style={{
                color: colors.foreground,
                fontFamily: "Inter_700Bold",
                fontSize: 16,
              }}
            >
              Share gallery link
            </Text>
            {(
              [
                {
                  live: false,
                  title: "Snapshot",
                  desc: "Just the selected photos, frozen as they are now.",
                },
                {
                  live: true,
                  title: "Live",
                  desc: "All project photos, newest first — the link updates as photos are added.",
                },
              ] as const
            ).map((opt) => {
              const active = shareIsLive === opt.live;
              return (
                <Pressable
                  key={opt.title}
                  onPress={() => setShareIsLive(opt.live)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  style={[
                    styles.shareChoiceOption,
                    {
                      borderColor: active ? colors.primary : colors.border,
                      backgroundColor: colors.background,
                    },
                  ]}
                >
                  <Feather
                    name={active ? "check-circle" : "circle"}
                    size={18}
                    color={active ? colors.primary : colors.mutedForeground}
                  />
                  <View style={{ flex: 1 }}>
                    <Text
                      style={{
                        color: colors.foreground,
                        fontFamily: "Inter_600SemiBold",
                        fontSize: 14,
                      }}
                    >
                      {opt.title}
                    </Text>
                    <Text
                      style={{
                        color: colors.mutedForeground,
                        fontSize: 12,
                        lineHeight: 16,
                      }}
                    >
                      {opt.desc}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
            <Button
              title="Create link"
              onPress={() => {
                setShareChoiceVisible(false);
                void onShareSelected(shareIsLive);
              }}
            />
          </Pressable>
        </Pressable>
      </Modal>

      {/* Top-right kebab overflow menu. Lightweight Modal-as-popover
          (matches the rest of this screen's modal patterns). */}
      <Modal
        visible={showProjectMenu}
        transparent
        animationType="fade"
        onRequestClose={() => setShowProjectMenu(false)}
      >
        <Pressable
          style={styles.menuBackdrop}
          onPress={() => setShowProjectMenu(false)}
        >
          <Pressable
            style={[
              styles.menuSheet,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
                top: insets.top + 56,
              },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <Pressable
              onPress={() => {
                setShowProjectMenu(false);
                void onShareProject();
              }}
              disabled={sharingProject}
              accessibilityRole="button"
              accessibilityLabel="Share project link"
              accessibilityState={{
                disabled: sharingProject,
                busy: sharingProject,
              }}
              style={({ pressed }) => [
                styles.menuItem,
                { opacity: sharingProject ? 0.5 : pressed ? 0.6 : 1 },
              ]}
            >
              {sharingProject ? (
                <ActivityIndicator size="small" color={colors.foreground} />
              ) : (
                <Feather name="share-2" size={16} color={colors.foreground} />
              )}
              <Text style={[styles.menuItemTxt, { color: colors.foreground }]}>
                Share project link
              </Text>
            </Pressable>
            {currentUser?.role !== "restricted" ? (
              <Pressable
                onPress={() => {
                  setShowProjectMenu(false);
                  onDelete();
                }}
                style={({ pressed }) => [
                  styles.menuItem,
                  { opacity: pressed ? 0.6 : 1 },
                ]}
              >
                <Feather name="trash-2" size={16} color={colors.destructive} />
                <Text
                  style={[styles.menuItemTxt, { color: colors.destructive }]}
                >
                  Delete project
                </Text>
              </Pressable>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

/**
 * Toast copy for a failed share-link mint. ApiError status 0 is the
 * api layer's "request never reached the server" marker (offline,
 * DNS, timeout) — call that out specifically; everything else keeps
 * the generic message.
 */
function shareLinkFailureMessage(e: unknown): string {
  if (e instanceof ApiError && e.status === 0) {
    return "Couldn't generate link — you're offline. Try again when you have service.";
  }
  return "Couldn't generate share link";
}

function showFailedUploadActionSheet(
  uploadQueueId: string,
  onRemoveLocalPhoto: () => void,
  queueItem: QueuedUpload | null,
) {
  const classification = queueItem
    ? classifyUploadFailure(queueItem)
    : "network";
  const unrecoverable = classification === "unrecoverable";
  const title = unrecoverable ? "Photo can't be uploaded" : "Upload failed";
  const message = unrecoverable
    ? "The photo file is no longer on this device, so it can't be retried."
    : classification === "auth"
      ? "We couldn't verify your session. It will retry automatically once you're signed in again."
      : "This usually means a connection problem. It will retry automatically — or retry now.";
  const confirmRemove = () => {
    Alert.alert(
      "Remove this photo?",
      "It hasn't been uploaded yet and will be lost.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          // deletePhoto (passed via onRemoveLocalPhoto) also clears the queue
          // item, so we don't need a separate removeUploadQueueItem call here.
          onPress: onRemoveLocalPhoto,
        },
      ],
    );
  };
  if (Platform.OS === "ios") {
    // Unrecoverable items get no "Retry now" — the local file is gone and
    // a retry is guaranteed to fail.
    const options = unrecoverable
      ? ["Cancel", "Remove from queue"]
      : ["Cancel", "Retry now", "Remove from queue"];
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        message,
        options,
        cancelButtonIndex: 0,
        destructiveButtonIndex: options.length - 1,
      },
      (idx) => {
        if (unrecoverable) {
          if (idx === 1) confirmRemove();
          return;
        }
        if (idx === 1) {
          void retryUploadQueueItem(uploadQueueId);
        } else if (idx === 2) {
          confirmRemove();
        }
      },
    );
  } else {
    const buttons = unrecoverable
      ? [
          {
            text: "Remove from queue",
            style: "destructive" as const,
            onPress: confirmRemove,
          },
          { text: "Cancel", style: "cancel" as const },
        ]
      : [
          {
            text: "Retry now",
            onPress: () => {
              void retryUploadQueueItem(uploadQueueId);
            },
          },
          {
            text: "Remove from queue",
            style: "destructive" as const,
            onPress: confirmRemove,
          },
          { text: "Cancel", style: "cancel" as const },
        ];
    Alert.alert(title, message, buttons);
  }
}

function PhotoTile({
  photo,
  borderColor,
  selectMode,
  selected,
  primary,
  primaryForeground,
  onOpen,
  onToggleSelected,
  onDelete,
  onRemoveLocal,
}: {
  photo: import("@/services/types").Photo;
  borderColor: string;
  selectMode: boolean;
  selected: boolean;
  primary: string;
  primaryForeground: string;
  onOpen: () => void;
  onToggleSelected: () => void;
  /**
   * Full delete flow including refs check + server DELETE. Parent owns
   * the confirmation dialog (so it can show the refs-aware copy), so
   * PhotoTile invokes this without any inline Alert of its own.
   */
  onDelete: () => void;
  /**
   * Local-only cleanup used by the failed-upload action sheet. No
   * server call, no refs check — the photo never made it to the server,
   * so there's nothing to delete server-side. The failed-upload sheet
   * already presents its own confirm dialog.
   */
  onRemoveLocal: () => void;
}) {
  // Suppress the onPress that fires when a long-press releases.
  const longPressed = useRef(false);

  const queueItem = useUploadStatus(photo.uploadQueueId);
  // "unrecoverable" renders with the failed badge too — the tap-through
  // action sheet is what differentiates it (no Retry, explains the file
  // is gone).
  const uploadStatus: "uploading" | "failed" | null = !queueItem
    ? null
    : queueItem.status === "failed" || queueItem.status === "unrecoverable"
      ? "failed"
      : queueItem.status === "pending" || queueItem.status === "uploading"
        ? "uploading"
        : null;

  // On-device video poster: generate the first-frame thumbnail ONCE per
  // tile (keyed by this PhotoTile instance + the source uri). time:100ms
  // avoids the common all-black frame-0. On failure (or while generating)
  // we fall back to the grey videoTile placeholder — never block the grid,
  // never crash. Non-video tiles skip this entirely.
  const [videoPoster, setVideoPoster] = useState<string | null>(null);
  useEffect(() => {
    if (!photo.isVideo || !photo.uri) return;
    let cancelled = false;
    (async () => {
      try {
        const { uri } = await VideoThumbnails.getThumbnailAsync(photo.uri, {
          time: 100,
        });
        if (!cancelled) setVideoPoster(uri);
      } catch {
        // Keep the grey placeholder; generation failures are non-fatal.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [photo.isVideo, photo.uri]);

  const handleLongPress = () => {
    if (selectMode) return;
    longPressed.current = true;
    // No inline Alert — parent's onDelete owns the confirmation dialog
    // because it needs to fetch references first and show refs-aware
    // copy ("This photo is in N reports …"). Web and native go through
    // the same path now.
    onDelete();
  };

  const handlePress = () => {
    if (longPressed.current) {
      longPressed.current = false;
      return;
    }
    if (selectMode) {
      onToggleSelected();
      return;
    }
    if (uploadStatus === "failed" && photo.uploadQueueId) {
      // Failed-upload "Remove" path: never went to the server, so do
      // local-only cleanup (no refs check, no server DELETE). The
      // action sheet itself handles its own confirmation copy.
      showFailedUploadActionSheet(photo.uploadQueueId, onRemoveLocal, queueItem);
      return;
    }
    // Uploading photos still open the detail screen — they're viewable
    // immediately because the local file is already there.
    onOpen();
  };

  const accessibilityLabel = selectMode
    ? `Photo. ${selected ? "Selected" : "Not selected"}. Tap to toggle.`
    : uploadStatus === "uploading"
      ? "Photo. Uploading. Tap to open, long press to delete."
      : uploadStatus === "failed"
        ? "Photo. Upload failed. Tap to retry or remove."
        : "Photo. Tap to open, long press to delete.";

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={selectMode ? "checkbox" : "imagebutton"}
      accessibilityState={selectMode ? { checked: selected } : undefined}
      onPress={handlePress}
      onLongPress={handleLongPress}
      delayLongPress={350}
      style={[
        styles.photoTile,
        {
          borderColor: selectMode && selected ? primary : borderColor,
          borderWidth: selectMode && selected ? 3 : 1,
          // Rows own sizing: flex tiles + a fixed `gap` give identical
          // 12pt gutters at every screen width (no percentage rounding).
          flex: 1,
        },
      ]}
    >
      {photo.isVideo ? (
        // Video tile: never hand a video URL to <Image>. Render the
        // on-device-generated first-frame poster when ready, else the
        // neutral grey placeholder. The play badge sits on top in both
        // cases so videos stay visually distinct from stills.
        <View style={[styles.photo, styles.videoTile]}>
          {videoPoster ? (
            <Image
              source={{ uri: videoPoster }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              transition={120}
            />
          ) : null}
          <View style={styles.videoPlayBadge}>
            <Feather name="play" size={18} color="#fff" />
          </View>
        </View>
      ) : (
        // Bounded decode (memory fix): the grid NEVER hands expo-image
        // the original — ThumbImage renders a ~400px cached thumbnail
        // (grey placeholder until ready, original only if generation
        // fails). recyclingKey inside lets FlashList recycle without
        // re-decoding.
        <View style={[styles.photo, styles.tilePlaceholder]}>
          <ThumbImage
            cacheKey={photo.id}
            uri={photo.thumbUrl ?? photo.uri}
            style={StyleSheet.absoluteFill as never}
          />
        </View>
      )}
      {photo.annotations && photo.annotations.length > 0 ? (
        <AnnotationOverlay strokes={photo.annotations} />
      ) : null}
      {uploadStatus === "uploading" ? (
        <View pointerEvents="none" style={styles.uploadingDim} />
      ) : null}
      {selectMode ? (
        <View
          style={[
            styles.selectMark,
            {
              backgroundColor: selected ? primary : "rgba(255,255,255,0.85)",
              borderColor: selected ? primary : "rgba(0,0,0,0.2)",
            },
          ]}
        >
          {selected ? (
            <Feather name="check" size={12} color={primaryForeground} />
          ) : null}
        </View>
      ) : null}
      {photo.latitude != null ? (
        <View style={styles.photoBadge}>
          <Feather name="map-pin" size={10} color="#fff" />
        </View>
      ) : null}
      {photo.annotations && photo.annotations.length > 0 ? (
        <View style={[styles.photoBadge, { right: 6, left: undefined }]}>
          <Feather name="edit-2" size={10} color="#fff" />
        </View>
      ) : null}
      {uploadStatus === "uploading" ? (
        <View style={styles.uploadingBadge}>
          <ActivityIndicator size="small" color="#fff" />
        </View>
      ) : null}
      {uploadStatus === "failed" ? (
        <View style={styles.failedBadge}>
          <Feather name="alert-triangle" size={12} color="#fff" />
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * Cap on strokes rendered per THUMBNAIL. On a ~120px tile anything past
 * a few dozen strokes is visually indistinct mush; the cap bounds SVG
 * node count on grids with pathological photos (first N strokes win —
 * matches web's paint order, oldest underneath). Full-screen view has
 * no cap.
 */
const MAX_THUMB_STROKES = 60;

function AnnotationOverlay({
  strokes,
}: {
  strokes: import("@/services/types").StoredStroke[];
}) {
  // Thumbnail overlay — WEB-PARITY basis, verified against the prod web
  // bundle's grid tile (data-testid="annotation-overlay"): the web grid
  // cover-crops the <img> but renders the overlay with viewBox
  // "0 0 1000 1000" and preserveAspectRatio="none" and NO aspect input —
  // i.e. it STRETCHES the normalized unit square onto the tile box.
  // Strokes are never clipped, but they are not crop-compensated either.
  // We deliberately reproduce that (stretch, not slice) so a stroke near
  // a photo's edge appears in both grids at the same tile position —
  // matching web beats matching the photo pixels here. Full-screen view
  // keeps the exact fitted-rect basis. Text renders here too (web-parity
  // after web's thumbnail-text fix): fontSize resolves inside the shared
  // strokeToRenderShape switch (fontSizeNorm scheme — one rule on every
  // surface), here against the 1000-unit basis height.
  const shapes = useMemo(
    () =>
      strokes
        .slice(0, MAX_THUMB_STROKES)
        .map((s, i) => ({
          shape: strokeToRenderShape(s, 1000, 1000),
          key: s.id ?? `i${i}`,
        }))
        .filter(
          (x): x is { shape: RenderShape; key: string } => x.shape !== null,
        ),
    [strokes],
  );
  if (shapes.length === 0) return null;
  return (
    <Svg
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      viewBox="0 0 1000 1000"
      preserveAspectRatio="none"
    >
      {shapes.map(({ shape, key }) => renderShape(shape, key))}
    </Svg>
  );
}

function PhotosToolbar({
  selectMode,
  onToggleSelect,
  filterActive,
  onOpenFilter,
  addingFromLibrary,
  onAddFromLibrary,
  colors,
}: {
  selectMode: boolean;
  onToggleSelect: () => void;
  filterActive: boolean;
  onOpenFilter: () => void;
  addingFromLibrary: boolean;
  onAddFromLibrary: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
      <View
        style={[
          styles.gridSegment,
          { backgroundColor: colors.muted, borderColor: colors.border },
        ]}
      >
        <Pressable
          onPress={onToggleSelect}
          accessibilityRole="button"
          accessibilityLabel={
            selectMode ? "Exit selection mode" : "Select photos"
          }
          accessibilityState={{ selected: selectMode }}
          style={[
            styles.gridBtn,
            {
              backgroundColor: selectMode
                ? colors.background
                : "transparent",
            },
          ]}
        >
          <Feather
            name="check-square"
            size={16}
            color={selectMode ? colors.primary : colors.mutedForeground}
          />
        </Pressable>
        <Pressable
          onPress={onOpenFilter}
          accessibilityRole="button"
          accessibilityLabel={
            filterActive ? "Filter photos (filters active)" : "Filter photos"
          }
          accessibilityState={{ selected: filterActive }}
          style={styles.gridBtn}
        >
          <Feather
            name="filter"
            size={16}
            color={filterActive ? colors.primary : colors.mutedForeground}
          />
          {filterActive ? (
            <View
              style={[styles.filterBadge, { backgroundColor: colors.primary }]}
            />
          ) : null}
        </Pressable>
        <Pressable
          onPress={onAddFromLibrary}
          disabled={addingFromLibrary}
          accessibilityRole="button"
          accessibilityLabel="Add photos from camera roll"
          accessibilityState={{ disabled: addingFromLibrary, busy: addingFromLibrary }}
          style={styles.gridBtn}
        >
          {addingFromLibrary ? (
            <ActivityIndicator size="small" color={colors.mutedForeground} />
          ) : (
            <Feather name="plus" size={16} color={colors.mutedForeground} />
          )}
        </Pressable>
      </View>
  );
}

/**
 * Bottom-sheet filter panel for the Photos tab. Works on a DRAFT copy of
 * the filters: nothing applies until Apply is tapped; Clear all resets the
 * draft to defaults (still requires Apply — predictable, no surprise
 * re-renders behind the sheet).
 *
 * Date semantics (calendar): first tap = single day; second tap on a
 * different day = inclusive range (auto-ordered); tapping the single
 * selected day again = deselect; tapping with a full range set = start a
 * new single day.
 */
function FilterSheet({
  visible,
  filters,
  allTags,
  allUsers,
  onApply,
  onClose,
  colors,
}: {
  visible: boolean;
  filters: GalleryFilters;
  allTags: string[];
  allUsers: { id: string; label: string }[];
  onApply: (next: GalleryFilters) => void;
  onClose: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<GalleryFilters>(filters);

  // Re-seed the draft from the applied filters each time the sheet opens.
  useEffect(() => {
    if (visible) setDraft(filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const onDayPress = (day: DateData) => {
    setDraft((d) => {
      const tapped = day.dateString;
      if (!d.dateStart || (d.dateStart && d.dateEnd)) {
        // Nothing selected, or a full range — start a new single day.
        return { ...d, dateStart: tapped, dateEnd: null };
      }
      if (tapped === d.dateStart) {
        // Tapping the lone selected day deselects it.
        return { ...d, dateStart: null, dateEnd: null };
      }
      // Second tap: inclusive range, auto-ordered.
      const [start, end] =
        tapped < d.dateStart ? [tapped, d.dateStart] : [d.dateStart, tapped];
      return { ...d, dateStart: start, dateEnd: end };
    });
  };

  // Period markings for the calendar (start/end caps + filled middle days).
  const markedDates = useMemo(() => {
    const marks: Record<
      string,
      {
        startingDay?: boolean;
        endingDay?: boolean;
        color: string;
        textColor: string;
      }
    > = {};
    if (!draft.dateStart) return marks;
    const start = draft.dateStart;
    const end = draft.dateEnd ?? draft.dateStart;
    const cur = new Date(`${start}T00:00:00`);
    const last = new Date(`${end}T00:00:00`);
    // Bounded walk (range can't exceed a project's lifetime; cap defensively).
    for (let i = 0; i < 1000 && cur <= last; i++) {
      const key = toDayString(cur.toISOString());
      marks[key] = {
        color: colors.primary,
        textColor: colors.primaryForeground,
        ...(key === start ? { startingDay: true } : {}),
        ...(key === end ? { endingDay: true } : {}),
      };
      cur.setDate(cur.getDate() + 1);
    }
    return marks;
  }, [draft.dateStart, draft.dateEnd, colors.primary, colors.primaryForeground]);

  const segment = (
    label: string,
    options: { value: string; label: string }[],
    current: string,
    onPick: (v: string) => void,
  ) => (
    <View style={{ gap: 8 }}>
      <Text style={[styles.filterSectionLabel, { color: colors.mutedForeground }]}>
        {label}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {options.map((o) => {
          const active = current === o.value;
          return (
            <Pressable
              key={o.value}
              onPress={() => onPick(o.value)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[
                styles.filterChip,
                {
                  backgroundColor: active ? colors.primary : colors.muted,
                  borderColor: active ? colors.primary : colors.border,
                },
              ]}
            >
              <Text
                style={{
                  fontFamily: active ? "Inter_600SemiBold" : "Inter_500Medium",
                  fontSize: 13,
                  color: active ? colors.primaryForeground : colors.foreground,
                }}
              >
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <Pressable style={styles.sheetBackdrop} onPress={onClose} />
      <View
        style={[
          styles.filterSheet,
          {
            backgroundColor: colors.card,
            paddingBottom: insets.bottom + 12,
          },
        ]}
      >
        <View style={styles.sheetHandleRow}>
          <View style={[styles.sheetHandle, { backgroundColor: colors.border }]} />
        </View>
        <View style={styles.filterHeaderRow}>
          <Text style={[styles.filterTitle, { color: colors.foreground }]}>
            Filters
          </Text>
          <Pressable
            onPress={() => setDraft(DEFAULT_FILTERS)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Clear all filters"
          >
            <Text
              style={{
                color: colors.primary,
                fontFamily: "Inter_600SemiBold",
                fontSize: 14,
              }}
            >
              Clear all
            </Text>
          </Pressable>
        </View>

        <ScrollView
          style={{ flexGrow: 0 }}
          contentContainerStyle={{ gap: 18, paddingHorizontal: 16, paddingBottom: 8 }}
          showsVerticalScrollIndicator={false}
        >
          {segment(
            "SORT",
            [
              { value: "newest", label: "Newest first" },
              { value: "oldest", label: "Oldest first" },
            ],
            draft.sort,
            (v) => setDraft((d) => ({ ...d, sort: v as GalleryFilters["sort"] })),
          )}
          {segment(
            "TYPE",
            [
              { value: "all", label: "All" },
              { value: "photos", label: "Photos" },
              { value: "videos", label: "Videos" },
            ],
            draft.type,
            (v) => setDraft((d) => ({ ...d, type: v as GalleryFilters["type"] })),
          )}

          <View style={{ gap: 8 }}>
            <Text
              style={[styles.filterSectionLabel, { color: colors.mutedForeground }]}
            >
              DATE
            </Text>
            <Calendar
              onDayPress={onDayPress}
              markingType="period"
              markedDates={markedDates}
              theme={{
                calendarBackground: "transparent",
                dayTextColor: colors.foreground,
                monthTextColor: colors.foreground,
                textSectionTitleColor: colors.mutedForeground,
                arrowColor: colors.primary,
                todayTextColor: colors.primary,
                textDisabledColor: colors.mutedForeground,
              }}
              style={{ borderRadius: 12 }}
            />
          </View>

          {allTags.length > 0 ? (
            <View style={{ gap: 8 }}>
              <Text
                style={[
                  styles.filterSectionLabel,
                  { color: colors.mutedForeground },
                ]}
              >
                TAGS
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {allTags.map((t) => {
                  const active = draft.tags.includes(t);
                  return (
                    <Pressable
                      key={t}
                      onPress={() =>
                        setDraft((d) => ({
                          ...d,
                          tags: active
                            ? d.tags.filter((x) => x !== t)
                            : [...d.tags, t],
                        }))
                      }
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      style={[
                        styles.filterChip,
                        {
                          backgroundColor: active
                            ? colors.primary
                            : colors.muted,
                          borderColor: active ? colors.primary : colors.border,
                        },
                      ]}
                    >
                      <Text
                        style={{
                          fontFamily: active
                            ? "Inter_600SemiBold"
                            : "Inter_500Medium",
                          fontSize: 13,
                          color: active
                            ? colors.primaryForeground
                            : colors.foreground,
                        }}
                      >
                        {t}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}

          {allUsers.length > 0 ? (
            <View style={{ gap: 8 }}>
              <Text
                style={[
                  styles.filterSectionLabel,
                  { color: colors.mutedForeground },
                ]}
              >
                USERS
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {allUsers.map((u) => {
                  const active = draft.users.includes(u.id);
                  return (
                    <Pressable
                      key={u.id}
                      onPress={() =>
                        setDraft((d) => ({
                          ...d,
                          users: active
                            ? d.users.filter((x) => x !== u.id)
                            : [...d.users, u.id],
                        }))
                      }
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      style={[
                        styles.filterChip,
                        {
                          backgroundColor: active
                            ? colors.primary
                            : colors.muted,
                          borderColor: active ? colors.primary : colors.border,
                        },
                      ]}
                    >
                      <Text
                        style={{
                          fontFamily: active
                            ? "Inter_600SemiBold"
                            : "Inter_500Medium",
                          fontSize: 13,
                          color: active
                            ? colors.primaryForeground
                            : colors.foreground,
                        }}
                      >
                        {u.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}
        </ScrollView>

        <View style={{ paddingHorizontal: 16, paddingTop: 10 }}>
          <Button title="Apply" onPress={() => onApply(draft)} />
        </View>
      </View>
    </Modal>
  );
}

function TaskModal({
  visible,
  projectId,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  projectId: string;
  onClose: () => void;
  onSubmit: (input: {
    title: string;
    notes?: string;
    assignee: AssigneeSelection;
    dueDate: string | null;
    /** Integer 1-100; undefined = no photo requirement. Admin-only. */
    requiredPhotoCount?: number;
  }) => Promise<void>;
}) {
  const colors = useColors();
  const { user: currentUser } = useAuth();
  // Admin-only field: the server strips requiredPhotoCount for
  // non-admins, so showing it to anyone else would silently no-op.
  // null role = legacy user row = treated as non-admin.
  const isAdmin = currentUser?.role === "admin";
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  // Kept as raw text so partial input ("1" on the way to "12") never
  // fights the keyboard; parsed + clamped to integer 0-100 on save.
  const [photosRequired, setPhotosRequired] = useState("");
  // null = explicitly Unassigned. The picker emits this shape directly so
  // the modal doesn't have to maintain parallel id/name state.
  const [assignee, setAssignee] = useState<AssigneeSelection>(null);
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Recomputed each open so "Today"/"Tomorrow" track the current date.
  const duePresets = useMemo(() => buildDuePresets(), [visible]);

  // Reset on close so the next "Add task" starts clean.
  useEffect(() => {
    if (!visible) {
      setTitle("");
      setNotes("");
      setAssignee(null);
      setDueDate(null);
      setPhotosRequired("");
    }
  }, [visible]);

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      // Clamp to the server's range (integer 0-100) so a bad value can
      // never 400 the create; empty / 0 / garbage = no requirement.
      const parsedPhotos = Math.min(
        100,
        Math.max(0, Math.floor(Number(photosRequired) || 0)),
      );
      await onSubmit({
        title: title.trim(),
        notes: notes.trim() || undefined,
        assignee,
        dueDate,
        requiredPhotoCount:
          isAdmin && parsedPhotos > 0 ? parsedPhotos : undefined,
      });
    } catch {
      // Toast handled by parent; keep modal open so user can retry.
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <ModalShell title="New task" onClose={onClose}>
        <Input label="Title" value={title} onChangeText={setTitle} autoFocus />

        <View style={{ gap: 6 }}>
          <Text
            style={{
              color: colors.foreground,
              fontFamily: "Inter_600SemiBold",
              fontSize: 13,
            }}
          >
            Assigned to
          </Text>
          <Pressable
            onPress={() => setPickerOpen(true)}
            style={({ pressed }) => [
              {
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingHorizontal: 14,
                paddingVertical: 14,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.card,
                opacity: pressed ? 0.85 : 1,
              },
            ]}
          >
            <Feather
              name={assignee ? "user" : "user-x"}
              size={16}
              color={colors.mutedForeground}
            />
            <Text
              style={{
                flex: 1,
                color: assignee ? colors.foreground : colors.mutedForeground,
                fontFamily: "Inter_500Medium",
                fontSize: 15,
              }}
              numberOfLines={1}
            >
              {assignee ? assignee.displayName : "Unassigned"}
            </Text>
            <Feather
              name="chevron-down"
              size={16}
              color={colors.mutedForeground}
            />
          </Pressable>
        </View>

        <View style={{ gap: 6 }}>
          <Text
            style={{
              color: colors.foreground,
              fontFamily: "Inter_600SemiBold",
              fontSize: 13,
            }}
          >
            Due date
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {duePresets.map((p) => {
              const active = dueDate === p.value;
              return (
                <Pressable
                  key={p.key}
                  onPress={() => setDueDate(p.value)}
                  style={({ pressed }) => [
                    {
                      paddingHorizontal: 14,
                      paddingVertical: 9,
                      borderRadius: 999,
                      borderWidth: 1,
                      borderColor: active ? colors.primary : colors.border,
                      backgroundColor: active ? colors.primary : colors.card,
                      opacity: pressed ? 0.85 : 1,
                    },
                  ]}
                >
                  <Text
                    style={{
                      color: active
                        ? colors.primaryForeground
                        : colors.foreground,
                      fontFamily: "Inter_500Medium",
                      fontSize: 14,
                    }}
                  >
                    {p.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <Input
          label="Notes"
          value={notes}
          onChangeText={setNotes}
          multiline
          style={{ minHeight: 80, textAlignVertical: "top" }}
        />
        {isAdmin ? (
          <View style={{ gap: 6 }}>
            <Input
              label="Photos required"
              value={photosRequired}
              onChangeText={(t) => setPhotosRequired(t.replace(/[^0-9]/g, ""))}
              keyboardType="number-pad"
              maxLength={3}
              placeholder="0"
            />
            <Text
              style={{
                color: colors.mutedForeground,
                fontFamily: "Inter_400Regular",
                fontSize: 12,
              }}
            >
              The task can't be marked done until this many photos are
              attached. Leave empty or 0 for no requirement.
            </Text>
          </View>
        ) : null}
        <Button title="Add task" onPress={save} loading={saving} size="lg" />
      </ModalShell>

      <AssigneePickerSheet
        visible={pickerOpen}
        projectId={projectId}
        selectedUserId={assignee?.userId ?? null}
        onClose={() => setPickerOpen(false)}
        onSelect={setAssignee}
      />
    </Modal>
  );
}

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View
        style={[
          styles.modalHeader,
          {
            paddingTop: insets.top + 8,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <Pressable onPress={onClose} hitSlop={10}>
          <Text style={{ color: colors.primary, fontFamily: "Inter_600SemiBold", fontSize: 16 }}>
            Cancel
          </Text>
        </Pressable>
        <Text style={[styles.modalTitle, { color: colors.foreground }]}>{title}</Text>
        <View style={{ width: 50 }} />
      </View>
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={{
          padding: 20,
          gap: 14,
          paddingBottom: insets.bottom + 40,
        }}
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  heroWrap: {
    width: "100%",
    height: 176,
    backgroundColor: "#000",
  },
  heroScrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  heroBackBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingLeft: 6,
    paddingRight: 12,
    paddingVertical: 8,
    backgroundColor: "rgba(0,0,0,0.45)",
    borderRadius: 100,
  },
  heroBackTxt: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  heroIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  summaryCard: {
    marginTop: -24,
    marginHorizontal: 16,
    borderRadius: 16,
    borderWidth: 1,
    padding: 12,
    gap: 8,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  summaryTitleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  summaryTitle: {
    flex: 1,
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.4,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 100,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    textTransform: "capitalize",
  },
  summaryMetaRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  summaryMeta: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    lineHeight: 18,
  },
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    marginTop: 2,
  },
  statCol: { flex: 1, alignItems: "center" },
  statNum: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.5,
  },
  statLbl: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    marginTop: 2,
  },
  statDivider: { width: StyleSheet.hairlineWidth, height: 32 },
  // Kebab popover (top-right overflow menu).
  shareChoiceBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "center",
    padding: 24,
  },
  shareChoiceSheet: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    gap: 12,
  },
  shareChoiceOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.25)",
  },
  menuSheet: {
    position: "absolute",
    right: 12,
    minWidth: 200,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 6,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  menuItemTxt: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  pillTabsRow: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 0,
    gap: 8,
  },
  pillTab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 100,
  },
  pillTabLabel: { fontSize: 14 },
  pillTabCount: { fontSize: 12, fontFamily: "Inter_500Medium" },
  tabs: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
  },
  tab: {
    paddingHorizontal: 10,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  body: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12 },
  // Virtualized grid rows carry the horizontal padding styles.body used
  // to provide (the grid is no longer nested inside a body View).
  gridHeaderRow: { paddingHorizontal: 20, paddingTop: 12 },
  photoSearchWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  photoSearchInput: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    padding: 0,
  },
  searchResultRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    marginHorizontal: 16,
    marginTop: 8,
  },
  searchResultThumb: {
    width: 64,
    height: 64,
    borderRadius: 8,
    overflow: "hidden",
  },
  searchResultCaption: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    lineHeight: 18,
  },
  gridPairRow: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 20,
    marginTop: 12,
  },
  fabCluster: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  // Same treatment as fabCamera (primary fill, circular, same shadow
  // weight scaled down) at smaller proportions — CompanyCam pattern.
  fabSide: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 5 },
    elevation: 10,
  },
  fabBadge: {
    position: "absolute",
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  fabBadgeText: { fontFamily: "Inter_700Bold", fontSize: 10 },
  // Matches the Projects tab bar QuickCaptureFAB (64px orange circle,
  // camera 28, same shadow weight).
  fabCamera: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 12,
  },
  photoGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: 10,
  },
  photoTile: {
    aspectRatio: 1,
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    position: "relative",
  },
  photosToolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  gridSegment: {
    flexDirection: "row",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 2,
    gap: 2,
  },
  gridBtn: {
    width: 34,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  filterBadge: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  filterSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: "85%",
  },
  sheetHandleRow: {
    alignItems: "center",
    paddingTop: 10,
    paddingBottom: 4,
  },
  sheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
  },
  filterHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  filterTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 17,
  },
  filterSectionLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    letterSpacing: 0.8,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  toolbarBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 36,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
  },
  toolbarBtnPrimary: {
    flex: 1.2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 36,
    borderRadius: 10,
    paddingHorizontal: 12,
  },
  toolbarBtnText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  dateHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  dateCheckbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  dateLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  selectMark: {
    position: "absolute",
    top: 8,
    left: 8,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  selectionBarFloating: {
    position: "absolute",
    left: 16,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  photo: { width: "100%", height: "100%" },
  tilePlaceholder: { backgroundColor: "#e2e5e9" },
  videoTile: {
    backgroundColor: "#1f2937",
    alignItems: "center",
    justifyContent: "center",
  },
  videoPlayBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    paddingLeft: 2,
  },
  photoBadge: {
    position: "absolute",
    bottom: 6,
    left: 6,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  uploadingDim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.2)",
  },
  uploadingBadge: {
    position: "absolute",
    bottom: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.65)",
    alignItems: "center",
    justifyContent: "center",
  },
  failedBadge: {
    position: "absolute",
    bottom: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#dc2626",
    alignItems: "center",
    justifyContent: "center",
  },
  taskRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 7,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxSmall: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  taskTitle: { fontSize: 15, fontFamily: "Inter_500Medium" },
  taskNotes: { fontSize: 13, fontFamily: "Inter_400Regular", marginTop: 2 },
  checklistCard: {
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
  },
  checklistHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  checklistTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold" },
  checklistMeta: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.5,
  },
  checklistItemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 4,
  },
  checklistItemText: { flex: 1, fontSize: 14, fontFamily: "Inter_500Medium" },
  memberCard: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    gap: 10,
  },
  memberName: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  memberSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold" },
});
