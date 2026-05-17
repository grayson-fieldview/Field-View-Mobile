import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import Svg, { Path as SvgPath } from "react-native-svg";
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
  View,
} from "react-native";
import Animated, {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AssigneePickerSheet, type AssigneeSelection } from "@/components/AssigneePickerSheet";
import { AssignUserToProjectModal } from "@/components/AssignUserToProjectModal";
import { Button } from "@/components/Button";
import { ClockReceiptBanner } from "@/components/ClockReceiptBanner";
import { EmptyState } from "@/components/EmptyState";
import KebabIcon from "@/components/KebabIcon";
import { Input } from "@/components/Input";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { ApplyReportTemplateModal } from "@/components/ApplyReportTemplateModal";
import { ReportListItem } from "@/components/ReportListItem";
import { TemplatePickerModal } from "@/components/TemplatePickerModal";
import { useAuth } from "@/contexts/AuthContext";
import { useData } from "@/contexts/DataContext";
import { useTimesheet, type TimesheetState } from "@/contexts/TimesheetContext";
import { useToast } from "@/contexts/ToastContext";
import { useUploadStatus } from "@/contexts/UploadStatusContext";
import { useColors } from "@/hooks/useColors";
import { useProjectChecklists } from "@/hooks/useProjectChecklists";
import { useProjectReports } from "@/hooks/useProjectReports";
import {
  api,
  ApiError,
  buildMediaReferencesMessage,
  type BackendProjectAssignment,
} from "@/services/api";
import {
  removeItem as removeUploadQueueItem,
  retryItem as retryUploadQueueItem,
} from "@/services/uploadQueue";

type TabKey = "photos" | "tasks" | "checklists" | "reports" | "team";

export default function ProjectDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id, recentClockIn } = useLocalSearchParams<{
    id: string;
    /** Set by the notification deep-link handler (app/_layout.tsx). */
    recentClockIn?: string;
  }>();
  const { showToast } = useToast();
  const {
    active: activeTimesheet,
    refresh: refreshTimesheet,
    firedExit,
    dismissFiredExit,
    firedEnter,
    dismissFiredEnter,
    clockIn: timesheetClockIn,
    clockOut: timesheetClockOut,
    loading: timesheetLoading,
  } = useTimesheet() as TimesheetState;
  const {
    projects,
    photos,
    tasks,
    deleteProject,
    createTask,
    toggleTask,
    deleteTask,
    deletePhoto,
    loadProjectDetail,
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
  useFocusEffect(
    useCallback(() => {
      void refreshChecklists();
    }, [refreshChecklists]),
  );
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
  // Real per-project team list (replaces the local-only ShareLink cache).
  // Loaded on demand when the Team tab is opened — no point pinging the
  // server for assignments the user may never view. Refreshed after a
  // successful invite or remove so the list stays in sync without a
  // full screen refresh.
  const [assignments, setAssignments] = useState<BackendProjectAssignment[]>([]);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [assignmentsError, setAssignmentsError] = useState<string | null>(null);

  const [tab, setTab] = useState<TabKey>("photos");
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [showChecklistModal, setShowChecklistModal] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [showAssignUserModal, setShowAssignUserModal] = useState(false);
  // Top-right kebab overflow menu. Houses destructive / infrequent
  // actions (Delete, plus manual Clock Out when the user is currently
  // clocked into THIS project — auto-exit is the happy path; the
  // kebab is the manual fallback).
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  // True while the share-token POST is in flight. Used to disable
  // the share button so impatient double-taps don't fire two POSTs.
  const [sharingProject, setSharingProject] = useState(false);
  // True while the manual kebab-menu "Clock In" call is in flight.
  // The menu closes before the API call fires (matches the Clock out
  // pattern), so this primarily protects against the user reopening
  // the menu and double-tapping during the brief window.
  const [clockingIn, setClockingIn] = useState(false);
  const isClockedInToThisProject =
    !!activeTimesheet && String(activeTimesheet.projectId) === String(id);

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

  // ----- Clock-in receipt banner (S31b) -----
  // Visible iff (a) the screen was deep-linked from a notification
  // tap (recentClockIn param present) AND (b) the corresponding
  // entry is still the active timesheet entry. The second clause
  // gracefully degrades the "user already clocked out manually
  // before tapping the receipt" race to a silent no-op.
  //
  // Dismissal vectors (in priority order):
  //   - Explicit X tap                       — always dismisses, even with error
  //   - 30s auto-timer                       — gated on no error
  //   - First user-initiated scroll          — gated on no error (onScrollBeginDrag)
  //   - Successful undo                      — programmatic, also clears server-side
  // Once `receiptError` is non-null, the banner sticks until X. The
  // user can still clock out manually from the ClockBar.
  const [receiptVisible, setReceiptVisible] = useState(true);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);

  const receiptEntry =
    recentClockIn &&
    activeTimesheet &&
    String(activeTimesheet.id) === recentClockIn
      ? activeTimesheet
      : null;
  const showReceipt = !!recentClockIn && !!receiptEntry && receiptVisible;

  // Log the rare race once per mount so we can spot it in field reports.
  useEffect(() => {
    if (recentClockIn && !receiptEntry) {
      console.log(
        `[receipt] suppressing banner: entry ${recentClockIn} not active (user already clocked out, or stale deep-link)`,
      );
    }
  }, [recentClockIn, receiptEntry]);

  // 30-second auto-dismiss. Resets if recentClockIn changes (e.g.
  // user taps a fresh receipt while still on this screen). Skipped
  // while error is sticky.
  useEffect(() => {
    if (!showReceipt || receiptError) return;
    const t = setTimeout(() => setReceiptVisible(false), 30_000);
    return () => clearTimeout(t);
  }, [showReceipt, receiptError, recentClockIn]);

  // ----- Clock-out receipt banner (S32a) -----
  // Visible iff (a) the TimesheetContext has a firedExit (i.e. the
  // foreground refresh discovered a server-fired auto-clock-out) AND
  // (b) the fired entry's projectId matches the screen we're on.
  // Cross-screen scoping means a fire for project X waits in context
  // until the user navigates to project X; on other screens it's
  // invisible.
  //
  // No clockOut-null gate; the prev snapshot has clockOut=null by
  // definition, and firedAt carries the actual server-fire time
  // within 60s of cron polling interval.
  //
  // Dismissal vectors (priority order, mirroring kind="in"):
  //   - Explicit X tap                  — clears context unconditionally
  //   - 30s auto-timer                  — gated on no error
  //   - First user-initiated scroll     — gated on no error
  //   - Successful undo                 — programmatic, also clears context + refreshes
  // On error, the banner sticks (locally) until X. Unlike kind="in"
  // there's no local visibility flag — context.firedExit IS the
  // visibility, which means navigating away with sticky error loses
  // the error on return (fresh retry available). Acceptable.
  const [outReceiptError, setOutReceiptError] = useState<string | null>(null);
  const [outUndoing, setOutUndoing] = useState(false);

  // Reset error state when a NEW firedExit surfaces (different entry
  // id), so a stale error from a prior fire doesn't poison the next
  // banner. Same pattern as kind="in" resetting on recentClockIn
  // change, but keyed on the entry id since firedExit is an object
  // reference and we want stable diff semantics.
  const firedEntryId = firedExit ? String(firedExit.entry.id) : null;
  useEffect(() => {
    setOutReceiptError(null);
  }, [firedEntryId]);

  const outShowReceipt =
    firedExit !== null &&
    String(firedExit.entry.projectId) === String(id);

  // 30-second auto-dismiss for kind="out". Re-arms on entry-id
  // change. Skipped while error is sticky.
  useEffect(() => {
    if (!outShowReceipt || outReceiptError) return;
    const t = setTimeout(() => dismissFiredExit(), 30_000);
    return () => clearTimeout(t);
  }, [outShowReceipt, outReceiptError, firedEntryId, dismissFiredExit]);

  const dismissOutReceipt = useCallback(() => {
    setOutReceiptError(null);
    dismissFiredExit();
  }, [dismissFiredExit]);

  const handleUndoOutReceipt = useCallback(async () => {
    if (!firedExit) return;
    setOutUndoing(true);
    setOutReceiptError(null);
    try {
      // Same /auto-undo endpoint as kind="in" — server routes
      // internally based on entry state (open vs closed). For a
      // closed entry from auto-clock-out, the server clears
      // clock_out and re-opens the session.
      await api.autoUndoTimeEntry(firedExit.entry.id);
      // Refresh to pull the now-reopened entry as the active
      // session. Refresh observes prev=null → next=entry transition,
      // which is non-fatal for discovery (no pending exit matches a
      // freshly-reopened entry id, and we already cleaned up the
      // pending row at fire-discovery time).
      await refreshTimesheet();
      dismissFiredExit();
      showToast("Clock-out undone");
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Network error";
      console.log(`[receipt] auto-clock-out undo failed: ${msg}`);
      setOutReceiptError(msg);
    } finally {
      setOutUndoing(false);
    }
  }, [firedExit, refreshTimesheet, dismissFiredExit, showToast]);

  // ----- Auto clock-in receipt banner (S3x-mobile, fired-path) -----
  // Sibling of the kind="out" firedExit banner for the dwell-time
  // auto-clock-IN path. Source is TimesheetContext.firedEnter, set
  // from EITHER the foreground push handler in app/_layout.tsx
  // (clock_in_receipt arrived while the app was foregrounded) OR
  // post-fact discovery in TimesheetContext (foreground refresh
  // observed a fresh auto_geofence session matching a local
  // pending-enter row).
  //
  // The OTHER kind="in" banner above (driven by `recentClockIn`
  // URL param) covers the deep-link tap path — user backgrounded,
  // notification fired, user tapped. Both are kind="in" and could
  // in theory be set for the SAME entry (push arrived foreground,
  // user backgrounded, tapped same notification). Gate below
  // suppresses the firedEnter banner when recentClockIn already
  // covers the same entry, so the user never sees two stacked
  // copies of the same receipt.
  //
  // Dismissal vectors mirror firedExit (kind="out"):
  //   - Explicit X tap                  — clears context unconditionally
  //   - 30s auto-timer                  — gated on no error
  //   - First user-initiated scroll     — gated on no error
  //   - Successful undo                 — programmatic, also clears + refreshes
  const [enterReceiptError, setEnterReceiptError] = useState<string | null>(
    null,
  );
  const [enterUndoing, setEnterUndoing] = useState(false);

  const firedEnterEntryId = firedEnter ? String(firedEnter.entry.id) : null;
  useEffect(() => {
    setEnterReceiptError(null);
  }, [firedEnterEntryId]);

  const enterShowReceipt =
    firedEnter !== null &&
    String(firedEnter.entry.projectId) === String(id) &&
    // Suppress when the recentClockIn deep-link banner is already
    // showing the same entry — avoid double-banner for one fire.
    firedEnterEntryId !== recentClockIn;

  useEffect(() => {
    if (!enterShowReceipt || enterReceiptError) return;
    const t = setTimeout(() => dismissFiredEnter(), 30_000);
    return () => clearTimeout(t);
  }, [
    enterShowReceipt,
    enterReceiptError,
    firedEnterEntryId,
    dismissFiredEnter,
  ]);

  const dismissEnterReceipt = useCallback(() => {
    setEnterReceiptError(null);
    dismissFiredEnter();
  }, [dismissFiredEnter]);

  const handleUndoEnterReceipt = useCallback(async () => {
    if (!firedEnter) return;
    setEnterUndoing(true);
    setEnterReceiptError(null);
    try {
      // Same /auto-undo endpoint as the deep-link kind="in" handler
      // and the firedExit kind="out" handler — server routes
      // internally based on entry state. For an open auto-clock-in
      // entry, the server deletes the time entry row.
      await api.autoUndoTimeEntry(firedEnter.entry.id);
      // Refresh to clear the now-deleted active session. Refresh
      // observes prev=entry → next=null transition, which the
      // post-fact exit-discovery branch handles cleanly (no
      // pending-exit match, so no spurious kind="out" banner).
      await refreshTimesheet();
      dismissFiredEnter();
      showToast("Clock-in undone");
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Network error";
      console.log(`[receipt] auto-clock-in undo failed: ${msg}`);
      setEnterReceiptError(msg);
    } finally {
      setEnterUndoing(false);
    }
  }, [firedEnter, refreshTimesheet, dismissFiredEnter, showToast]);

  const dismissReceiptOnInteraction = useCallback(() => {
    // Each kind dismisses independently with its own error gate so
    // a sticky error on one doesn't suppress dismissal of the other.
    if (!receiptError) setReceiptVisible(false);
    if (!outReceiptError && firedExit) dismissFiredExit();
    if (!enterReceiptError && firedEnter) dismissFiredEnter();
  }, [
    receiptError,
    outReceiptError,
    enterReceiptError,
    firedExit,
    firedEnter,
    dismissFiredExit,
    dismissFiredEnter,
  ]);

  const dismissReceipt = useCallback(() => {
    setReceiptVisible(false);
    setReceiptError(null);
  }, []);

  const handleUndoReceipt = useCallback(async () => {
    if (!receiptEntry) return;
    setUndoing(true);
    setReceiptError(null);
    try {
      await api.autoUndoTimeEntry(receiptEntry.id);
      // Server-side delete succeeded → pull fresh active state so the
      // ClockBar transitions out of "clocked in here" immediately.
      // We don't optimistically setActive(null) on TimesheetContext
      // because TimesheetContext owns that state; refresh is the
      // honest path and the UI lag is sub-second.
      await refreshTimesheet();
      setReceiptVisible(false);
      showToast("Clock-in undone");
    } catch (err) {
      // 4xx from backend (window expired, ownership mismatch) carries
      // a human message. Network errors fall through to a generic.
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Network error";
      console.log(`[receipt] undo failed: ${msg}`);
      setReceiptError(msg);
    } finally {
      setUndoing(false);
    }
  }, [receiptEntry, refreshTimesheet, showToast]);

  // ---- Clock bar auto-hide on scroll (State 1 only) ----
  // Shared values live on the UI thread so the scroll handler doesn't
  // round-trip to JS for every frame. `autoHideEnabled` is flipped from JS
  // when the timesheet state transitions in/out of State 1; the worklet
  // reads it directly.
  const clockBarTranslateY = useSharedValue(0);
  const lastScrollY = useSharedValue(0);
  const autoHideEnabled = useSharedValue(0); // 0 = bar pinned, 1 = may hide

  const SCROLL_DELTA_THRESHOLD = 10;
  const SCROLL_TOP_PIN = 20;
  const HIDE_OFFSET = 120; // bar height + safe inset, off-screen target

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (e) => {
      "worklet";
      const y = e.contentOffset.y;
      // Always pin to visible at the top of the scroll, even in State 1.
      if (y < SCROLL_TOP_PIN) {
        clockBarTranslateY.value = withTiming(0, { duration: 180 });
        lastScrollY.value = y;
        return;
      }
      if (autoHideEnabled.value !== 1) return;
      const dy = y - lastScrollY.value;
      if (dy > SCROLL_DELTA_THRESHOLD) {
        clockBarTranslateY.value = withTiming(HIDE_OFFSET, { duration: 180 });
        lastScrollY.value = y;
      } else if (dy < -SCROLL_DELTA_THRESHOLD) {
        clockBarTranslateY.value = withTiming(0, { duration: 180 });
        lastScrollY.value = y;
      }
    },
  });

  // Photos tab UI state.
  const [gridSize, setGridSize] = useState<1 | 2 | 3>(2);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Selection mode is implicit: we're in it whenever something is selected.
  const selectMode = selected.size > 0;

  // Group photos by their taken-at calendar day, most recent day first; within
  // each day, photos are sorted with the newest at the top.
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
    for (const ph of projectPhotos) {
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
    for (const g of list) {
      g.photos.sort((a, b) => {
        const ta = a.takenAt ? Date.parse(a.takenAt) : 0;
        const tb = b.takenAt ? Date.parse(b.takenAt) : 0;
        return tb - ta;
      });
      g.ids = g.photos.map((p) => p.id);
    }
    return list.sort((a, b) => b.sortKey - a.sortKey);
  }, [projectPhotos]);

  const exitSelectMode = () => {
    setSelected(new Set());
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
    } catch {
      showToast("Couldn't generate share link");
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
      deleteProject(project.id).then(() => router.back());
    if (Platform.OS === "web") {
      doIt();
      return;
    }
    Alert.alert(
      "Delete project?",
      `"${project.name}" and all its photos, tasks, and checklists will be removed.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: doIt },
      ],
    );
  };

  const heroPhoto = project.coverPhotoUrl ?? projectPhotos[0]?.uri;
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
  const createdLabel = project.createdAt
    ? new Date(project.createdAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <View style={[styles.wrap, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <Animated.ScrollView
        contentContainerStyle={{
          // Reserve room for the bottom ClockBar only when it
          // actually renders (States 2/3 — clocked in here, or
          // clocked into another project). State 1 ("not clocked
          // in") now returns null from ClockBar, so we tighten
          // the reserve to the safe-area inset plus a small gutter,
          // reclaiming ~96px of usable viewport for the photo grid.
          paddingBottom: insets.bottom + (activeTimesheet ? 120 : 24),
        }}
        onScroll={scrollHandler}
        // onScrollBeginDrag fires once per user-initiated scroll
        // gesture (NOT for programmatic scrolls), which is exactly
        // the "first interaction" semantic we want for receipt
        // dismissal. The banner unmounts while the user is still
        // mid-drag — feels responsive, not jarring, because the
        // banner sits inside the ScrollView so it's already
        // translating off-screen.
        onScrollBeginDrag={dismissReceiptOnInteraction}
        scrollEventThrottle={16}
      >
        {/* Receipt banner sits above the hero, inside the ScrollView,
            padded for the status bar. Scrolling pushes it off-screen
            naturally AND triggers onScrollBeginDrag → state-level
            dismissal so it doesn't reappear on scroll-back. */}
        {showReceipt && receiptEntry ? (
          <View style={{ paddingTop: insets.top }}>
            <ClockReceiptBanner
              kind="in"
              visible={showReceipt}
              time={new Date(receiptEntry.clockIn)}
              projectName={project.name}
              error={receiptError}
              undoing={undoing}
              onUndo={() => {
                void handleUndoReceipt();
              }}
              onDismiss={dismissReceipt}
            />
          </View>
        ) : null}
        {/* Clock-out receipt (S32a). Rendered in parallel with the
            kind="in" banner — both can theoretically be visible at
            once (e.g. user taps a fresh clock-in receipt notification
            while a stale clock-out fire sits in context for the same
            project). In practice this is vanishingly unlikely; if it
            happens both stack vertically and the user dismisses each
            independently. */}
        {outShowReceipt && firedExit ? (
          <View style={{ paddingTop: showReceipt ? 0 : insets.top }}>
            <ClockReceiptBanner
              kind="out"
              visible={outShowReceipt}
              time={new Date(firedExit.firedAt)}
              projectName={project.name}
              error={outReceiptError}
              undoing={outUndoing}
              onUndo={() => {
                void handleUndoOutReceipt();
              }}
              onDismiss={dismissOutReceipt}
            />
          </View>
        ) : null}
        {/* Auto-clock-in receipt (S3x-mobile, fired-path). Only
            renders when the deep-link kind="in" banner above ISN'T
            already covering the same entry (gated in
            enterShowReceipt). Same insets.top compensation as
            kind="out" — top padding only when no banner is rendered
            above us. */}
        {enterShowReceipt && firedEnter ? (
          <View
            style={{
              paddingTop: showReceipt || outShowReceipt ? 0 : insets.top,
            }}
          >
            <ClockReceiptBanner
              kind="in"
              visible={enterShowReceipt}
              time={new Date(firedEnter.firedAt)}
              projectName={project.name}
              error={enterReceiptError}
              undoing={enterUndoing}
              onUndo={() => {
                void handleUndoEnterReceipt();
              }}
              onDismiss={dismissEnterReceipt}
            />
          </View>
        ) : null}
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
                onPress={onShareProject}
                hitSlop={10}
                disabled={sharingProject}
                accessibilityRole="button"
                accessibilityLabel="Share project"
                accessibilityState={{ disabled: sharingProject, busy: sharingProject }}
                style={({ pressed }) => [
                  styles.heroIconBtn,
                  { opacity: sharingProject ? 0.5 : pressed ? 0.7 : 1 },
                ]}
              >
                {sharingProject ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Feather name="share-2" size={16} color="#fff" />
                )}
              </Pressable>
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

        {tab === "photos" ? (
          <View style={styles.body}>
            <PhotosToolbar
              gridSize={gridSize}
              onGridSize={setGridSize}
              onTakePhoto={() =>
                router.push({
                  pathname: "/capture",
                  params: { projectId: project.id },
                })
              }
              colors={colors}
            />

            {projectPhotos.length === 0 ? (
              <View style={{ paddingTop: 20 }}>
                <EmptyState
                  icon="camera"
                  title="No photos yet"
                  description="Tap Take Photo to capture burst-mode photos with GPS tagging."
                />
              </View>
            ) : (
              <View style={{ marginTop: 14, gap: 18 }}>
                {photoGroups.map((g) => {
                  const allSelected = g.ids.every((i) => selected.has(i));
                  return (
                    <View key={g.label} style={{ gap: 10 }}>
                      <View style={styles.dateHeader}>
                        <Pressable
                          onPress={() => toggleGroupSelected(g.ids)}
                          hitSlop={6}
                          accessibilityRole="checkbox"
                          accessibilityLabel={`Select all photos from ${g.label}`}
                          accessibilityState={{ checked: allSelected }}
                          style={[
                            styles.dateCheckbox,
                            {
                              borderColor: allSelected
                                ? colors.primary
                                : colors.border,
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
                        <Text
                          style={[
                            styles.dateLabel,
                            { color: colors.foreground },
                          ]}
                        >
                          {g.label}
                        </Text>
                      </View>
                      <View
                        style={[
                          styles.photoGrid,
                          gridSize === 1
                            ? { rowGap: 12 }
                            : gridSize === 3
                              ? { rowGap: 6 }
                              : { rowGap: 10 },
                        ]}
                      >
                        {g.photos.map((ph) => (
                          <PhotoTile
                            key={ph.id}
                            photo={ph}
                            borderColor={colors.border}
                            widthPercent={
                              gridSize === 1
                                ? "100%"
                                : gridSize === 2
                                  ? "48.5%"
                                  : "32%"
                            }
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
                      </View>
                    </View>
                  );
                })}
              </View>
            )}

            {selectMode && selected.size > 0 ? (
              <View style={styles.selectionBar}>
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
                <Pressable onPress={deleteSelected} hitSlop={6}>
                  <Text
                    style={{
                      color: colors.destructive,
                      fontFamily: "Inter_700Bold",
                      fontSize: 14,
                    }}
                  >
                    Delete
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        ) : null}

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
                    onPress={() => toggleTask(t.id)}
                    onLongPress={() => {
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
                      },
                    ]}
                  >
                    <View
                      style={[
                        styles.checkbox,
                        {
                          borderColor: t.done ? colors.primary : colors.border,
                          backgroundColor: t.done
                            ? colors.primary
                            : "transparent",
                        },
                      ]}
                    >
                      {t.done ? (
                        <Feather
                          name="check"
                          size={14}
                          color={colors.primaryForeground}
                        />
                      ) : null}
                    </View>
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
                description="Apply a template to spawn a checklist for this project. New templates and items are managed on the web."
                action={
                  <Button
                    title="Apply template"
                    onPress={() => setShowChecklistModal(true)}
                  />
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
                  title="Apply template"
                  variant="secondary"
                  onPress={() => setShowChecklistModal(true)}
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
                  <Button
                    title="New report"
                    onPress={() => setShowReportModal(true)}
                  />
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
                  title="New report"
                  variant="secondary"
                  onPress={() => setShowReportModal(true)}
                />
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
          </View>
        ) : null}
      </Animated.ScrollView>

      <ClockBar
        thisProjectId={String(project.id)}
        colors={colors}
        bottomInset={insets.bottom}
        translateY={clockBarTranslateY}
        lastScrollY={lastScrollY}
        autoHideEnabled={autoHideEnabled}
      />

      <TaskModal
        visible={showTaskModal}
        projectId={project.id}
        onClose={() => setShowTaskModal(false)}
        onSubmit={async ({ title, notes, assignee }) => {
          try {
            await createTask(project.id, {
              title,
              description: notes,
              assignedToId: assignee?.userId ?? null,
              assignedToName: assignee?.displayName,
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
      {/* Top-right kebab overflow menu. Lightweight Modal-as-popover
          (matches the rest of this screen's modal patterns). Items:
          - Clock out (only when clocked into THIS project) — the
            manual fallback for auto-exit; calls the same timesheet
            action the old prominent button used.
          - Delete project — destructive, was the kebab's single
            action before. */}
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
            {!activeTimesheet ? (
              <Pressable
                onPress={() => {
                  if (!project) return;
                  setShowProjectMenu(false);
                  const projectName = project.name;
                  const projectId = project.id;
                  const doClockIn = async () => {
                    setClockingIn(true);
                    // Context toasts the error itself on failure
                    // ("Couldn't clock in: …") and returns null;
                    // we only toast the success case here.
                    const entry = await timesheetClockIn(projectId);
                    setClockingIn(false);
                    if (entry) showToast("Clocked in.");
                  };
                  if (Platform.OS === "web") {
                    void doClockIn();
                    return;
                  }
                  Alert.alert(`Clock in to ${projectName}?`, undefined, [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Clock in",
                      onPress: () => {
                        void doClockIn();
                      },
                    },
                  ]);
                }}
                disabled={clockingIn || timesheetLoading}
                style={({ pressed }) => [
                  styles.menuItem,
                  {
                    opacity:
                      clockingIn || timesheetLoading ? 0.5 : pressed ? 0.6 : 1,
                  },
                ]}
              >
                <Feather
                  name="play-circle"
                  size={16}
                  color={colors.foreground}
                />
                <Text
                  style={[styles.menuItemTxt, { color: colors.foreground }]}
                >
                  Clock In
                </Text>
                {clockingIn ? (
                  <ActivityIndicator
                    size="small"
                    color={colors.mutedForeground}
                    style={{ marginLeft: "auto" }}
                  />
                ) : null}
              </Pressable>
            ) : null}
            {isClockedInToThisProject ? (
              <Pressable
                onPress={() => {
                  setShowProjectMenu(false);
                  const doClockOut = () => {
                    void timesheetClockOut().then((entry) => {
                      // Context returns null on failure (and toasts the
                      // error itself), so guard the success toast to
                      // avoid the "Couldn't clock out: …" + "Clocked
                      // out." double-toast. Mirrors the Clock In guard.
                      if (entry) showToast("Clocked out.");
                    });
                  };
                  if (Platform.OS === "web") {
                    doClockOut();
                    return;
                  }
                  Alert.alert("Clock out?", undefined, [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Clock out",
                      style: "destructive",
                      onPress: doClockOut,
                    },
                  ]);
                }}
                disabled={timesheetLoading}
                style={({ pressed }) => [
                  styles.menuItem,
                  { opacity: timesheetLoading ? 0.5 : pressed ? 0.6 : 1 },
                ]}
              >
                <Feather
                  name="stop-circle"
                  size={16}
                  color={colors.foreground}
                />
                <Text
                  style={[styles.menuItemTxt, { color: colors.foreground }]}
                >
                  Clock out
                </Text>
              </Pressable>
            ) : null}
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
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function formatElapsed(startIso: string, nowMs: number): string {
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return "0h 0m";
  const ms = Math.max(0, nowMs - start);
  const totalMins = Math.floor(ms / 60000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return `${h}h ${m}m`;
}

/** "3:15 PM" style local-time label for the clock-in moment. Returns
 *  empty string on unparseable input so the caller can fall back. */
function formatClockInTime(startIso: string): string {
  const t = Date.parse(startIso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function ClockBar({
  thisProjectId,
  colors,
  bottomInset,
  translateY,
  lastScrollY,
  autoHideEnabled,
}: {
  thisProjectId: string;
  colors: ReturnType<typeof useColors>;
  bottomInset: number;
  translateY: SharedValue<number>;
  lastScrollY: SharedValue<number>;
  autoHideEnabled: SharedValue<number>;
}) {
  const { active, ready, loading, clockOut } =
    useTimesheet() as TimesheetState;
  const { projects } = useData();
  const [now, setNow] = useState(() => Date.now());

  const isClockedInHere =
    !!active && String(active.projectId) === thisProjectId;
  // Auto-hide is enabled ONLY in State 1 (no active entry). State 2 and 3
  // keep the bar pinned regardless of scroll.
  const shouldAutoHide = ready && !active;

  // Sync the worklet-side autoHideEnabled flag whenever the JS-side state
  // transitions, and reset position so the bar never appears stuck off-screen
  // after a transition (e.g. user clocks out after scrolling deep).
  useEffect(() => {
    if (shouldAutoHide) {
      // Just entered State 1 — clear stale scroll-direction memory and snap
      // the bar back into view.
      lastScrollY.value = 0;
      translateY.value = withTiming(0, { duration: 180 });
      autoHideEnabled.value = 1;
    } else {
      // State 2 or 3 — pin visible.
      autoHideEnabled.value = 0;
      translateY.value = withTiming(0, { duration: 180 });
    }
  }, [shouldAutoHide, translateY, lastScrollY, autoHideEnabled]);

  const animatedBarStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  // Live-update the elapsed timer every 60s while clocked into THIS project.
  useEffect(() => {
    if (!isClockedInHere || !active) return;
    setNow(Date.now()); // immediate refresh on mount/transition
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [isClockedInHere, active?.id, active]);

  const confirmClockOut = (otherName?: string) => {
    const title = otherName
      ? `Clock out of ${otherName}?`
      : "Clock out?";
    if (Platform.OS === "web") {
      void clockOut();
      return;
    }
    Alert.alert(title, undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clock out",
        style: "destructive",
        onPress: () => {
          void clockOut();
        },
      },
    ]);
  };

  // Render a stable-height container even before first fetch so the bar
  // doesn't pop in suddenly.
  const containerStyle = [
    styles.clockBar,
    {
      backgroundColor: colors.card,
      borderTopColor: colors.border,
      paddingBottom: bottomInset + 10,
    },
  ];

  if (!ready) {
    return (
      <Animated.View style={[containerStyle, animatedBarStyle]}>
        <ActivityIndicator color={colors.mutedForeground} />
      </Animated.View>
    );
  }

  // State 1: not clocked in anywhere → render nothing.
  // Auto-clock-in via geofencing is the default happy path
  // (S29/30/30.5/31a); manual clock-in is discoverable via the
  // top-right kebab menu's "Clock In" item, so the previous
  // "Not clocked in to this project. Use ⋯ menu to clock in"
  // pill is redundant and was covering the photo grid.
  // ScrollView paddingBottom above is conditional on
  // `activeTimesheet`, so reclaiming the bar's footprint is
  // automatic when this branch fires.
  if (!active) {
    return null;
  }

  // State 2: clocked into THIS project.
  // The manual "Clock Out" button used to live here. It moved into
  // the project's top-right kebab menu so the bottom CTA stays a
  // single, predictable affordance: it's only ever a Clock-In path
  // (or, while clocked in, ambient feedback). The kebab is the
  // manual fallback for when auto-exit (geofence cron) doesn't fire.
  if (isClockedInHere) {
    const sinceLabel = formatClockInTime(active.clockIn);
    return (
      <Animated.View style={[containerStyle, animatedBarStyle]}>
        <View
          style={[
            styles.clockStatusPill,
            {
              backgroundColor: "#ef9003" + "1A",
              borderColor: "#ef9003" + "55",
            },
          ]}
        >
          <Feather name="clock" size={14} color="#ef9003" />
          <Text
            style={[styles.clockStatusPillTxt, { color: "#ef9003" }]}
            numberOfLines={1}
          >
            {sinceLabel
              ? `Clocked in since ${sinceLabel} · ${formatElapsed(active.clockIn, now)}`
              : `Clocked in · ${formatElapsed(active.clockIn, now)}`}
          </Text>
          {loading ? (
            <ActivityIndicator size="small" color="#ef9003" />
          ) : null}
        </View>
      </Animated.View>
    );
  }

  // State 3: clocked into ANOTHER project.
  const otherProject = projects.find(
    (p) => String(p.id) === String(active.projectId),
  );
  const otherName = otherProject?.name ?? "another project";
  return (
    <Animated.View style={[containerStyle, animatedBarStyle]}>
      <View style={styles.clockStatusCol}>
        <Text style={[styles.clockStatusLbl, { color: colors.mutedForeground }]}>
          CLOCKED IN TO
        </Text>
        <Text
          style={[styles.clockStatusVal, { color: colors.foreground }]}
          numberOfLines={1}
        >
          {otherName}
        </Text>
        <Pressable
          onPress={() => confirmClockOut(otherName)}
          disabled={loading}
          hitSlop={14}
          accessibilityRole="button"
          accessibilityLabel={`Clock out of ${otherName} first`}
        >
          <Text style={[styles.clockLink, { color: colors.primary }]}>
            Clock out of {otherName} first
          </Text>
        </Pressable>
      </View>
      {loading ? (
        <ActivityIndicator color={colors.mutedForeground} />
      ) : null}
    </Animated.View>
  );
}

function showFailedUploadActionSheet(
  uploadQueueId: string,
  onRemoveLocalPhoto: () => void,
) {
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
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: "Upload failed",
        options: ["Cancel", "Retry now", "Remove from queue"],
        cancelButtonIndex: 0,
        destructiveButtonIndex: 2,
      },
      (idx) => {
        if (idx === 1) {
          void retryUploadQueueItem(uploadQueueId);
        } else if (idx === 2) {
          confirmRemove();
        }
      },
    );
  } else {
    Alert.alert("Upload failed", undefined, [
      {
        text: "Retry now",
        onPress: () => {
          void retryUploadQueueItem(uploadQueueId);
        },
      },
      {
        text: "Remove from queue",
        style: "destructive",
        onPress: confirmRemove,
      },
      { text: "Cancel", style: "cancel" },
    ]);
  }
}

function PhotoTile({
  photo,
  borderColor,
  widthPercent,
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
  widthPercent: import("react-native").DimensionValue;
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
  const uploadStatus: "uploading" | "failed" | null = !queueItem
    ? null
    : queueItem.status === "failed"
      ? "failed"
      : queueItem.status === "pending" || queueItem.status === "uploading"
        ? "uploading"
        : null;

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
      showFailedUploadActionSheet(photo.uploadQueueId, onRemoveLocal);
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
          width: widthPercent,
        },
      ]}
    >
      <Image
        source={{ uri: photo.uri }}
        style={styles.photo}
        contentFit="cover"
        transition={120}
      />
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

function AnnotationOverlay({
  strokes,
}: {
  strokes: import("@/services/types").AnnotationStroke[];
}) {
  // Filter out non-pencil / malformed strokes BEFORE any iteration —
  // both the viewBox math (reads s.canvasW/H + walks s.points) and
  // the render map (calls pointsToPath(s.points)) would crash on a
  // text-kind stroke with no points array. Forward-compat with the
  // 2026-Q2 web schema additions; see isRenderablePencilStroke().
  const { isRenderablePencilStroke } =
    require("@/services/types") as typeof import("@/services/types");
  const renderable = strokes.filter(isRenderablePencilStroke);
  let w = 0;
  let h = 0;
  for (const s of renderable) {
    if (s.canvasW && s.canvasW > w) w = s.canvasW;
    if (s.canvasH && s.canvasH > h) h = s.canvasH;
  }
  if (w === 0 || h === 0) {
    let maxX = 0;
    let maxY = 0;
    for (const s of strokes)
      for (const p of s.points) {
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    w = w || maxX + 16;
    h = h || maxY + 16;
  }
  if (w <= 0 || h <= 0) return null;
  return (
    <Svg
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="xMidYMid slice"
    >
      {strokes.map((s, i) => (
        <SvgPath
          key={i}
          d={pointsToPath(s.points)}
          stroke={s.color}
          strokeWidth={s.size}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      ))}
    </Svg>
  );
}

function pointsToPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++)
    d += ` L${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`;
  return d;
}

function PhotosToolbar({
  gridSize,
  onGridSize,
  onTakePhoto,
  colors,
}: {
  gridSize: 1 | 2 | 3;
  onGridSize: (s: 1 | 2 | 3) => void;
  onTakePhoto: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={styles.photosToolbar}>
      <View
        style={[
          styles.gridSegment,
          { backgroundColor: colors.muted, borderColor: colors.border },
        ]}
      >
        {([3, 2, 1] as const).map((s) => {
          const active = gridSize === s;
          const icon: keyof typeof Feather.glyphMap =
            s === 3 ? "grid" : s === 2 ? "columns" : "square";
          return (
            <Pressable
              key={s}
              onPress={() => onGridSize(s)}
              accessibilityRole="button"
              accessibilityLabel={`${s}-column grid`}
              accessibilityState={{ selected: active }}
              style={[
                styles.gridBtn,
                {
                  backgroundColor: active
                    ? colors.background
                    : "transparent",
                },
              ]}
            >
              <Feather
                name={icon}
                size={16}
                color={active ? colors.foreground : colors.mutedForeground}
              />
            </Pressable>
          );
        })}
      </View>

      <Pressable
        onPress={onTakePhoto}
        accessibilityRole="button"
        accessibilityLabel="Take photo"
        style={({ pressed }) => [
          styles.toolbarBtnPrimary,
          {
            backgroundColor: colors.primary,
            opacity: pressed ? 0.9 : 1,
          },
        ]}
      >
        <Feather name="camera" size={14} color={colors.primaryForeground} />
        <Text
          style={[
            styles.toolbarBtnText,
            { color: colors.primaryForeground },
          ]}
          numberOfLines={1}
        >
          Take Photo
        </Text>
      </Pressable>
    </View>
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
  }) => Promise<void>;
}) {
  const colors = useColors();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  // null = explicitly Unassigned. The picker emits this shape directly so
  // the modal doesn't have to maintain parallel id/name state.
  const [assignee, setAssignee] = useState<AssigneeSelection>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reset on close so the next "Add task" starts clean.
  useEffect(() => {
    if (!visible) {
      setTitle("");
      setNotes("");
      setAssignee(null);
    }
  }, [visible]);

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await onSubmit({
        title: title.trim(),
        notes: notes.trim() || undefined,
        assignee,
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

        <Input
          label="Notes"
          value={notes}
          onChangeText={setNotes}
          multiline
          style={{ minHeight: 80, textAlignVertical: "top" }}
        />
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
    height: 220,
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
    marginTop: -28,
    marginHorizontal: 16,
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    gap: 10,
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
    paddingTop: 12,
    marginTop: 4,
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
  clockBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    minHeight: 64,
    paddingTop: 10,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: -2 },
    elevation: 8,
  },
  clockBtn: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 16,
  },
  clockBtnInline: {
    flex: 0,
    paddingHorizontal: 18,
  },
  clockBtnTxt: {
    color: "#fff",
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.2,
  },
  clockStatusCol: {
    flex: 1,
    gap: 2,
  },
  clockStatusLbl: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
  },
  clockStatusVal: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.2,
  },
  clockLink: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    marginTop: 2,
  },
  // State 2 status pill — replaces the old "Clock Out" button. Tinted
  // orange so it reads as ambient feedback (project is on the clock)
  // without acting as a CTA. Manual clock-out lives in the kebab.
  clockStatusPill: {
    flex: 1,
    minHeight: 44,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  clockStatusPillTxt: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  // State 1 neutral pill — two-line column (primary label + hint
  // pointing the user at the kebab menu). Sized to fit inside the
  // same pill shape as State 2 without changing the bar's overall
  // vertical rhythm.
  clockNeutralCol: {
    flex: 1,
  },
  clockNeutralHint: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    opacity: 0.8,
    marginTop: 1,
  },
  // Kebab popover (top-right overflow menu).
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
    paddingTop: 14,
    paddingBottom: 6,
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
  body: { padding: 20 },
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
  selectionBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 18,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.06)",
  },
  photo: { width: "100%", height: "100%" },
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
