import { Feather } from "@expo/vector-icons";
import {
  BottomSheetBackdrop,
  type BottomSheetBackdropProps,
  BottomSheetModal,
  BottomSheetTextInput,
  BottomSheetView,
} from "@gorhom/bottom-sheet";
import { Image } from "expo-image";
import * as MediaLibrary from "expo-media-library";
import { VideoView, useVideoPlayer } from "expo-video";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Gallery from "react-native-awesome-gallery";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  AnnotationEditor,
  AnnotationLayer,
  COLORS,
  SIZES,
} from "@/components/AnnotationEditor";
import {
  AssigneePickerSheet,
  type AssigneeSelection,
} from "@/components/AssigneePickerSheet";
import { fittedContainRect } from "@/services/annotations";
import { useAuth } from "@/contexts/AuthContext";
import { useData } from "@/contexts/DataContext";
import { useToast } from "@/contexts/ToastContext";
import { ApiError, api, buildMediaReferencesMessage } from "@/services/api";
import type {
  BackendAccountTag,
  BackendCommentResponse,
} from "@/services/api";
import type { Photo, StoredStroke } from "@/services/types";
// Module-level snap-point constants: an inline array literal gets a new
// identity every render, which gorhom treats as a config change while a
// present animation may be in flight. One frozen instance per sheet.
const SNAP_COMMENTS = ["45%"];
const SNAP_TASK = ["40%"];
const SNAP_TAG = ["35%"];
const SNAP_OVERFLOW = ["40%"];

/**
 * Full-screen video player for the viewer. Used both inside the gallery
 * (read mode) and in place of the annotate canvas when the open media is a
 * video (videos can't be drawn on). Uses expo-video's useVideoPlayer —
 * which is why this lives in its own component: the gallery's renderItem
 * can't call hooks per-item, so each video item mounts one of these.
 */
function VideoGalleryItem({
  uri,
  onReady,
}: {
  uri: string;
  /**
   * Optional. react-native-awesome-gallery needs a non-zero item size or
   * its pinch/zoom math divides by zero. Images report it via expo-image's
   * onLoad; video has no equivalent, so the gallery branch passes this to
   * seed a size once after mount.
   */
  onReady?: () => void;
}) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
  });
  useEffect(() => {
    onReady?.();
  }, [onReady]);
  return (
    <View style={StyleSheet.absoluteFill}>
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        nativeControls
        allowsFullscreen
      />
    </View>
  );
}

export default function PhotoViewerScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const {
    photos,
    projects,
    tasks,
    createTask,
    updatePhoto,
    deletePhoto,
    loadPhotoAnnotations,
    saveAnnotations,
  } = useData();
  const { showToast } = useToast();
  const { accountSettings } = useAuth();
  // True while we're fetching references for the trash button — drives
  // the inline spinner replacement of the trash icon. The actual
  // Alert.alert isn't a "loading" surface, so the spinner only shows
  // during the GET /api/media/:id/references round-trip.
  const [trashLoading, setTrashLoading] = useState(false);

  const startPhoto = useMemo(() => photos.find((p) => p.id === id), [photos, id]);
  const projectPhotos = useMemo(
    () =>
      startPhoto
        ? photos.filter((p) => p.projectId === startPhoto.projectId)
        : [],
    [photos, startPhoto],
  );
  // Stable-identity gallery data. Every DataContext resync rebuilds the
  // photos array, so projectPhotos gets a NEW identity even when nothing
  // the gallery renders has changed — and awesome-gallery re-initializes
  // (spurious onIndexChange, item remounts) on every data identity change.
  // Hand the gallery the PREVIOUS array instance unless a render-relevant
  // fingerprint changed: photo id set/order, source uri, video-ness, or
  // annotation count. Adds/removes change the id list → new identity, so
  // the gallery can't go stale on genuine set changes.
  const galleryDataRef = useRef<{ fp: string; data: Photo[] } | null>(null);
  const galleryData = useMemo(() => {
    const fp = projectPhotos
      .map(
        (p) =>
          `${p.id}|${p.uri}|${p.isVideo ? 1 : 0}|${p.annotations?.length ?? 0}`,
      )
      .join("\u0000");
    if (galleryDataRef.current && galleryDataRef.current.fp === fp) {
      return galleryDataRef.current.data;
    }
    galleryDataRef.current = { fp, data: projectPhotos };
    return projectPhotos;
  }, [projectPhotos]);

  const startIndex = useMemo(() => {
    const i = projectPhotos.findIndex((p) => p.id === id);
    return i < 0 ? 0 : i;
  }, [projectPhotos, id]);

  // currentIndex is the single source of truth for "which photo am I on?"
  // across both render branches. Gallery's onIndexChange writes it; the
  // edit branch reads it to render the active photo. When the user
  // toggles edit mode, the gallery unmounts and remounts with
  // initialIndex={currentIndex}, so position is preserved automatically.
  const [currentIndex, setCurrentIndex] = useState(startIndex);
  // Re-seat currentIndex if the photo set changes underneath us (e.g.
  // a sibling delete shifts indices). Clamp to the new bounds.
  useEffect(() => {
    if (projectPhotos.length === 0) return;
    if (currentIndex >= projectPhotos.length) {
      setCurrentIndex(projectPhotos.length - 1);
    }
  }, [projectPhotos.length, currentIndex]);
  const currentPhoto = projectPhotos[currentIndex];

  const [editing, setEditing] = useState(false);

  // Viewer chrome: photo is the content, everything else toggles off on a
  // tap of the image (standard viewer gesture).
  const [chromeVisible, setChromeVisible] = useState(true);
  // AI caption: one truncated line by default, tap to expand.
  const [captionExpanded, setCaptionExpanded] = useState(false);
  // Comments live behind the comment icon in a bottom sheet now.
  const [commentsOpen, setCommentsOpen] = useState(false);
  // Overflow (three-dots) sheet: actions + details/metadata.
  const [overflowOpen, setOverflowOpen] = useState(false);
  // "Attach to task" picker sheet.
  const [taskSheetOpen, setTaskSheetOpen] = useState(false);
  const [attachingTaskId, setAttachingTaskId] = useState<string | null>(null);
  // "New task from photo" mini-form (inside the task sheet).
  const [creatingTaskOpen, setCreatingTaskOpen] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskAssignee, setNewTaskAssignee] =
    useState<AssigneeSelection>(null);
  const [assigneePickerOpen, setAssigneePickerOpen] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [settingCover, setSettingCover] = useState(false);
  // Tag sheet: account photo-tag vocabulary is fetched on first open
  // (media rows carry tag NAMES only — colors resolve against this
  // list, case-insensitively, matching web).
  const [tagSheetOpen, setTagSheetOpen] = useState(false);
  const [accountTags, setAccountTags] = useState<BackendAccountTag[] | null>(
    null,
  );
  const [accountTagsError, setAccountTagsError] = useState(false);
  /** Tag name currently being added/removed (single-flight guard). */
  const [tagMutating, setTagMutating] = useState<string | null>(null);
  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState(SIZES[1]);
  // Per-photo EDITABLE buffer — the current user's OWN strokes, in canonical
  // (0..1) form, keyed by photo id. Seeded from the server on photo open via
  // loadPhotoAnnotations (server is source of truth). undo/clear/draw all
  // operate on this buffer; it is the payload saved back to the server.
  const [strokesById, setStrokesById] = useState<
    Record<string, StoredStroke[]>
  >({});
  // Other users' strokes, kept separate so the editor can render the full
  // union (others + own-live-buffer) without double-drawing or letting the
  // user edit collaborators' strokes.
  const [othersById, setOthersById] = useState<Record<string, StoredStroke[]>>(
    {},
  );

  // Read-mode (gallery) box. Items are absoluteFill, so a single captured
  // size applies to every sibling. NOT the coordinate basis — that's the
  // per-photo fitted image rect (readBox + intrinsic dims), matching the
  // web editor's basis.
  const [readBox, setReadBox] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });
  // Per-photo intrinsic pixel size from expo-image's onLoad, needed to
  // compute each photo's fitted rect. Until a photo's size is known its
  // annotations render NOWHERE — never against the container basis.
  const [imgDimsById, setImgDimsById] = useState<
    Record<string, { w: number; h: number }>
  >({});

  // Photos with unsaved buffer changes since the last server flush. We flush
  // on edit-mode exit (and unmount) rather than per-stroke to avoid spamming
  // the server with a request for every finger lift.
  const dirtyRef = useRef<Set<string>>(new Set());

  // Server is source of truth on open: fetch the photo's annotation rows and
  // seed the editable buffer (own) + others split for the current photo.
  const currentPhotoId = currentPhoto?.id;
  useEffect(() => {
    if (!currentPhotoId) return;
    let cancelled = false;
    void (async () => {
      const { ownStrokes, othersStrokes } =
        await loadPhotoAnnotations(currentPhotoId);
      if (cancelled) return;
      // Never let a late server response clobber unsaved local edits: if the
      // user started drawing before this fetch resolved, the photo is dirty
      // and the local buffer wins (last-write-wins for the own row). Others'
      // strokes always update — they're not user-editable here.
      if (!dirtyRef.current.has(currentPhotoId)) {
        setStrokesById((prev) => ({ ...prev, [currentPhotoId]: ownStrokes }));
      }
      setOthersById((prev) => ({ ...prev, [currentPhotoId]: othersStrokes }));
    })();
    return () => {
      cancelled = true;
    };
  }, [currentPhotoId, loadPhotoAnnotations]);

  // Flush the own-row buffer to the server when the user leaves edit mode.
  const prevEditingRef = useRef(editing);
  useEffect(() => {
    const was = prevEditingRef.current;
    prevEditingRef.current = editing;
    if (was && !editing && currentPhotoId && dirtyRef.current.has(currentPhotoId)) {
      const pid = currentPhotoId;
      void (async () => {
        // Clear dirty ONLY after the server accepts the write. On failure the
        // flag stays set so the unmount flush (or next exit) retries — the
        // edit is never silently dropped.
        const ok = await saveAnnotations(pid, strokesById[pid] ?? []);
        if (ok) {
          dirtyRef.current.delete(pid);
          // Clobber-guard merge: the server row now holds MORE than the
          // buffer (recovered strokes). Adopt the merged set so a later
          // re-edit of this photo can't re-drop them.
          if (Array.isArray(ok)) {
            setStrokesById((prev) => ({ ...prev, [pid]: ok }));
          }
        } else {
          // A failed server flush was previously 100% silent — the user
          // walked away believing their markup synced (build 40 Bug A).
          // The edit is safe locally and retries on next exit/unmount,
          // but say so.
          showToast("Markup saved on this phone — couldn't sync yet");
        }
      })();
    }
  }, [editing, currentPhotoId, saveAnnotations, strokesById]);

  // Safety net: flush any still-dirty buffers when the screen unmounts. A ref
  // holds the latest closure so the unmount-only effect sees current state.
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    for (const pid of [...dirtyRef.current]) {
      void (async () => {
        // Clear dirty per-photo only on success; a failed write leaves the
        // flag set (best-effort on unmount — there's no further retry hook,
        // but the local buffer is already persisted so nothing is lost).
        const ok = await saveAnnotations(pid, strokesById[pid] ?? []);
        if (ok) dirtyRef.current.delete(pid);
        // No setStrokesById here — the screen is unmounting; the merged
        // union was already persisted to Photo.annotations by the save.
      })();
    }
  };
  useEffect(() => () => flushRef.current(), []);

  // ----- Photo comments (display + create; no delete endpoint exists) -----
  // Keyed off the CURRENT photo's backend mediaId. Local-only photos
  // (pending/failed uploads, mediaId undefined) get no comments UI at all.
  const currentMediaId = currentPhoto?.mediaId;
  const [comments, setComments] = useState<BackendCommentResponse[] | null>(
    null, // null = loading (or not yet requested)
  );
  const [commentsError, setCommentsError] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [postingComment, setPostingComment] = useState(false);
  // Monotonic sequence guards against a slow response for photo A landing
  // after the user swiped to photo B (no stale comments from the previous
  // photo). Any newer request or photo change bumps the sequence and the
  // stale response is dropped.
  const commentsFetchSeq = useRef(0);
  // Ref mirror so async handlers can check "am I still on this photo?"
  // after an await without capturing a stale render value.
  const currentMediaIdRef = useRef(currentMediaId);
  currentMediaIdRef.current = currentMediaId;

  const loadComments = useCallback(async (mid: number) => {
    const seq = ++commentsFetchSeq.current;
    try {
      const rows = await api.getMediaComments(mid);
      if (commentsFetchSeq.current !== seq) return;
      setComments(rows);
      setCommentsError(false);
    } catch {
      if (commentsFetchSeq.current !== seq) return;
      setComments([]);
      setCommentsError(true);
    }
  }, []);

  useEffect(() => {
    // Swiped to a different photo: drop everything from the previous one
    // (list, draft, in-flight markers) and fetch fresh.
    commentsFetchSeq.current++;
    setComments(null);
    setCommentsError(false);
    setCommentDraft("");
    setPostingComment(false);
    if (currentMediaId !== undefined) void loadComments(currentMediaId);
  }, [currentMediaId, loadComments]);

  // ----- Per-entry translation (comments + AI caption) -----
  // Keys: String(comment.id) for comments, the literal "ai" for the AI
  // caption entry. The "ai" key is SHARED across photos (the caption is
  // per-photo but the key isn't), so every async path is generation-
  // guarded: a late response for the previous photo must never land on
  // the current one.
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [showingTranslation, setShowingTranslation] = useState<Set<string>>(
    () => new Set(),
  );
  const [translatingKey, setTranslatingKey] = useState<string | null>(null);
  // Holds the KEY that errored (inline "Couldn't translate." under it).
  const [translateError, setTranslateError] = useState<string | null>(null);
  // Bumped whenever the current photo changes; in-flight requests
  // capture it before awaiting and discard on mismatch — for the
  // result, the error, AND the loading-state clear.
  const translateGen = useRef(0);

  useEffect(() => {
    // Swiped to a different photo: invalidate in-flight translations
    // and drop all four state values (cache included — comment ids
    // are per-photo anyway, and "ai" must not leak across photos).
    translateGen.current++;
    setTranslations({});
    setShowingTranslation(new Set());
    setTranslatingKey(null);
    setTranslateError(null);
  }, [currentPhotoId]);

  // All state is keyed by a PHOTO-SCOPED key. The reset effect above
  // runs only after the first render that follows a swipe, so bare
  // keys (the shared "ai" literal especially) would let photo A's
  // cached translation render under photo B for one frame — and a
  // late response could repopulate the cache in that window. Scoping
  // the key by photo id makes stale entries unmatchable instead of
  // merely eventually-cleared; the generation guard + reset stay as
  // defense in depth.
  const scopedKey = useCallback(
    (key: string) => `${currentPhotoId ?? ""}:${key}`,
    [currentPhotoId],
  );

  const requestTranslation = async (rawKey: string, text: string) => {
    const key = scopedKey(rawKey);
    if (translatingKey !== null) return; // one in flight at a time
    const cached = translations[key];
    if (cached !== undefined) {
      // Toggling back to the translation — cache hit, NO repeat call.
      setShowingTranslation((prev) => new Set(prev).add(key));
      return;
    }
    const gen = translateGen.current;
    setTranslatingKey(key);
    setTranslateError(null);
    try {
      const { translation } = await api.translateText(text);
      if (translateGen.current !== gen) return;
      setTranslations((prev) => ({ ...prev, [key]: translation }));
      setShowingTranslation((prev) => new Set(prev).add(key));
    } catch {
      if (translateGen.current !== gen) return;
      setTranslateError(key);
    } finally {
      // Only clear the spinner if we're still the current generation —
      // the photo-change effect already reset it otherwise.
      if (translateGen.current === gen) setTranslatingKey(null);
    }
  };

  const showOriginal = (rawKey: string) => {
    const key = scopedKey(rawKey);
    setShowingTranslation((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  // Comment/caption body + its translate controls. Translated-and-
  // showing renders the translation IN PLACE of the original.
  // `rawKey` is the spec key ("ai" / String(comment.id)); lookups all
  // go through the photo-scoped form.
  const renderTranslatableBody = (rawKey: string, text: string) => {
    const key = scopedKey(rawKey);
    const translated = translations[key];
    const showing = translated !== undefined && showingTranslation.has(key);
    return (
      <>
        <Text style={styles.commentText}>{showing ? translated : text}</Text>
        {translatingKey === key ? (
          <Text style={styles.translateBtn}>Translating...</Text>
        ) : showing ? (
          <Text
            style={styles.translateBtn}
            onPress={() => showOriginal(rawKey)}
            accessibilityRole="button"
          >
            Show original
          </Text>
        ) : (
          <Text
            style={styles.translateBtn}
            onPress={() => void requestTranslation(rawKey, text)}
            accessibilityRole="button"
          >
            Translate
          </Text>
        )}
        {translateError === key ? (
          <Text style={styles.translateErrorTxt}>Couldn't translate.</Text>
        ) : null}
      </>
    );
  };

  const onPostComment = async () => {
    if (currentMediaId === undefined) return;
    const content = commentDraft.trim();
    if (!content || postingComment) return;
    const mid = currentMediaId;
    setPostingComment(true);
    try {
      await api.createMediaComment(mid, content);
    } catch (e) {
      setPostingComment(false);
      if (e instanceof ApiError && e.status === 401) return;
      // Keep the typed text so the user can retry.
      showToast("Couldn't post comment");
      return;
    }
    setPostingComment(false);
    // Server contract: POST returns the bare row without the joined user
    // object, so re-fetch the list instead of appending locally. Only
    // clear the draft (and refetch) if we're still on the same photo —
    // if the user swiped away mid-post the effect already reset state.
    if (currentMediaIdRef.current === mid) {
      setCommentDraft("");
      void loadComments(mid);
    }
  };

  if (!startPhoto || !currentPhoto) {
    return (
      <View style={styles.bg}>
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={{ color: "#fff", textAlign: "center", marginTop: 100 }}>
          Photo not found.
        </Text>
      </View>
    );
  }

  // Persist a buffer change locally (offline buffer + optimistic render set)
  // and mark the photo dirty for the next server flush. The local render set
  // (Photo.annotations) is the union of others + own so thumbnails / read
  // mode stay correct without waiting for the server round-trip.
  const persistLocalUnion = async (pid: string, ownNext: StoredStroke[]) => {
    dirtyRef.current.add(pid);
    const others = othersById[pid] ?? [];
    await updatePhoto(pid, { annotations: [...others, ...ownNext] });
  };

  // AnnotationEditor hands each finished stroke up already in canonical
  // 0..1 form (type from its active tool); append + persist locally.
  const commitStroke = async (canonical: StoredStroke) => {
    const pid = currentPhoto.id;
    const next = [...(strokesById[pid] ?? []), canonical];
    setStrokesById((prev) => ({ ...prev, [pid]: next }));
    await persistLocalUnion(pid, next);
  };

  // Replace one OWN stroke (matched by id) after a select-tool move. Same
  // dirty/flush pipeline as commitStroke — the exit flush PUTs the row.
  const replaceStroke = async (updated: StoredStroke) => {
    const pid = currentPhoto.id;
    const next = (strokesById[pid] ?? []).map((s) =>
      s.id === updated.id ? updated : s,
    );
    setStrokesById((prev) => ({ ...prev, [pid]: next }));
    await persistLocalUnion(pid, next);
  };

  // Delete one OWN stroke by id: own row minus that stroke, via the same
  // save path (no new API surface).
  const deleteStroke = async (id: string) => {
    const pid = currentPhoto.id;
    const next = (strokesById[pid] ?? []).filter((s) => s.id !== id);
    setStrokesById((prev) => ({ ...prev, [pid]: next }));
    await persistLocalUnion(pid, next);
  };

  const undo = async () => {
    const pid = currentPhoto.id;
    const list = strokesById[pid] ?? [];
    if (list.length === 0) return;
    const next = list.slice(0, -1);
    setStrokesById((prev) => ({ ...prev, [pid]: next }));
    await persistLocalUnion(pid, next);
  };

  const clearAll = async () => {
    const pid = currentPhoto.id;
    setStrokesById((prev) => ({ ...prev, [pid]: [] }));
    await persistLocalUnion(pid, []);
  };

  const onDelete = async () => {
    const photo = currentPhoto;
    const photoId = photo.id;
    const mediaId = photo.mediaId;

    // Server-first then local. Sequence is deliberate:
    //  1. Resolve mediaId — if the photo never uploaded (failed/pending),
    //     skip the server entirely and just do local cleanup.
    //  2. Fetch references and build the warning copy. Show spinner on
    //     the trash button only during this fetch.
    //  3. Confirm dialog (refs-aware copy).
    //  4. On confirm: DELETE /api/media/:id, THEN router.back() + local
    //     cleanup. router.back() runs even on server failure (no state
    //     drift, gallery just refetches on focus); local cleanup only
    //     runs after the server confirms.
    const doServerThenLocal = async () => {
      router.back();
      try {
        if (mediaId !== undefined) {
          await api.deleteMedia(mediaId);
        }
        await deletePhoto(photoId);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        showToast(
          e instanceof Error ? e.message : "Couldn't delete photo.",
        );
      }
    };

    // No server media row → local-only path (failed/pending upload).
    // Same UX as the previous simple-confirm flow used to be.
    if (mediaId === undefined) {
      if (Platform.OS === "web") {
        router.back();
        await deletePhoto(photoId);
        return;
      }
      Alert.alert("Delete photo?", "This will permanently remove the photo.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            router.back();
            await deletePhoto(photoId);
          },
        },
      ]);
      return;
    }

    // Server-backed path: fetch refs (with spinner), then confirm.
    setTrashLoading(true);
    let refsMessage = "";
    try {
      const refs = await api.getMediaReferences(mediaId);
      refsMessage = buildMediaReferencesMessage(refs);
    } catch (e) {
      setTrashLoading(false);
      if (e instanceof ApiError && e.status === 401) return;
      showToast(
        e instanceof Error ? e.message : "Couldn't check references.",
      );
      return;
    }
    setTrashLoading(false);

    const body = refsMessage || "This will permanently remove the photo.";
    if (Platform.OS === "web") return doServerThenLocal();
    Alert.alert("Delete photo?", body, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: doServerThenLocal },
    ]);
  };

  const onDownload = async () => {
    if (Platform.OS === "web") {
      Alert.alert(
        "Download",
        "Saving to camera roll only works on the iOS/Android build.",
      );
      return;
    }
    try {
      // writeOnly: request save-only access. Broad media-read perms were
      // stripped for Play policy; saveToLibraryAsync needs only write.
      const perm = await MediaLibrary.requestPermissionsAsync(true);
      if (perm.status !== "granted") {
        Alert.alert("Photos permission needed", "Allow access to save photos.");
        return;
      }
      await MediaLibrary.saveToLibraryAsync(currentPhoto.uri);
      Alert.alert("Saved", "Photo saved to your camera roll.");
    } catch (e) {
      Alert.alert(
        "Couldn't save",
        e instanceof Error ? e.message : "Unknown error",
      );
    }
  };

  const currentStrokeList = strokesById[currentPhoto.id] ?? [];
  const editOthers = othersById[currentPhoto.id] ?? [];

  // ----- Bottom-bar / sheet derived data -----
  const project = projects.find((p) => p.id === currentPhoto.projectId);
  const projectAddress = project?.address?.trim() || null;
  // Timestamp-overlay resolution: project override wins when non-null,
  // else the account-wide default; false when neither is known.
  const overlayEnabled =
    project?.photoOverlayEnabled ??
    accountSettings?.photoOverlayEnabled ??
    false;
  const uploaderName = currentPhoto.uploader
    ? [currentPhoto.uploader.firstName, currentPhoto.uploader.lastName]
        .filter(Boolean)
        .join(" ")
        .trim() || "Unknown user"
    : "Unknown user";
  const uploaderInitials =
    uploaderName === "Unknown user"
      ? "?"
      : uploaderName
          .split(/\s+/)
          .map((w) => w[0])
          .slice(0, 2)
          .join("")
          .toUpperCase();
  // "UNCLEAR" is an internal sentinel and must never display.
  const aiCaption =
    currentPhoto.aiCaption && currentPhoto.aiCaption !== "UNCLEAR"
      ? currentPhoto.aiCaption
      : null;
  const commentCount = comments?.length ?? 0;
  const projectTasks = tasks.filter(
    (t) => t.projectId === currentPhoto.projectId,
  );

  const onSetCover = async () => {
    const mid = currentPhoto.mediaId;
    if (mid === undefined || settingCover) return;
    setSettingCover(true);
    try {
      await api.updateProject(currentPhoto.projectId, { coverPhotoId: mid });
      setOverflowOpen(false);
      showToast("Cover photo updated");
    } catch {
      showToast("Couldn't set cover photo");
    } finally {
      setSettingCover(false);
    }
  };

  const onAttachToTask = async (taskId: string) => {
    const mid = currentPhoto.mediaId;
    if (mid === undefined || attachingTaskId) return;
    setAttachingTaskId(taskId);
    try {
      await api.attachPhotosToTask(taskId, [mid]);
      setTaskSheetOpen(false);
      showToast("Photo attached to task");
    } catch (e) {
      showToast(
        e instanceof ApiError && e.message
          ? e.message
          : "Couldn't attach photo to task",
      );
    } finally {
      setAttachingTaskId(null);
    }
  };

  /**
   * Open the tag sheet, fetching the account's photo-tag vocabulary on
   * first open (retried on demand after an error). Fetch is per-viewer
   * lifetime — the vocabulary changes rarely.
   */
  const openTagSheet = () => {
    setTagSheetOpen(true);
    if (accountTags === null || accountTagsError) void loadAccountTags();
  };

  const loadAccountTags = async () => {
    setAccountTagsError(false);
    try {
      const rows = await api.listTags("photo");
      setAccountTags(rows);
    } catch {
      setAccountTagsError(true);
    }
  };

  /** Case-insensitive tag-name → color lookup (web parity). */
  const tagColorByName = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const t of accountTags ?? []) {
      m.set(t.name.toLowerCase(), t.color ?? null);
    }
    return m;
  }, [accountTags]);

  /**
   * Add or remove one tag. PATCHes the full replacement array
   * immediately (web's no-save-button behavior), server-first: local
   * state (DataContext persist) updates only after the 200 so a failed
   * PATCH can't leave the row lying about server state.
   */
  const onToggleTag = async (name: string, add: boolean) => {
    const mid = currentPhoto.mediaId;
    if (mid === undefined || tagMutating) return;
    const current = currentPhoto.tags ?? [];
    const next = add
      ? [...current, name]
      : current.filter((t) => t.toLowerCase() !== name.toLowerCase());
    setTagMutating(name);
    try {
      const updated = await api.updateMedia(mid, { tags: next });
      await updatePhoto(currentPhoto.id, { tags: updated.tags ?? [] });
    } catch (e) {
      showToast(
        e instanceof ApiError && e.message
          ? e.message
          : add
            ? "Couldn't add tag"
            : "Couldn't remove tag",
      );
    } finally {
      setTagMutating(null);
    }
  };

  /**
   * Create a new task on this photo's project, then attach the photo to
   * it. Two server calls; if the attach fails the task still exists (it
   * was genuinely created), so the toast says exactly that instead of
   * pretending the whole thing failed.
   */
  const onCreateTaskWithPhoto = async () => {
    const mid = currentPhoto.mediaId;
    const title = newTaskTitle.trim();
    if (mid === undefined || !title || creatingTask) return;
    setCreatingTask(true);
    let created = false;
    try {
      const task = await createTask(currentPhoto.projectId, {
        title,
        assignedToId: newTaskAssignee?.userId ?? null,
        assignedToName: newTaskAssignee?.displayName,
      });
      created = true;
      await api.attachPhotosToTask(task.id, [mid]);
      setTaskSheetOpen(false);
      setCreatingTaskOpen(false);
      setNewTaskTitle("");
      setNewTaskAssignee(null);
      showToast("Task created with photo attached");
    } catch (e) {
      showToast(
        created
          ? "Task created, but attaching the photo failed"
          : e instanceof ApiError && e.message
            ? e.message
            : "Couldn't create task",
      );
      if (created) {
        // Task exists — close the form so the user doesn't re-create it.
        setTaskSheetOpen(false);
        setCreatingTaskOpen(false);
        setNewTaskTitle("");
        setNewTaskAssignee(null);
      }
    } finally {
      setCreatingTask(false);
    }
  };

  return (
    <View style={styles.bg}>
      <Stack.Screen options={{ headerShown: false }} />


      {/* Top bar — hides with the rest of the chrome on photo tap; always
          visible while editing (the annotate flow needs the exit). */}
      {chromeVisible || editing ? (
      <View style={[styles.topBar, { paddingTop: insets.top + 6 }]}>
        <Pressable
          // While annotating, X exits annotate mode back to the photo —
          // NOT the whole viewer (that was a bug: it popped to the
          // project screen mid-annotation).
          onPress={() => (editing ? setEditing(false) : router.back())}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={editing ? "Exit annotation" : "Close photo"}
          style={styles.iconBtn}
        >
          <Feather name="x" size={20} color="#fff" />
        </Pressable>
        {/* Project name — centered, tappable, navigates to the project
            (same push the global photo-search results use). Absolutely
            positioned so close/counter keep their edge alignment; inset
            leaves room for both side controls. */}
        {project ? (
          <Pressable
            onPress={() => router.push(`/project/${project.id}`)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Open project ${project.name}`}
            style={styles.topBarTitleWrap}
          >
            <Text style={styles.topBarTitle} numberOfLines={1}>
              {project.name}
            </Text>
          </Pressable>
        ) : null}
        <Text style={styles.counter}>
          {currentIndex + 1} of {projectPhotos.length}
        </Text>
      </View>
      ) : null}

      {/* Photo display — branched by edit mode.
          Read mode: react-native-awesome-gallery provides pinch-to-zoom,
          pan, swipe-to-dismiss, and horizontal pager between siblings.
          Edit mode: a single bespoke canvas with the existing raw
          responder handlers; no zoom, no pager. Render branches are
          mutually exclusive — the gallery fully unmounts on entering
          edit mode (taking its gestures with it) and remounts at
          currentIndex on exit. */}
      {editing ? (
        <AnnotationEditor
          photoUri={currentPhoto.uri}
          ownStrokes={currentStrokeList}
          othersStrokes={editOthers}
          color={color}
          onColorChange={setColor}
          size={size}
          onSizeChange={setSize}
          onCommit={(s) => void commitStroke(s)}
          onUpdateStroke={(s) => void replaceStroke(s)}
          onDeleteStroke={(id) => void deleteStroke(id)}
          onClear={() => void clearAll()}
          onDone={() => setEditing(false)}
          // Directly below the parent's persistent row 1 (30px buttons +
          // 2×6 padding = 42) plus the panel's 8px gap — same spot the
          // rows occupied when they lived inside the tools panel.
          panelTop={insets.top + 56 + 42 + 8}
        />
      ) : (
        <Gallery
          data={galleryData}
          keyExtractor={(p: Photo) => p.id}
          initialIndex={currentIndex}
          onIndexChange={(i: number) => {
            // Guard: awesome-gallery re-emits the CURRENT index when its
            // data prop re-initializes (identity churn), not just on user
            // swipes. Only a real index change may reset per-photo
            // transient UI.
            if (i === currentIndex) return;
            setCurrentIndex(i);
            // Per-photo transient UI resets on swipe.
            setCaptionExpanded(false);
          }}
          onTap={() => setChromeVisible((v) => !v)}
          onSwipeToClose={() => router.back()}
          renderItem={({
            item,
            setImageDimensions,
          }: {
            item: Photo;
            index: number;
            setImageDimensions: (d: { width: number; height: number }) => void;
          }) => {
            if (item.isVideo) {
              // Videos render through expo-video, not <Image>. Seed a
              // non-zero size after mount so the gallery's pinch/zoom math
              // doesn't treat the item as 0×0; native controls handle
              // playback.
              return (
                <View style={StyleSheet.absoluteFill}>
                  <VideoGalleryItem
                    uri={item.uri}
                    onReady={() =>
                      setImageDimensions({
                        width: readBox.w || 1,
                        height: readBox.h || 1,
                      })
                    }
                  />
                </View>
              );
            }
            return (
              <View
                style={StyleSheet.absoluteFill}
                onLayout={(e) => {
                  const w = e.nativeEvent.layout.width;
                  const h = e.nativeEvent.layout.height;
                  setReadBox((prev) =>
                    prev.w === w && prev.h === h ? prev : { w, h },
                  );
                }}
              >
                <Image
                  source={{ uri: item.uri }}
                  style={StyleSheet.absoluteFill}
                  contentFit="contain"
                  onLoad={(e) => {
                    // REQUIRED by react-native-awesome-gallery — without
                    // this its zoom math treats the image as 0×0 and
                    // pinch breaks. expo-image's onLoad gives us the
                    // intrinsic pixel size of the source. Also captured
                    // per-photo to compute the fitted-rect annotation
                    // basis below.
                    const w = e.source?.width;
                    const h = e.source?.height;
                    if (w && h) {
                      setImageDimensions({ width: w, height: h });
                      setImgDimsById((prev) =>
                        prev[item.id]?.w === w && prev[item.id]?.h === h
                          ? prev
                          : { ...prev, [item.id]: { w, h } },
                      );
                    }
                  }}
                />
                {/* Read mode renders the photo's UNION render set
                    (item.annotations = others + own) via the shared
                    memoized layer — all six stroke types, denormalized
                    against this photo's FITTED IMAGE RECT (web-parity
                    basis), not the container. The gallery wraps
                    renderItem in an Animated.View whose transform is
                    [translateX, translateY, scale]; both the Image AND
                    this layer are inside that wrapper, so pinch/pan
                    scales them together — annotations stay pinned to
                    their photo pixels at every zoom level. Until the
                    intrinsic size arrives, render nothing rather than
                    a frame in the wrong basis. */}
                {(() => {
                  const dims = imgDimsById[item.id];
                  const rect = dims
                    ? fittedContainRect(readBox.w, readBox.h, dims.w, dims.h)
                    : null;
                  if (!rect) return null;
                  return (
                    <View
                      pointerEvents="none"
                      style={{
                        position: "absolute",
                        left: rect.x,
                        top: rect.y,
                        width: rect.w,
                        height: rect.h,
                      }}
                    >
                      <AnnotationLayer
                        strokes={item.annotations ?? []}
                        width={rect.w}
                        height={rect.h}
                      />
                      {/* Timestamp overlay — part of the PHOTO, not the
                          chrome: rendered inside the fitted image rect
                          (and the gallery's zoom transform), so it stays
                          visible when chrome is hidden and stays pinned
                          to the photo's top-right corner while pinching.
                          Procore-style: thin white text, no background,
                          shadow for legibility. Pure View overlay; upload
                          pixels are untouched. */}
                      {overlayEnabled ? (
                        <View
                          style={styles.timestampOverlay}
                          pointerEvents="none"
                        >
                          <Text style={styles.timestampOverlayText}>
                            {formatCommentDate(item.takenAt)}
                          </Text>
                          {(projectAddress
                            ? projectAddress
                                .split(",")
                                .map((part) => part.trim())
                                .filter((part) => part.length > 0)
                            : []
                          ).map((line, idx) => (
                            <Text
                              key={idx}
                              style={styles.timestampOverlayText}
                              numberOfLines={1}
                            >
                              {line}
                            </Text>
                          ))}
                        </View>
                      ) : null}
                    </View>
                  );
                })()}
              </View>
            );
          }}
        />
      )}

      {/* Tools panel (top-left) — edit mode only. Read-mode entry points
          moved to the bottom action bar (draw) and the overflow sheet
          (save / delete). Row height is unchanged so AnnotationEditor's
          panelTop math still lines up. */}
      {editing ? (
        <View style={[styles.toolsPanel, { top: insets.top + 56 }]}>
          <View style={styles.toolRow}>
            <ToolButton
              active={editing}
              onPress={() => setEditing((v) => !v)}
              icon="edit-2"
              disabled={currentPhoto?.isVideo}
              label="Stop drawing"
            />
            <ToolButton
              onPress={undo}
              icon="rotate-ccw"
              disabled={currentStrokeList.length === 0}
              label="Undo last stroke"
            />
          </View>
          {/* Edit-mode rows (colors / sizes / clear / save + tool scaffold)
              now render inside AnnotationEditor, absolutely positioned to
              the same spot below this row. */}
        </View>
      ) : null}

      {/* Compact bottom bar — overlaid chrome, hidden with the rest of
          the chrome on photo tap and while editing. */}
      {!editing && chromeVisible ? (
        <View
          style={[styles.bottomBar, { paddingBottom: insets.bottom + 10 }]}
        >
          {/* Line 1: uploader + date/time; project address replaces the
              old raw-GPS line (coordinates live in the overflow sheet). */}
          <View style={styles.metaRow}>
            <View style={styles.uploaderAvatar}>
              <Text style={styles.uploaderInitials}>{uploaderInitials}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.uploaderName} numberOfLines={1}>
                {uploaderName}
                {currentPhoto.takenAt ? (
                  <Text style={styles.metaDate}>
                    {"   "}
                    {formatCommentDate(currentPhoto.takenAt)}
                  </Text>
                ) : null}
              </Text>
              {projectAddress ? (
                <Text style={styles.metaAddress} numberOfLines={1}>
                  {projectAddress}
                </Text>
              ) : null}
            </View>
          </View>

          {/* Line 2: AI caption, one truncated line, tap to expand. */}
          {aiCaption ? (
            <Pressable
              onPress={() => setCaptionExpanded((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel={
                captionExpanded ? "Collapse AI caption" : "Expand AI caption"
              }
            >
              {/* Compact AI attribution — same identity as the comments
                  sheet ("Field View AI" + orange zap), inline instead of
                  a full author row. */}
              <View style={styles.captionRow}>
                <View style={styles.aiAvatar}>
                  <Feather name="zap" size={10} color="#fff" />
                </View>
                <Text
                  style={[styles.captionLine, { flex: 1 }]}
                  numberOfLines={captionExpanded ? undefined : 1}
                >
                  <Text style={styles.captionAiLabel}>Field View AI{"  "}</Text>
                  {aiCaption}
                </Text>
              </View>
            </Pressable>
          ) : null}

          {/* Line 3: single icon row. Tag has no existing per-photo
              implementation on mobile, so no tag icon (no stubs). */}
          <View style={styles.actionRow}>
            <BarIcon
              icon="message-circle"
              label="Comments"
              disabled={currentMediaId === undefined}
              badge={commentCount > 0 ? commentCount : undefined}
              onPress={() => setCommentsOpen(true)}
            />
            <BarIcon
              icon="edit-2"
              label="Draw on photo"
              disabled={currentPhoto.isVideo}
              onPress={() => setEditing(true)}
            />
            <BarIcon
              icon="check-square"
              label="Attach to task"
              disabled={currentMediaId === undefined}
              onPress={() => setTaskSheetOpen(true)}
            />
            <BarIcon
              icon="tag"
              label="Edit tags"
              disabled={currentMediaId === undefined}
              badge={
                currentPhoto.tags && currentPhoto.tags.length > 0
                  ? currentPhoto.tags.length
                  : undefined
              }
              onPress={openTagSheet}
            />
            <View style={{ flex: 1 }} />
            <BarIcon
              icon="more-horizontal"
              label="More options"
              onPress={() => setOverflowOpen(true)}
            />
          </View>
        </View>
      ) : null}

      {/* Comments sheet — thread + AI caption + composer, behind the
          comment icon. Never rendered for local-only photos (no media
          row to comment on; the icon is disabled). */}
      <AppSheet
        open={commentsOpen}
        onClose={() => setCommentsOpen(false)}
        keyboard
        snapPoints={SNAP_COMMENTS}
      >
              <View style={styles.sheetHeader}>
                <Text style={styles.sheetTitle}>Comments</Text>
                <Pressable
                  onPress={() => setCommentsOpen(false)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="Close comments"
                >
                  <Feather name="x" size={20} color="#fff" />
                </Pressable>
              </View>

              <ScrollView
                style={styles.sheetScroll}
                keyboardShouldPersistTaps="handled"
              >
                {/* AI caption — pinned above human comments, matching
                    web. "UNCLEAR" is an internal sentinel and must
                    never display. No timestamp, no edit/delete. */}
                {aiCaption ? (
                  <View style={styles.commentItem}>
                    <View style={styles.aiAuthorRow}>
                      <View style={styles.aiAvatar}>
                        <Feather name="zap" size={10} color="#fff" />
                      </View>
                      <Text style={styles.commentAuthor}>Field View AI</Text>
                    </View>
                    {renderTranslatableBody("ai", aiCaption)}
                  </View>
                ) : null}
                {comments === null ? (
                  <ActivityIndicator
                    size="small"
                    color="#f09004"
                    style={{ alignSelf: "flex-start", marginVertical: 6 }}
                  />
                ) : commentsError ? (
                  <Text style={styles.commentEmpty}>
                    Couldn't load comments.
                  </Text>
                ) : comments.length === 0 ? (
                  <Text style={styles.commentEmpty}>No comments yet.</Text>
                ) : (
                  comments.map((c) => (
                    <View key={c.id} style={styles.commentItem}>
                      <View style={styles.commentTopRow}>
                        <Text style={styles.commentAuthor}>
                          {commentAuthorName(c)}
                        </Text>
                        <Text style={styles.commentDate}>
                          {formatCommentDate(c.createdAt)}
                        </Text>
                      </View>
                      {renderTranslatableBody(String(c.id), c.content)}
                    </View>
                  ))
                )}
              </ScrollView>

              {currentMediaId !== undefined ? (
                <View style={styles.commentInputRow}>
                  <BottomSheetTextInput
                    value={commentDraft}
                    onChangeText={setCommentDraft}
                    placeholder="Add Comment"
                    placeholderTextColor="rgba(255,255,255,0.45)"
                    style={styles.commentInput}
                    multiline
                    editable={!postingComment}
                    accessibilityLabel="Add Comment"
                  />
                  <Pressable
                    onPress={() => void onPostComment()}
                    disabled={
                      postingComment || commentDraft.trim().length === 0
                    }
                    accessibilityRole="button"
                    accessibilityLabel="Post comment"
                    accessibilityState={{
                      disabled:
                        postingComment || commentDraft.trim().length === 0,
                      busy: postingComment,
                    }}
                    style={[
                      styles.commentPostBtn,
                      {
                        opacity:
                          postingComment || commentDraft.trim().length === 0
                            ? 0.5
                            : 1,
                      },
                    ]}
                  >
                    {postingComment ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Feather name="send" size={16} color="#fff" />
                    )}
                  </Pressable>
                </View>
              ) : null}
      </AppSheet>

      {/* Overflow sheet — actions + full details (incl. raw coordinates).
          "Move to project" has no existing implementation (no API), so it
          is intentionally absent rather than stubbed. */}
      <AppSheet
        open={overflowOpen}
        onClose={() => setOverflowOpen(false)}
        snapPoints={SNAP_OVERFLOW}
      >
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Options</Text>
              <Pressable
                onPress={() => setOverflowOpen(false)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Close options"
              >
                <Feather name="x" size={20} color="#fff" />
              </Pressable>
            </View>

            <ScrollView style={styles.sheetScroll}>
              <SheetAction
                icon="download"
                label="Save to device"
                onPress={() => {
                  setOverflowOpen(false);
                  void onDownload();
                }}
              />
              {currentMediaId !== undefined ? (
                <SheetAction
                  icon="image"
                  label="Set as cover photo"
                  busy={settingCover}
                  onPress={() => void onSetCover()}
                />
              ) : null}
              <SheetAction
                icon="trash-2"
                label="Delete photo"
                tint="#ef4444"
                busy={trashLoading}
                onPress={() => {
                  setOverflowOpen(false);
                  void onDelete();
                }}
              />

              <Text style={styles.detailsHeader}>Details</Text>
              {currentPhoto.takenAt ? (
                <DetailRow
                  label="Taken"
                  value={new Date(currentPhoto.takenAt).toLocaleString()}
                />
              ) : null}
              <DetailRow label="Uploaded by" value={uploaderName} />
              {projectAddress ? (
                <DetailRow label="Address" value={projectAddress} />
              ) : null}
              {currentPhoto.latitude != null &&
              currentPhoto.longitude != null ? (
                <DetailRow
                  label="Coordinates"
                  value={`${currentPhoto.latitude.toFixed(5)}, ${currentPhoto.longitude.toFixed(5)}`}
                />
              ) : null}
              {currentPhoto.accuracy != null ? (
                <DetailRow
                  label="GPS accuracy"
                  value={`±${Math.round(currentPhoto.accuracy)} m`}
                />
              ) : null}
              {currentPhoto.note ? (
                <DetailRow label="Caption" value={currentPhoto.note} />
              ) : null}
              {currentPhoto.tags && currentPhoto.tags.length > 0 ? (
                <DetailRow
                  label="Tags"
                  value={currentPhoto.tags.join(", ")}
                />
              ) : null}
            </ScrollView>
      </AppSheet>

      {/* Attach-to-task sheet — existing attachPhotosToTask API. */}
      <AppSheet
        open={taskSheetOpen}
        onClose={() => setTaskSheetOpen(false)}
        keyboard
        snapPoints={SNAP_TASK}
      >
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>
                {creatingTaskOpen ? "New task from photo" : "Add to task"}
              </Text>
              <Pressable
                onPress={() => setTaskSheetOpen(false)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Close task picker"
              >
                <Feather name="x" size={20} color="#fff" />
              </Pressable>
            </View>
            {creatingTaskOpen ? (
              <View style={{ gap: 10, paddingBottom: 4 }}>
                <BottomSheetTextInput
                  value={newTaskTitle}
                  onChangeText={setNewTaskTitle}
                  placeholder="Task title"
                  placeholderTextColor="rgba(255,255,255,0.45)"
                  style={styles.newTaskInput}
                  editable={!creatingTask}
                  autoFocus
                  accessibilityLabel="Task title"
                />
                <Pressable
                  onPress={() => setAssigneePickerOpen(true)}
                  disabled={creatingTask}
                  accessibilityRole="button"
                  accessibilityLabel="Assign to"
                  style={styles.newTaskAssigneeRow}
                >
                  <Feather
                    name={newTaskAssignee ? "user" : "user-x"}
                    size={16}
                    color="rgba(255,255,255,0.7)"
                  />
                  <Text style={styles.newTaskAssigneeTxt}>
                    {newTaskAssignee
                      ? newTaskAssignee.displayName
                      : "Unassigned"}
                  </Text>
                  <Feather
                    name="chevron-right"
                    size={16}
                    color="rgba(255,255,255,0.5)"
                  />
                </Pressable>
                <View style={{ flexDirection: "row", gap: 10 }}>
                  <Pressable
                    onPress={() => setCreatingTaskOpen(false)}
                    disabled={creatingTask}
                    accessibilityRole="button"
                    accessibilityLabel="Back to task list"
                    style={[styles.newTaskBtn, styles.newTaskBtnGhost]}
                  >
                    <Text style={styles.newTaskBtnGhostTxt}>Back</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void onCreateTaskWithPhoto()}
                    disabled={creatingTask || !newTaskTitle.trim()}
                    accessibilityRole="button"
                    accessibilityLabel="Create task and attach photo"
                    accessibilityState={{
                      disabled: creatingTask || !newTaskTitle.trim(),
                      busy: creatingTask,
                    }}
                    style={[
                      styles.newTaskBtn,
                      styles.newTaskBtnPrimary,
                      {
                        opacity:
                          creatingTask || !newTaskTitle.trim() ? 0.5 : 1,
                      },
                    ]}
                  >
                    {creatingTask ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Text style={styles.newTaskBtnPrimaryTxt}>
                        Create & attach
                      </Text>
                    )}
                  </Pressable>
                </View>
              </View>
            ) : (
            <ScrollView style={styles.sheetScroll}>
              <Pressable
                onPress={() => setCreatingTaskOpen(true)}
                disabled={attachingTaskId !== null}
                accessibilityRole="button"
                accessibilityLabel="Create new task from this photo"
                style={styles.taskRow}
              >
                <Feather name="plus-circle" size={16} color="#f09004" />
                <Text style={[styles.taskTitle, { color: "#f09004" }]}>
                  New task…
                </Text>
              </Pressable>
              {projectTasks.length === 0 ? (
                <Text style={styles.commentEmpty}>
                  No tasks in this project yet.
                </Text>
              ) : (
                projectTasks.map((t) => (
                  <Pressable
                    key={t.id}
                    onPress={() => void onAttachToTask(t.id)}
                    disabled={attachingTaskId !== null}
                    accessibilityRole="button"
                    accessibilityLabel={`Attach photo to ${t.title}`}
                    style={[
                      styles.taskRow,
                      {
                        opacity:
                          attachingTaskId !== null &&
                          attachingTaskId !== t.id
                            ? 0.5
                            : 1,
                      },
                    ]}
                  >
                    <Feather
                      name={t.done ? "check-circle" : "circle"}
                      size={16}
                      color={t.done ? "#4ade80" : "rgba(255,255,255,0.6)"}
                    />
                    <Text style={styles.taskTitle} numberOfLines={1}>
                      {t.title}
                    </Text>
                    {attachingTaskId === t.id ? (
                      <ActivityIndicator size="small" color="#f09004" />
                    ) : null}
                  </Pressable>
                ))
              )}
            </ScrollView>
            )}
      </AppSheet>

      {/* Tag sheet — current tags (X to remove) + account photo-type
          vocabulary to add. Every change PATCHes immediately (no save
          button, web parity). Colors resolve from the account tag list,
          case-insensitively; null color = default neutral chip. */}
      <AppSheet
        open={tagSheetOpen}
        onClose={() => setTagSheetOpen(false)}
        snapPoints={SNAP_TAG}
      >
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Tags</Text>
              <Pressable
                onPress={() => setTagSheetOpen(false)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Close tags"
              >
                <Feather name="x" size={20} color="#fff" />
              </Pressable>
            </View>
            <ScrollView
              style={styles.sheetScroll}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={styles.detailsHeader}>On this photo</Text>
              {(currentPhoto.tags?.length ?? 0) === 0 ? (
                <Text style={styles.commentEmpty}>No tags yet.</Text>
              ) : (
                <View style={styles.tagWrap}>
                  {(currentPhoto.tags ?? []).map((name) => (
                    <TagChip
                      key={name}
                      name={name}
                      color={tagColorByName.get(name.toLowerCase()) ?? null}
                      removable
                      busy={tagMutating === name}
                      disabled={tagMutating !== null}
                      onPress={() => void onToggleTag(name, false)}
                    />
                  ))}
                </View>
              )}

              <Text style={styles.detailsHeader}>Add tag</Text>
              {accountTags === null && !accountTagsError ? (
                <ActivityIndicator
                  size="small"
                  color="#f09004"
                  style={{ alignSelf: "flex-start", marginVertical: 6 }}
                />
              ) : accountTagsError ? (
                <Pressable
                  onPress={() => void loadAccountTags()}
                  accessibilityRole="button"
                  accessibilityLabel="Retry loading tags"
                >
                  <Text style={styles.commentEmpty}>
                    Couldn't load tags. Tap to retry.
                  </Text>
                </Pressable>
              ) : (
                (() => {
                  const applied = new Set(
                    (currentPhoto.tags ?? []).map((t) => t.toLowerCase()),
                  );
                  const available = (accountTags ?? []).filter(
                    (t) => !applied.has(t.name.toLowerCase()),
                  );
                  return available.length === 0 ? (
                    <Text style={styles.commentEmpty}>
                      {applied.size > 0
                        ? "All account tags applied."
                        : "No photo tags in this account yet."}
                    </Text>
                  ) : (
                    <View style={styles.tagWrap}>
                      {available.map((t) => (
                        <TagChip
                          key={String(t.id)}
                          name={t.name}
                          color={t.color ?? null}
                          busy={tagMutating === t.name}
                          disabled={tagMutating !== null}
                          onPress={() => void onToggleTag(t.name, true)}
                        />
                      ))}
                    </View>
                  );
                })()
              )}
            </ScrollView>
      </AppSheet>

      {/* Assignee picker for the new-task form (sibling sheet). */}
      <AssigneePickerSheet
        visible={assigneePickerOpen}
        projectId={currentPhoto.projectId}
        selectedUserId={newTaskAssignee?.userId ?? null}
        onClose={() => setAssigneePickerOpen(false)}
        onSelect={setNewTaskAssignee}
      />
    </View>
  );
}

/**
 * Zero-dim backdrop: fully transparent (the photo stays undimmed) but
 * still tappable, preserving the tap-outside-to-dismiss behavior the
 * old Modal backdrops had.
 */
function ClearBackdrop(props: BottomSheetBackdropProps) {
  return (
    <BottomSheetBackdrop
      {...props}
      appearsOnIndex={0}
      disappearsOnIndex={-1}
      opacity={0}
      pressBehavior="close"
    />
  );
}

/**
 * Shared presentation wrapper for every sheet in this screen —
 * @gorhom/bottom-sheet modal: spring physics, grab handle,
 * drag-to-dismiss, dynamic content sizing, no backdrop dim.
 *
 * `open` stays the single source of truth in the parent; drag/backdrop
 * dismissals sync back through onDismiss.
 *
 * `keyboard` enables interactive keyboard handling for sheets with a
 * composer (must pair with BottomSheetTextInput inside) — this replaces
 * the KeyboardAvoidingView the old Modals used.
 */
function AppSheet({
  open,
  onClose,
  keyboard,
  snapPoints,
  children,
}: {
  open: boolean;
  onClose: () => void;
  keyboard?: boolean;
  snapPoints: string[];
  children: React.ReactNode;
}) {
  const ref = useRef<BottomSheetModal>(null);
  // Only call dismiss() while the modal is actually presented. gorhom's
  // dismiss() does not early-exit from MODAL_STATUS.INITIAL, so a redundant
  // dismiss on a non-presented modal (on mount, or in the echo after
  // onDismiss already ran and reset gorhom to INITIAL) wedges it in
  // DISMISSING and permanently blocks the next present(). Track "currently
  // presented" and clear it in onDismiss so the post-close effect echo skips.
  const presentedRef = useRef(false);
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (open) {
      presentedRef.current = true;
      ref.current?.present();
    } else if (presentedRef.current) {
      presentedRef.current = false;
      ref.current?.dismiss();
    }
  }, [open]);
  return (
    <BottomSheetModal
      ref={ref}
      onDismiss={() => {
        presentedRef.current = false;
        onClose();
      }}
      enablePanDownToClose
      snapPoints={snapPoints}
      enableDynamicSizing={false}
      backgroundStyle={styles.sheetBg}
      handleIndicatorStyle={styles.sheetHandle}
      backdropComponent={ClearBackdrop}
      keyboardBehavior={keyboard ? "interactive" : "extend"}
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
    >
      <BottomSheetView
        style={[styles.sheetBody, { paddingBottom: insets.bottom + 8 }]}
      >
        {children}
      </BottomSheetView>
    </BottomSheetModal>
  );
}

function BarIcon({
  icon,
  label,
  onPress,
  disabled,
  badge,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  badge?: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={[styles.barIconBtn, { opacity: disabled ? 0.35 : 1 }]}
    >
      <Feather name={icon} size={20} color="#fff" />
      {badge !== undefined ? (
        <View style={styles.barBadge}>
          <Text style={styles.barBadgeTxt}>{badge > 99 ? "99+" : badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * Tag pill. Web's colored-tag treatment: tinted background, tinted
 * border, full-strength text in the tag's color. Null color (legacy
 * account_tags rows) = neutral default. `removable` renders the X.
 */
function TagChip({
  name,
  color,
  removable,
  busy,
  disabled,
  onPress,
}: {
  name: string;
  color: string | null;
  removable?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const tinted = !!color;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={removable ? `Remove tag ${name}` : `Add tag ${name}`}
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      style={[
        styles.tagChip,
        tinted
          ? {
              // 0x26 ≈ 15% bg tint, 0x80 = 50% border tint; text stays
              // full-strength (web parity).
              backgroundColor: `${color}26`,
              borderColor: `${color}80`,
            }
          : null,
        { opacity: disabled && !busy ? 0.5 : 1 },
      ]}
    >
      {!removable ? (
        <Feather
          name="plus"
          size={12}
          color={tinted ? color! : "rgba(255,255,255,0.7)"}
        />
      ) : null}
      <Text
        style={[styles.tagChipTxt, tinted ? { color: color! } : null]}
        numberOfLines={1}
      >
        {name}
      </Text>
      {busy ? (
        <ActivityIndicator size="small" color={tinted ? color! : "#f09004"} />
      ) : removable ? (
        <Feather
          name="x"
          size={12}
          color={tinted ? color! : "rgba(255,255,255,0.7)"}
        />
      ) : null}
    </Pressable>
  );
}

function SheetAction({
  icon,
  label,
  onPress,
  tint,
  busy,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress: () => void;
  tint?: string;
  busy?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!busy, busy: !!busy }}
      style={styles.sheetActionRow}
    >
      <Feather name={icon} size={18} color={tint ?? "#fff"} />
      <Text style={[styles.sheetActionTxt, tint ? { color: tint } : null]}>
        {label}
      </Text>
      {busy ? (
        <ActivityIndicator size="small" color={tint ?? "#f09004"} />
      ) : null}
    </Pressable>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

/** Author display name; the `user` join is absent for deleted authors. */
function commentAuthorName(c: BackendCommentResponse): string {
  const name = [c.user?.firstName, c.user?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || "Deleted user";
}

/**
 * "Jul 23, 2026, 5:29 PM" in device-local time — matches the format the
 * web comments UI uses.
 */
function formatCommentDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ToolButton({
  icon,
  onPress,
  active,
  disabled,
  tint,
  label,
}: {
  icon: keyof typeof Feather.glyphMap;
  onPress: () => void;
  active?: boolean;
  disabled?: boolean;
  tint?: string;
  label: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
      style={[
        styles.toolBtn,
        {
          backgroundColor: active ? "#F09001" : "transparent",
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      <Feather
        name={icon}
        size={16}
        color={active ? "#111" : tint || "#111"}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: "#000" },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 8,
    zIndex: 10,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  topBarTitleWrap: {
    position: "absolute",
    left: 64,
    right: 64,
    bottom: 8,
    alignItems: "center",
  },
  topBarTitle: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  captionRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
  },
  captionAiLabel: {
    color: "#f09004",
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  counter: {
    color: "rgba(255,255,255,0.85)",
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    backgroundColor: "rgba(0,0,0,0.45)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 100,
    overflow: "hidden",
  },
  toolsPanel: {
    position: "absolute",
    left: 12,
    gap: 8,
    zIndex: 20,
  },
  toolRow: {
    flexDirection: "row",
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 8,
    alignItems: "center",
  },
  toolBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 16,
    paddingTop: 10,
    gap: 8,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  uploaderAvatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#f09004",
    alignItems: "center",
    justifyContent: "center",
  },
  uploaderInitials: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  uploaderName: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  metaDate: {
    color: "rgba(255,255,255,0.65)",
    fontFamily: "Inter_400Regular",
    fontSize: 12,
  },
  metaAddress: {
    color: "rgba(255,255,255,0.65)",
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    marginTop: 1,
  },
  captionLine: {
    color: "#fff",
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 18,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  barIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  barBadge: {
    position: "absolute",
    top: -4,
    right: -4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: "#f09004",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 3,
  },
  barBadgeTxt: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
  },
  // Sheet chrome lives on the BottomSheetModal itself (bg + handle);
  // sheetBody is the content container inside it.
  timestampOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    paddingHorizontal: 10,
    paddingVertical: 8,
    alignItems: "flex-end",
  },
  timestampOverlayText: {
    color: "#fff",
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "300",
    textAlign: "right",
    textShadowColor: "rgba(0,0,0,0.75)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 5,
  },
  sheetBg: {
    backgroundColor: "#1c1c1e",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  sheetHandle: {
    backgroundColor: "rgba(255,255,255,0.35)",
    width: 36,
  },
  sheetBody: {
    paddingHorizontal: 16,
    paddingTop: 2,
  },
  sheetHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  sheetTitle: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
  },
  sheetScroll: {
    maxHeight: 380,
  },
  sheetActionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.15)",
  },
  sheetActionTxt: {
    color: "#fff",
    fontFamily: "Inter_500Medium",
    fontSize: 14,
    flex: 1,
  },
  tagWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingVertical: 4,
  },
  tagChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
    backgroundColor: "rgba(255,255,255,0.08)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    maxWidth: "100%",
  },
  tagChipTxt: {
    color: "#fff",
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    flexShrink: 1,
  },
  newTaskInput: {
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
    color: "#fff",
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  newTaskAssigneeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  newTaskAssigneeTxt: {
    color: "#fff",
    fontFamily: "Inter_500Medium",
    fontSize: 14,
    flex: 1,
  },
  newTaskBtn: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  newTaskBtnGhost: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
  },
  newTaskBtnGhostTxt: {
    color: "#fff",
    fontFamily: "Inter_500Medium",
    fontSize: 14,
  },
  newTaskBtnPrimary: {
    backgroundColor: "#f09004",
  },
  newTaskBtnPrimaryTxt: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  detailsHeader: {
    color: "rgba(255,255,255,0.6)",
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: 16,
    marginBottom: 4,
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 16,
    paddingVertical: 6,
  },
  detailLabel: {
    color: "rgba(255,255,255,0.6)",
    fontFamily: "Inter_400Regular",
    fontSize: 13,
  },
  detailValue: {
    color: "#fff",
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    flexShrink: 1,
    textAlign: "right",
  },
  taskRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.15)",
  },
  taskTitle: {
    color: "#fff",
    fontFamily: "Inter_500Medium",
    fontSize: 14,
    flex: 1,
  },
  commentEmpty: {
    color: "rgba(255,255,255,0.6)",
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    marginVertical: 4,
  },
  commentItem: {
    marginBottom: 8,
  },
  commentTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 8,
  },
  commentAuthor: {
    color: "#f09004",
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    flexShrink: 1,
  },
  commentDate: {
    color: "rgba(255,255,255,0.55)",
    fontFamily: "Inter_400Regular",
    fontSize: 11,
  },
  commentText: {
    color: "#fff",
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    marginTop: 2,
  },
  aiAuthorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  aiAvatar: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "#f09004",
    alignItems: "center",
    justifyContent: "center",
  },
  translateBtn: {
    color: "rgba(255,255,255,0.55)",
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    marginTop: 4,
    alignSelf: "flex-start",
  },
  translateErrorTxt: {
    color: "#ff6b6b",
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    marginTop: 2,
  },
  commentInputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.25)",
  },
  commentInput: {
    flex: 1,
    color: "#fff",
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
    maxHeight: 90,
  },
  commentPostBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#f09004",
    alignItems: "center",
    justifyContent: "center",
  },
});
