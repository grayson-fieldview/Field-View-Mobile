import { Feather } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as FileSystem from "expo-file-system/legacy";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import * as MediaLibrary from "expo-media-library";
import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import {
  runOnJS,
  useAnimatedReaction,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Sentry from "@sentry/react-native";

import { Button } from "@/components/Button";
import { LetterboxOverlay } from "@/components/LetterboxOverlay";
import { useAuth } from "@/contexts/AuthContext";
import { useData } from "@/contexts/DataContext";
import { useColors } from "@/hooks/useColors";
import {
  api,
  ApiError,
  type BackendCommentResponse,
} from "@/services/api";
import { useUploadStatus } from "@/contexts/UploadStatusContext";
import {
  cropToAspectRatio,
  DEFAULT_PHOTO_ASPECT_RATIO,
  prepareForUpload,
} from "@/services/imageProcessing";
import {
  classifyUploadFailure,
  retryItem as retryUploadQueueItem,
} from "@/services/uploadQueue";
import type { Photo } from "@/services/types";
import { storage } from "@/services/storage";
import {
  cancelRecording as cancelWtRecording,
  requestPermission as requestWtMicPermission,
  startRecording as startWtRecording,
  stopRecording as stopWtRecording,
} from "@/services/voiceRecording";
import { isModuleUnavailableError } from "@/services/voiceRecordingErrors";
import {
  WalkthroughDoneSheet,
  type WalkthroughSessionPhoto,
} from "@/components/WalkthroughDoneSheet";

const HOLD_TO_BURST_MS = 350;

// Video capture caps to keep clips under the 500MB server upload limit.
// Capture is pinned to 1080p (see CameraView `videoQuality`); ~180s at 1080p
// stays comfortably under 500MB worst-case. Duration is the UX cap; the byte
// cap below is the true hard limit.
const MAX_RECORDING_SECONDS = 180;
// Hard byte backstop via recordAsync `maxFileSize`. Honored natively on BOTH
// iOS (videoFileOutput.maxRecordedFileSize) and Android. 450 MiB = 471,859,200
// bytes, which stays under the 500MB cap whether the server measures it as
// 500 MiB (524,288,000) or decimal 500,000,000 bytes.
const MAX_RECORDING_BYTES = 450 * 1024 * 1024;

// ---- Walkthrough mode ----
// Hard cap for the CONTINUOUS narration recording (walkthrough only —
// voice notes elsewhere stay at 5 minutes). Enforced with a single
// ABSOLUTE setTimeout from the recording start, never tick counting.
const WT_MAX_MS = 15 * 60 * 1000;
// Narration turns warning-colored near the cap.
const WT_WARN_MS = 13 * 60 * 1000;
// First-run explainer seen-flag. Follows the repo's `@fv/` AsyncStorage
// key convention (see services/storage.ts KEYS and
// services/legacyTaskCleanup.ts CLEANUP_FLAG).
const WT_INTRO_FLAG = "@fv/walkthrough/intro_seen_v1";

type ZoomPreset = { label: string; value: number };
// No anchor above 4x, so pinch never zooms past the top preset's value.
const PINCH_MAX_ZOOM = 0.45;
const ZOOM_PRESETS: ZoomPreset[] = [
  { label: ".5x", value: 0 },
  { label: "1x", value: 0.05 },
  { label: "4x", value: 0.45 },
];
// Multiplier anchors derived from the presets (0→0.5, 0.05→1, 0.45→4).
// parseFloat(".5x") === 0.5, etc.
const ZOOM_ANCHORS = ZOOM_PRESETS.map((p) => ({
  value: p.value,
  mult: parseFloat(p.label),
}));
// Piecewise-linear interpolation of a CameraView zoom (0..0.45) to the
// user-facing multiplier. Returns a number ("1.4", not "1.4x").
function zoomToLabel(z: number): number {
  const a = ZOOM_ANCHORS;
  if (z <= a[0]!.value) return a[0]!.mult;
  for (let i = 1; i < a.length; i++) {
    const lo = a[i - 1]!;
    const hi = a[i]!;
    if (z <= hi.value) {
      const t = (z - lo.value) / (hi.value - lo.value);
      return lo.mult + t * (hi.mult - lo.mult);
    }
  }
  return a[a.length - 1]!.mult;
}
// One decimal, trailing ".0" stripped, leading "0" stripped to match the
// preset labels (".5x" not "0.5x"): 1.4 → "1.4", 2 → "2", 0.5 → ".5".
function formatZoomMult(m: number): string {
  let s = m.toFixed(1);
  if (s.endsWith(".0")) s = s.slice(0, -2);
  if (s.startsWith("0.")) s = s.slice(1);
  return s;
}

// prepareForUpload + PreparedUpload moved to services/imageProcessing so
// the project gallery's add-from-camera-roll flow shares the exact same
// upload preparation pipeline (no forked implementations).

export default function CaptureScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { projectId, checklistItemId, taskId } = useLocalSearchParams<{
    projectId: string;
    /**
     * Optional. When set, every photo captured (single shot OR burst) in
     * this session is auto-attached to the named checklist item once it
     * finishes uploading. Forwarded into the upload-queue entries so the
     * post-upload tagger calls api.attachPhotoToItem on success.
     */
    checklistItemId?: string;
    /**
     * Optional task attach target — mirror of checklistItemId. Set by
     * the task photos sheet's "Take new photo"; every photo captured in
     * this session auto-attaches to the task after upload.
     */
    taskId?: string;
  }>();
  const { projects, photos, addPhoto, addPhotosBatch } = useData();
  const { accountSettings } = useAuth();
  const project = projects.find((p) => p.id === projectId);

  // Account-wide default capture aspect ratio (S3y, admin-managed
  // via /api/account/settings). Falls back to "4:3" while the
  // settings fetch is in flight or has failed — better to ship a
  // photo at the wrong ratio than to block the camera. Read on every
  // render rather than memoized so admins flipping the setting from
  // another device see new captures honor the change immediately on
  // next foreground refresh.
  const captureAspectRatio =
    accountSettings?.defaultPhotoAspectRatio ?? DEFAULT_PHOTO_ASPECT_RATIO;

  const [permission, requestPermission] = useCameraPermissions();
  const [locationGranted, setLocationGranted] = useState<boolean | null>(null);
  const [locationCoord, setLocationCoord] = useState<
    Pick<Photo, "latitude" | "longitude" | "accuracy"> | null
  >(null);
  const [facing, setFacing] = useState<"back" | "front">("back");
  const [flash, setFlash] = useState<"off" | "on" | "auto">("off");
  const [mode, setMode] = useState<"photo" | "video" | "walkthru">("photo");
  // Continuous zoom value fed to CameraView (0..1). Presets snap it to
  // their exact value; pinch moves it freely between them. After a pinch
  // the value usually matches no preset, so no preset renders as active —
  // that is expected. Default matches the old "1x" preset.
  const [zoomValue, setZoomValue] = useState(
    ZOOM_PRESETS[1]?.value ?? 0.05,
  );
  // Pinch state lives on the UI thread; React state is only pushed via
  // the throttled useAnimatedReaction below (setState per frame would
  // drop frames on the preview).
  const pinchZoom = useSharedValue(ZOOM_PRESETS[1]?.value ?? 0.05);
  const pinchBase = useSharedValue(ZOOM_PRESETS[1]?.value ?? 0.05);
  const pinchLastPushTs = useSharedValue(0);
  const [bursting, setBursting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [captureCount, setCaptureCount] = useState(0);
  const [sessionCount, setSessionCount] = useState(0);
  const [savedVideos, setSavedVideos] = useState(0);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // ---- Walkthrough session state ----
  // wtStatus is mirrored in a ref (set SYNCHRONOUSLY before awaits in
  // wtStart) so double-taps can't admit two concurrent recordings and
  // capture callbacks can read the live value without stale closures.
  const [wtStatus, setWtStatus] = useState<
    "idle" | "starting" | "recording" | "done"
  >("idle");
  const wtStatusRef = useRef<"idle" | "starting" | "recording" | "done">(
    "idle",
  );
  // Disposal/run token: bumped on unmount (and consulted after every
  // await in wtStart) so a start that "wins" after cleanup ran can
  // cancel the recorder it just created instead of leaking it.
  const wtRunIdRef = useRef(0);
  // Live mode for async continuations (flag read, start) — state
  // closures go stale across awaits.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const wtStartMsRef = useRef(0);
  // Display-only tick; elapsed is ALWAYS wall-clock derived.
  const [wtNow, setWtNow] = useState(0);
  const wtCapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wtTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Photos captured during THIS recording: local id + queue id +
  // ms offset from recording start (derived from each photo's takenAt).
  const wtPhotosRef = useRef<WalkthroughSessionPhoto[]>([]);
  const [wtPhotoCount, setWtPhotoCount] = useState(0);
  const [wtAudio, setWtAudio] = useState<{
    uri: string;
    mimeType: string;
  } | null>(null);
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtIntroVisible, setWtIntroVisible] = useState(false);
  const [wtSheetVisible, setWtSheetVisible] = useState(false);

  // ---- Photo tray (session-scoped) ----
  // Local photo ids captured/imported since this screen mounted, newest
  // first. The ids point into DataContext.photos, so tray tiles re-render
  // reactively as uploads finish (uploaded flag flips, mediaId arrives).
  // State dies with the screen — the photos themselves are already saved
  // to the project through the untouched capture pipeline.
  const [trayIds, setTrayIds] = useState<string[]>([]);
  const [trayOpen, setTrayOpen] = useState(false);
  // Pulse on the tray button when new photos land. A fly-to-tray animation
  // would have to overlay the CameraView's native hierarchy (position
  // tracking across the preview frame), so per the fallback in the spec we
  // pulse the tray itself: scale 1 → 1.22 → 1, native driver, ~320ms.
  const trayScale = useRef(new Animated.Value(1)).current;
  const pulseTray = useCallback(() => {
    Animated.sequence([
      Animated.timing(trayScale, {
        toValue: 1.22,
        duration: 140,
        useNativeDriver: true,
      }),
      Animated.timing(trayScale, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start();
  }, [trayScale]);
  // Session-local snapshot of every Photo saved this session, keyed by id.
  // Source-of-truth fallback for the tray: if DataContext.photos hasn't
  // flushed (or momentarily lost) a just-saved photo, the tray still
  // renders it from this snapshot, so the count can never desync from
  // what was actually saved.
  const sessionPhotosRef = useRef<Map<string, Photo>>(new Map());
  const addToTray = useCallback(
    (saved: Photo[]) => {
      if (saved.length === 0) return;
      for (const p of saved) sessionPhotosRef.current.set(p.id, p);
      setTrayIds((ids) => [...saved.map((p) => p.id).reverse(), ...ids]);
      pulseTray();
    },
    [pulseTray],
  );

  // Live photo objects for the tray, newest first. Prefer the live
  // context object (upload status / mediaId updates), fall back to the
  // session snapshot taken at save time. Only omit an id if it's in
  // neither (photo deleted elsewhere this session).
  const trayPhotos = trayIds
    .map((id) => photos.find((p) => p.id === id) ?? sessionPhotosRef.current.get(id))
    .filter((p): p is Photo => !!p);

  // Prune a photo out of the tray entirely (id list + session snapshot).
  // Called after a delete so the fallback map can't keep a removed photo
  // visible/countable.
  const removeFromTray = useCallback((id: string) => {
    sessionPhotosRef.current.delete(id);
    setTrayIds((ids) => ids.filter((x) => x !== id));
  }, []);

  const cameraRef = useRef<CameraView | null>(null);
  const burstActive = useRef(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tappedRef = useRef(false);
  const mountedRef = useRef(true);
  const buffer = useRef<
    Array<{
      uri: string;
      takenAt: string;
      latitude?: number;
      longitude?: number;
      accuracy?: number;
    }>
  >([]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // Defensive: a throw from ANY unmount cleanup crashes the whole
      // tree (commitHookEffectListUnmount) — swallow + report instead.
      try {
        mountedRef.current = false;
        burstActive.current = false;
        if (holdTimer.current) {
          clearTimeout(holdTimer.current);
          holdTimer.current = null;
        }
      } catch (err) {
        try {
          Sentry.captureException(err, {
            tags: { source: "capture_cleanup" },
            extra: { cleanup: "mounted/holdTimer (~:315)" },
          });
        } catch {
          // Never let reporting itself throw during unmount.
        }
      }
    };
  }, []);

  useEffect(() => {
    (async () => {
      if (Platform.OS === "web") {
        setLocationGranted(false);
        return;
      }
      const { status } = await Location.requestForegroundPermissionsAsync();
      const granted = status === "granted";
      setLocationGranted(granted);
      if (granted) {
        try {
          const loc = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          setLocationCoord({
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
            accuracy: loc.coords.accuracy ?? undefined,
          });
        } catch {
          /* ignore */
        }
      }
    })();
  }, []);

  // Auto-clear status banners after a moment.
  useEffect(() => {
    if (!statusMsg) return;
    const t = setTimeout(() => setStatusMsg(null), 2400);
    return () => {
      try {
        clearTimeout(t);
      } catch (err) {
        try {
          Sentry.captureException(err, {
            tags: { source: "capture_cleanup" },
            extra: { cleanup: "statusMsg timer (~:355)" },
          });
        } catch {
          // Never let reporting itself throw during unmount.
        }
      }
    };
  }, [statusMsg]);

  // ALWAYS cancel a live narration recording on unmount. The token
  // bump also disposes any in-flight wtStart, which cancels its own
  // recorder if it completes after this ran.
  useEffect(() => {
    return () => {
      try {
        wtRunIdRef.current += 1;
        if (typeof wtClearTimers === "function") {
          wtClearTimers();
        } else {
          Sentry.captureException(
            new TypeError("wtClearTimers is not a function at cleanup"),
            {
              tags: { source: "capture_cleanup" },
              extra: { cleanup: "walkthrough recorder (~:362)" },
            },
          );
        }
        if (wtStatusRef.current === "recording") {
          // cancelWtRecording comes from an import — verify it survived
          // module init before calling (a bad/partial bundle could leave
          // it undefined, which is exactly a cleanup TypeError).
          if (typeof cancelWtRecording === "function") {
            void cancelWtRecording().catch(() => {});
          } else {
            Sentry.captureException(
              new TypeError("cancelWtRecording is not a function at cleanup"),
              {
                tags: { source: "capture_cleanup" },
                extra: { cleanup: "walkthrough recorder (~:362)" },
              },
            );
          }
        }
      } catch (err) {
        try {
          Sentry.captureException(err, {
            tags: { source: "capture_cleanup" },
            extra: { cleanup: "walkthrough recorder (~:362)" },
          });
        } catch {
          // Never let reporting itself throw during unmount.
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pinch-to-zoom on the preview frame. The DETECTOR wraps the existing
  // `previewFrame` — no new overlay view is layered over CameraView (see
  // the fly-to-tray hazard note above: overlaying the CameraView's native
  // hierarchy is exactly what we avoid). 0.25 damps a full pinch so it
  // can't slam 0→1; tune on device if it feels wrong. Enabled only once
  // the camera is up (mode is always "photo" | "video" here).
  //
  // Every hook in CaptureScreen MUST be declared above the early returns
  // below. `permission` is null on first render and flips after mount, so
  // a hook declared after those returns changes the hook count between
  // renders and throws "Rendered more hooks than during the previous
  // render" — which unmounts the camera and shows a white screen. This
  // shipped in 1.4.0 (build 63). Add new hooks above this line.
  const pinchGesture = React.useMemo(
    () =>
      Gesture.Pinch()
        .enabled(cameraReady)
        .onBegin(() => {
          pinchBase.value = pinchZoom.value;
        })
        .onUpdate((e) => {
          const next = pinchBase.value + (e.scale - 1) * 0.25;
          pinchZoom.value = Math.min(PINCH_MAX_ZOOM, Math.max(0, next));
        })
        .onFinalize(() => {
          // Always land the final value even if the ~60ms throttle
          // swallowed the last onUpdate.
          runOnJS(setZoomValue)(pinchZoom.value);
        }),
    [cameraReady, pinchBase, pinchZoom],
  );

  // UI-thread → React state bridge, throttled to ~60ms so the camera
  // preview isn't re-rendered every gesture frame.
  useAnimatedReaction(
    () => pinchZoom.value,
    (current, previous) => {
      if (previous === null || current === previous) return;
      const now = Date.now();
      if (now - pinchLastPushTs.value >= 60) {
        pinchLastPushTs.value = now;
        runOnJS(setZoomValue)(current);
      }
    },
    [],
  );

  if (!project) {
    return (
      <View style={[styles.wrap, { backgroundColor: "#000" }]}>
        <Text style={{ color: "#fff", textAlign: "center", marginTop: 100 }}>
          Project not found.
        </Text>
        <View style={{ padding: 20 }}>
          <Button
            title="Close"
            onPress={() => router.back()}
            variant="secondary"
          />
        </View>
      </View>
    );
  }

  if (!permission) return null;

  if (!permission.granted) {
    return (
      <View
        style={[
          styles.wrap,
          {
            backgroundColor: "#000",
            paddingTop: insets.top + 40,
            padding: 24,
            gap: 16,
          },
        ]}
      >
        <Feather name="camera" size={36} color={colors.primary} />
        <Text style={styles.permTitle}>Camera access needed</Text>
        <Text style={styles.permBody}>
          Field View needs your camera to capture project photos. You can revoke
          access anytime from system settings.
        </Text>
        <Button title="Continue" onPress={requestPermission} size="lg" />
      </View>
    );
  }

  // Take a single photo.
  //
  // After the native capture resolves, center-crop to the account-
  // configured aspect ratio (S3y). Crop runs synchronously inside
  // captureOnce so the returned uri is the cropped one — every
  // downstream consumer (singleShot → addPhoto, startBurst → buffer
  // → addPhotosBatch) gets the cropped file without per-callsite
  // changes. cropToAspectRatio is a no-op when the native ratio
  // already matches the target (±1%), so most 4:3-configured
  // accounts pay zero extra cost.
  //
  // Crop failure is non-fatal: log to Sentry and fall back to the
  // raw uncropped uri. Per the design ("Don't break capture"), it's
  // strictly better to ship an off-ratio photo than no photo at all.
  // The CameraView preview itself stays at native sensor ratio on
  // iOS — there's no public API to constrain the preview to match —
  // so 1:1/16:9 users see a wider preview than what's saved. Web
  // parity helper text in the admin UI calls this out.
  const captureOnce = async () => {
    if (!cameraRef.current || !cameraReady) return null;
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.7,
        exif: false,
      });
      if (!photo?.uri) return null;

      let finalUri = photo.uri;
      if (
        typeof photo.width === "number" &&
        typeof photo.height === "number" &&
        photo.width > 0 &&
        photo.height > 0
      ) {
        try {
          const cropped = await cropToAspectRatio(
            { uri: photo.uri, width: photo.width, height: photo.height },
            captureAspectRatio,
          );
          finalUri = cropped.uri;
        } catch (cropErr) {
          const msg =
            cropErr instanceof Error ? cropErr.message : String(cropErr);
          console.log(`[capture] crop failed (using raw): ${msg}`);
          Sentry.captureException(cropErr, {
            extra: {
              phase: "captureOnce.crop",
              ratio: captureAspectRatio,
              srcWidth: photo.width,
              srcHeight: photo.height,
            },
          });
          // finalUri already = photo.uri (raw fallback).
        }
      }

      return {
        uri: finalUri,
        takenAt: new Date().toISOString(),
        latitude: locationCoord?.latitude,
        longitude: locationCoord?.longitude,
        accuracy: locationCoord?.accuracy,
      };
    } catch (e) {
      setErrorMsg(
        e instanceof Error ? e.message : "Couldn't capture photo. Try again.",
      );
      return null;
    }
  };

  // Tap behavior in photo mode: single capture + save immediately.
  const singleShot = async () => {
    if (!cameraReady || saving) return;
    setSaving(true);
    setErrorMsg(null);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      const entry = await captureOnce();
      if (entry) {
        const prepared = await prepareForUpload(entry.uri);
        const saved = await addPhoto({
          projectId: project.id,
          uri: prepared?.localUri ?? entry.uri,
          takenAt: entry.takenAt,
          latitude: entry.latitude,
          longitude: entry.longitude,
          accuracy: entry.accuracy,
          originalName: prepared?.originalName,
          mimeType: prepared?.mimeType,
          fileSize: prepared?.fileSize,
          checklistItemId,
          taskId,
        });
        addToTray([saved]);
        wtTrackPhoto(saved);
        setSessionCount((s) => s + 1);
        Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        ).catch(() => {});
      }
    } finally {
      setSaving(false);
    }
  };

  // Hold behavior in photo mode: burst until release.
  const startBurst = async () => {
    if (!cameraReady || saving) return;
    burstActive.current = true;
    setBursting(true);
    buffer.current = [];
    setCaptureCount(0);
    setErrorMsg(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});

    while (burstActive.current) {
      const entry = await captureOnce();
      if (!entry) break;
      buffer.current.push(entry);
      setCaptureCount(buffer.current.length);
    }
  };

  const stopBurst = async () => {
    if (!burstActive.current && buffer.current.length === 0) return;
    burstActive.current = false;
    setBursting(false);
    if (buffer.current.length === 0) return;
    setSaving(true);
    try {
      const prepared = await Promise.all(
        buffer.current.map(async (b) => ({
          b,
          p: await prepareForUpload(b.uri),
        })),
      );
      const savedBatch = await addPhotosBatch(
        prepared.map(({ b, p }) => ({
          projectId: project.id,
          uri: p?.localUri ?? b.uri,
          takenAt: b.takenAt,
          latitude: b.latitude,
          longitude: b.longitude,
          accuracy: b.accuracy,
          originalName: p?.originalName,
          mimeType: p?.mimeType,
          fileSize: p?.fileSize,
          checklistItemId,
          taskId,
        })),
      );
      addToTray(savedBatch);
      for (const saved of savedBatch) wtTrackPhoto(saved);
      setSessionCount((s) => s + buffer.current.length);
      buffer.current = [];
      Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Success,
      ).catch(() => {});
    } finally {
      setSaving(false);
      setCaptureCount(0);
    }
  };

  // Video mode: tap to start, tap again to stop.
  const toggleRecording = async () => {
    if (!cameraRef.current || !cameraReady) return;
    if (recording) {
      try {
        cameraRef.current.stopRecording();
      } catch {
        /* ignore */
      }
      return;
    }

    setRecording(true);
    setErrorMsg(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});

    try {
      // Cap recording so a clip can't exceed the 500MB server upload cap.
      // At 1080p (pinned via CameraView `videoQuality`), ~180s stays under 500MB
      // worst-case. `maxFileSize` is the hard byte backstop and is honored
      // natively on both iOS and Android, so it's applied on both.
      const result = await cameraRef.current.recordAsync({
        maxDuration: MAX_RECORDING_SECONDS,
        maxFileSize: MAX_RECORDING_BYTES,
      });
      setRecording(false);
      if (result?.uri) {
        // Save to camera roll if available (best-effort, independent of upload).
        try {
          // writeOnly: request save-only access. Broad media-read perms
          // were stripped for Play policy; saveToLibraryAsync needs only
          // write access.
          const perm = await MediaLibrary.requestPermissionsAsync(true);
          if (perm.granted) {
            await MediaLibrary.saveToLibraryAsync(result.uri);
            setStatusMsg("Video saved to camera roll");
          } else {
            setStatusMsg("Video saved locally");
          }
        } catch {
          setStatusMsg("Video saved locally");
        }
        setSavedVideos((n) => n + 1);
        Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        ).catch(() => {});

        // Upload the recording through the SAME presign → S3 → create-media
        // flow photos use. iOS records .mov (video/quicktime); prepareForUpload
        // derives the mimeType from the file extension (MIME_BY_EXT). If the
        // upload meta can't be prepared we keep the local copy and surface an
        // error rather than silently dropping the capture.
        const prepared = await prepareForUpload(result.uri, "video/quicktime");
        if (prepared) {
          await addPhoto({
            projectId: project.id,
            uri: prepared.localUri,
            takenAt: new Date().toISOString(),
            latitude: locationCoord?.latitude,
            longitude: locationCoord?.longitude,
            accuracy: locationCoord?.accuracy,
            isVideo: true,
            originalName: prepared.originalName,
            mimeType: prepared.mimeType,
            fileSize: prepared.fileSize,
            checklistItemId,
            taskId,
          });
          setSessionCount((s) => s + 1);
        } else {
          setErrorMsg(
            "Video recorded and saved locally, but couldn't be queued for upload.",
          );
        }
      }
    } catch (e) {
      setRecording(false);
      setErrorMsg(
        e instanceof Error ? e.message : "Couldn't record video. Try again.",
      );
    }
  };

  // Gallery import: pick photos from device and attach to this project.
  const pickFromGallery = async () => {
    if (importing) return;
    setImporting(true);
    setErrorMsg(null);
    try {
      // The Android system Photo Picker (and iOS PHPicker) require NO
      // runtime media-read permission. With the broad READ_MEDIA_*
      // permissions stripped for Play policy, gating on
      // requestMediaLibraryPermissionsAsync would falsely block the
      // picker, so launch it directly.
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
      const savedImports = await addPhotosBatch(
        prepared.map(({ a, p }) => ({
          projectId: project.id,
          uri: p?.localUri ?? a.uri,
          takenAt: now,
          latitude: locationCoord?.latitude,
          longitude: locationCoord?.longitude,
          accuracy: locationCoord?.accuracy,
          originalName: p?.originalName,
          mimeType: p?.mimeType,
          fileSize: p?.fileSize,
          checklistItemId,
          taskId,
        })),
      );
      // Imports count toward the session pill, so they join the tray too.
      addToTray(savedImports);
      setSessionCount((s) => s + res.assets.length);
      setStatusMsg(
        `Added ${res.assets.length} photo${res.assets.length === 1 ? "" : "s"} from library`,
      );
      Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Success,
      ).catch(() => {});
    } catch (e) {
      setErrorMsg(
        e instanceof Error ? e.message : "Couldn't import from gallery.",
      );
    } finally {
      setImporting(false);
    }
  };

  // ---- Walkthrough handlers ----

  // Record a session photo's offset. offsetMs derives from the photo's
  // takenAt stamp (set at shutter time) minus the recording start —
  // both Date.now()-based, so the math is consistent even if the save
  // pipeline lags the shutter.
  const wtTrackPhoto = (saved: Photo) => {
    if (wtStatusRef.current !== "recording") return;
    const taken = Date.parse(saved.takenAt ?? "");
    const offsetMs = Math.max(
      0,
      (Number.isFinite(taken) ? taken : Date.now()) - wtStartMsRef.current,
    );
    wtPhotosRef.current.push({
      localId: String(saved.id),
      uploadQueueId: saved.uploadQueueId,
      offsetMs,
    });
    setWtPhotoCount(wtPhotosRef.current.length);
  };

  const wtClearTimers = () => {
    if (wtCapTimerRef.current) {
      clearTimeout(wtCapTimerRef.current);
      wtCapTimerRef.current = null;
    }
    if (wtTickRef.current) {
      clearInterval(wtTickRef.current);
      wtTickRef.current = null;
    }
  };

  // Start narration recording. NOT called on mode switch — only from
  // the explainer's "Start walkthrough" button or the Start control.
  const wtStart = async () => {
    if (wtStatusRef.current !== "idle") return;
    if (modeRef.current !== "walkthru") return;
    // Synchronous reservation before any await — a second tap in the
    // permission/start window must not admit a concurrent start.
    wtStatusRef.current = "starting";
    setWtStatus("starting");
    setWtError(null);
    const run = wtRunIdRef.current;
    // Disposed = unmounted (token bumped) or the user escaped the
    // walkthrough mode while an await was pending.
    const disposed = () =>
      wtRunIdRef.current !== run || modeRef.current !== "walkthru";
    const bail = (msg: string | null) => {
      wtStatusRef.current = "idle";
      if (wtRunIdRef.current === run) {
        setWtStatus("idle");
        if (msg) setWtError(msg);
      }
    };
    let granted: boolean;
    try {
      granted = await requestWtMicPermission();
    } catch (e) {
      // Dynamic import / native module failure — degrade inline, same
      // messaging as VoiceNoteButton. Never rethrow (crash in prod).
      bail(
        isModuleUnavailableError(e)
          ? "Voice notes need an app update."
          : "Couldn't start recording. Try again.",
      );
      return;
    }
    if (disposed()) {
      bail(null);
      return;
    }
    if (!granted) {
      bail(
        "Microphone access is blocked. Enable it in Settings to record a walkthrough.",
      );
      return;
    }
    try {
      await startWtRecording();
    } catch (e) {
      // startRecording cleans up after itself on failure. No global
      // cancelRecording() here — this attempt never obtained the
      // recorder, and a global cancel could kill a recording owned by
      // someone else (fixed earlier; must not regress).
      bail(
        isModuleUnavailableError(e)
          ? "Voice notes need an app update."
          : "Couldn't start recording. Try again.",
      );
      return;
    }
    if (disposed()) {
      // Start won AFTER cleanup/mode-escape — the unmount cleanup
      // (or nothing) already ran and missed this recorder. It is ours;
      // discard it now.
      void cancelWtRecording().catch(() => {});
      bail(null);
      return;
    }
    const start = Date.now();
    wtStartMsRef.current = start;
    wtPhotosRef.current = [];
    setWtPhotoCount(0);
    setWtNow(start);
    wtStatusRef.current = "recording";
    setWtStatus("recording");
    // Single ABSOLUTE timeout for the 15-minute cap — auto-stop and
    // proceed to the Done flow with what was captured, never discard.
    wtCapTimerRef.current = setTimeout(() => {
      void wtDone();
    }, WT_MAX_MS);
    // Display refresh only; the shown value is wall-clock derived.
    wtTickRef.current = setInterval(() => setWtNow(Date.now()), 500);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  };

  // Done (user tap or 15-minute cap): stop the recording and hand the
  // audio + session photos to the Done sheet, which runs connection
  // check → upload blocking → transcribe → POST.
  const wtDone = async () => {
    if (wtStatusRef.current !== "recording") return;
    wtStatusRef.current = "done";
    setWtStatus("done");
    wtClearTimers();
    try {
      const { uri, mimeType } = await stopWtRecording();
      setWtAudio({ uri, mimeType });
    } catch (e) {
      // Stop failed — no usable audio. The sheet reports the failure
      // plainly (photos are already safe in the queue).
      setWtAudio(null);
      console.log("[walkthrough] stopRecording failed:", e);
    }
    setWtSheetVisible(true);
  };

  // Sheet closed back to the camera (cancel / error / offline exit
  // handled by caller): reset session state. Photos stay in the queue.
  const wtReset = () => {
    wtClearTimers();
    wtStatusRef.current = "idle";
    setWtStatus("idle");
    setWtSheetVisible(false);
    setWtAudio(null);
    wtPhotosRef.current = [];
    setWtPhotoCount(0);
  };

  // Entering WALKTHRU for the first time ever shows the explainer once
  // (AsyncStorage-flagged), after which Start begins immediately.
  const enterWalkthruMode = () => {
    setMode("walkthru");
    modeRef.current = "walkthru";
    void storage.getFlag(WT_INTRO_FLAG).then((seen) => {
      // Stale-read guard: the user may have switched away before the
      // flag resolved — never surface the intro outside WALKTHRU.
      if (!seen && modeRef.current === "walkthru") setWtIntroVisible(true);
    });
  };

  // Differentiate tap vs. hold for the shutter.
  const onShutterPressIn = () => {
    if (!cameraReady) return;
    if (mode === "video") return; // video uses tap-to-start, tap-to-stop
    // Walkthrough: the shutter only shoots while narration is live —
    // Start owns the entry point, so an idle tap does nothing.
    if (mode === "walkthru" && wtStatusRef.current !== "recording") return;
    if (saving) return;
    tappedRef.current = true;
    holdTimer.current = setTimeout(() => {
      tappedRef.current = false;
      startBurst();
    }, HOLD_TO_BURST_MS);
  };

  const onShutterPressOut = () => {
    if (mode === "video") {
      toggleRecording();
      return;
    }
    if (mode === "walkthru" && wtStatusRef.current !== "recording") return;
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (tappedRef.current) {
      tappedRef.current = false;
      singleShot();
    } else {
      stopBurst();
    }
  };

  const toggleFacing = () => {
    if (recording) return;
    setFacing((f) => (f === "back" ? "front" : "back"));
  };
  const toggleFlash = () =>
    setFlash((f) => (f === "off" ? "on" : f === "on" ? "auto" : "off"));

  return (
    <View style={styles.wrap}>
      {/* TOP BAR: close + project + flash/flip.
       *
       * Side clusters are forced to equal width (`topSideCluster`)
       * so the centered project badge in the middle (`flex:1`) is
       * truly screen-centered regardless of how many icons live on
       * each side. Without equal-width sides, a 1-icon left + 2-icon
       * right cluster would push the badge off-center. */}
      <View style={[styles.topBar, { paddingTop: insets.top + 10 }]}>
        <View style={styles.topSideCluster}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={12}
            style={styles.glassBtn}
            accessibilityLabel="Close camera"
          >
            <Feather name="x" size={20} color="#fff" />
          </Pressable>
        </View>

        <View style={styles.projectBadge}>
          <Text style={styles.projectName} numberOfLines={1}>
            {project.name}
          </Text>
          <Text style={styles.projectMeta} numberOfLines={1}>
            {locationCoord
              ? `GPS · ${locationCoord.latitude?.toFixed(4)}, ${locationCoord.longitude?.toFixed(4)}`
              : locationGranted === false
                ? "GPS off"
                : "Acquiring GPS…"}
          </Text>
        </View>

        <View style={[styles.topSideCluster, styles.topSideClusterRight]}>
          <Pressable
            onPress={toggleFlash}
            hitSlop={10}
            style={styles.glassBtn}
            accessibilityLabel={`Flash: ${flash}`}
          >
            <Feather
              name={flash === "off" ? "zap-off" : "zap"}
              size={18}
              color={flash === "on" ? colors.primary : "#fff"}
            />
          </Pressable>
          <Pressable
            onPress={toggleFacing}
            hitSlop={10}
            style={[
              styles.glassBtn,
              { opacity: recording ? 0.4 : 1 },
            ]}
            accessibilityLabel="Flip camera"
            disabled={recording}
          >
            <Feather name="refresh-ccw" size={18} color="#fff" />
          </Pressable>
        </View>
      </View>

      {/* PREVIEW AREA: flex:1 between the top bar and the bottom
       * control stack. The CameraView lives inside a 3:4 clipped
       * frame that shrinks to fit available space (CompanyCam
       * pattern — width-fit on tall phones, height-fit on short
       * phones like iPhone SE). Letterbox bars for non-4:3 capture
       * ratios live INSIDE the clipping frame so they're masked by
       * the rounded corners. */}
      <View style={styles.previewArea}>
        <GestureDetector gesture={pinchGesture}>
        <View style={styles.previewFrame}>
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing={facing}
            flash={flash}
            zoom={zoomValue}
            // Walkthrough shoots stills — the camera itself runs in
            // photo mode; only the narration recorder differs.
            mode={mode === "video" ? "video" : "photo"}
            videoQuality="1080p"
            onCameraReady={() => setCameraReady(true)}
          />

          {/* Letterbox overlay (B11): masks preview to match the
           * user's saved-photo aspect ratio. Pointer-events disabled
           * so all camera chrome stays interactive. Hidden in video
           * mode because video capture isn't ratio-cropped.
           *
           * The overlay's outer top/bottom black bars collapse to
           * 0px because the parent `previewFrame` is already
           * exactly 3:4 — only the inner masks (1:1 / 9:16) draw
           * pixels. The component itself is unchanged. */}
          {mode !== "video" ? (
            <LetterboxOverlay ratio={captureAspectRatio} />
          ) : null}
        </View>
        </GestureDetector>

        {/* Top status pills — anchored to the top of the preview
         * area (NOT the screen) so they remain correctly placed
         * regardless of safe-area top inset variation across
         * devices. Was previously screen-absolute with hardcoded
         * `top:110`, which broke after the topBar moved into flow.
         * Sibling of `previewFrame` inside `previewArea`. */}
        {bursting ? (
          <View style={styles.previewPillBurst}>
            <View style={styles.recDot} />
            <Text style={styles.burstText}>BURST · {captureCount}</Text>
          </View>
        ) : recording ? (
          <View
            style={[
              styles.previewPillBurst,
              { backgroundColor: "rgba(220,38,38,0.85)" },
            ]}
          >
            <View style={styles.recDot} />
            <Text style={styles.burstText}>REC</Text>
          </View>
        ) : wtStatus === "recording" ? (
          // Walkthrough status: photo count + wall-clock elapsed
          // ("12 photos · 4:31"). Turns warning-colored near the cap.
          <View
            style={[
              styles.previewPillBurst,
              {
                backgroundColor:
                  Math.max(0, wtNow - wtStartMsRef.current) >= WT_WARN_MS
                    ? "rgba(245,158,11,0.9)"
                    : "rgba(220,38,38,0.85)",
              },
            ]}
          >
            <View style={styles.recDot} />
            <Text style={styles.burstText}>
              {wtPhotoCount} photo{wtPhotoCount === 1 ? "" : "s"} ·{" "}
              {(() => {
                const s = Math.floor(
                  Math.max(0, wtNow - wtStartMsRef.current) / 1000,
                );
                return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
              })()}
            </Text>
          </View>
        ) : statusMsg ? (
          <View style={styles.previewPillSession}>
            <Feather name="check" size={14} color="#111" />
            <Text style={styles.sessionPillText}>{statusMsg}</Text>
          </View>
        ) : sessionCount > 0 || savedVideos > 0 ? (
          <View style={styles.previewPillSession}>
            <Feather name="check" size={14} color="#111" />
            <Text style={styles.sessionPillText}>
              {sessionCount > 0
                ? `${sessionCount} photo${sessionCount === 1 ? "" : "s"}`
                : ""}
              {sessionCount > 0 && savedVideos > 0 ? " · " : ""}
              {savedVideos > 0
                ? `${savedVideos} video${savedVideos === 1 ? "" : "s"}`
                : ""}
              {" saved"}
            </Text>
          </View>
        ) : !cameraReady ? (
          <View style={styles.previewPillSession}>
            <ActivityIndicator size="small" color="#111" />
            <Text style={styles.sessionPillText}>Starting camera…</Text>
          </View>
        ) : null}

        {errorMsg ? (
          <View
            style={[
              styles.previewPillSession,
              { backgroundColor: "#fee2e2", top: 50 },
            ]}
          >
          <Feather name="alert-triangle" size={14} color="#991b1b" />
          <Text style={[styles.sessionPillText, { color: "#991b1b" }]}>
            {errorMsg}
          </Text>
        </View>
        ) : null}
      </View>

      {/* CONTROL STACK: zoom presets, mode tabs, shutter row */}
      <View
        style={[
          styles.controlStack,
          { paddingBottom: insets.bottom + 18 },
        ]}
      >
        {/* Zoom presets */}
        <View style={styles.zoomRow}>
          <BlurView
            intensity={Platform.OS === "ios" ? 40 : 0}
            tint="dark"
            style={styles.zoomGroup}
          >
            <View style={styles.zoomGroupInner}>
              {ZOOM_PRESETS.map((z, i) => {
                // Apple pattern: the pill sits on the NEAREST preset by
                // value and shows the live interpolated multiplier
                // ("1.4x"); neighbors render as bare labels without a
                // pill or trailing x (".5", "4").
                const nearestIdx = ZOOM_PRESETS.reduce(
                  (best, p, j) =>
                    Math.abs(p.value - zoomValue) <
                    Math.abs(ZOOM_PRESETS[best]!.value - zoomValue)
                      ? j
                      : best,
                  0,
                );
                const active = i === nearestIdx;
                const label = active
                  ? `${formatZoomMult(zoomToLabel(zoomValue))}x`
                  : z.label.replace(/x$/, "");
                return (
                  <Pressable
                    key={z.label}
                    onPress={() => {
                      Haptics.selectionAsync().catch(() => {});
                      // Snap React state AND the UI-thread value so the
                      // preset becomes the next pinch's base.
                      setZoomValue(z.value);
                      pinchZoom.value = z.value;
                    }}
                    accessibilityLabel={`Zoom ${z.label}`}
                    accessibilityState={{ selected: active }}
                    style={[
                      styles.zoomBtn,
                      active && {
                        backgroundColor: colors.primary,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.zoomLabel,
                        {
                          color: active
                            ? colors.primaryForeground
                            : "#fff",
                          fontFamily: active
                            ? "Inter_700Bold"
                            : "Inter_600SemiBold",
                        },
                      ]}
                    >
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </BlurView>
        </View>

        {/* Bottom main row: tray + gallery (left), shutter, done */}
        <View style={styles.bottomBar}>
          <View style={styles.leftCluster}>
            {/* Photo tray — appears with the first capture this session. */}
            {trayPhotos.length > 0 ? (
              <Animated.View style={{ transform: [{ scale: trayScale }] }}>
                <Pressable
                  onPress={() => setTrayOpen(true)}
                  disabled={recording}
                  accessibilityRole="button"
                  accessibilityLabel={`Open photo tray, ${trayPhotos.length} photo${trayPhotos.length === 1 ? "" : "s"} this session`}
                  style={({ pressed }) => [
                    styles.trayBtn,
                    { opacity: recording ? 0.4 : pressed ? 0.8 : 1 },
                  ]}
                >
                  <Image
                    source={{ uri: trayPhotos[0].uri }}
                    style={styles.trayThumb}
                    contentFit="cover"
                    transition={100}
                  />
                  <View
                    style={[
                      styles.trayBadge,
                      { backgroundColor: colors.primary },
                    ]}
                  >
                    <Text style={styles.trayBadgeText}>
                      {trayPhotos.length > 99 ? "99+" : trayPhotos.length}
                    </Text>
                  </View>
                </Pressable>
              </Animated.View>
            ) : null}
            <Pressable
              onPress={pickFromGallery}
              disabled={importing || recording}
              accessibilityLabel="Import from gallery"
              style={({ pressed }) => [
                styles.sideBtn,
                {
                  opacity: importing || recording ? 0.4 : pressed ? 0.7 : 1,
                },
              ]}
            >
              {importing ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Feather name="image" size={22} color="#fff" />
              )}
            </Pressable>
          </View>

          <Pressable
            onPressIn={onShutterPressIn}
            onPressOut={onShutterPressOut}
            disabled={!cameraReady || (saving && mode === "photo")}
            accessibilityLabel={
              mode === "video"
                ? recording
                  ? "Stop recording"
                  : "Start recording"
                : "Take photo. Hold for burst."
            }
            style={({ pressed }) => [
              styles.shutter,
              {
                borderColor: mode === "video" ? "#fff" : "#fff",
                opacity:
                  !cameraReady || (saving && mode === "photo") ? 0.5 : 1,
                transform: [{ scale: pressed || bursting ? 0.94 : 1 }],
              },
            ]}
          >
            <View
              style={[
                styles.shutterInner,
                mode === "video"
                  ? recording
                    ? styles.shutterInnerRecStop
                    : styles.shutterInnerRec
                  : bursting
                    ? styles.shutterInnerBurst
                    : styles.shutterInnerPhoto,
              ]}
            />
          </Pressable>

          <Pressable
            onPress={() => {
              // In a live walkthrough, Done ends the session (stop →
              // upload-block → transcribe → generate) instead of
              // leaving the screen.
              if (mode === "walkthru" && wtStatus === "recording") {
                void wtDone();
                return;
              }
              router.back();
            }}
            // `bursting` included so Done can't end a walkthrough
            // session while a burst is still capturing — its photos
            // finalize (and get offset-tracked) before the session can
            // close, so none are dropped from the report.
            disabled={
              saving ||
              recording ||
              bursting ||
              wtStatus === "starting" ||
              wtStatus === "done"
            }
            accessibilityLabel="Done"
            style={({ pressed }) => [
              styles.doneBtn,
              {
                backgroundColor:
                  mode === "walkthru" && wtStatus === "recording"
                    ? colors.primary
                    : "rgba(255,255,255,0.16)",
                opacity:
                  saving ||
                  recording ||
                  bursting ||
                  wtStatus === "starting" ||
                  wtStatus === "done"
                    ? 0.4
                    : pressed
                      ? 0.8
                      : 1,
              },
            ]}
          >
            {saving ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.doneText}>Done</Text>
            )}
          </Pressable>
        </View>

        {/* Mode tabs (PHOTO / VIDEO) */}
        <View style={styles.modeRow}>
          {(["photo", "video", "walkthru"] as const).map((m) => {
            const active = mode === m;
            return (
              <Pressable
                key={m}
                onPress={() => {
                  if (recording || wtStatus !== "idle") return;
                  Haptics.selectionAsync().catch(() => {});
                  if (m === "walkthru") {
                    enterWalkthruMode();
                  } else {
                    setMode(m);
                  }
                }}
                disabled={recording || wtStatus !== "idle"}
                accessibilityLabel={`${m} mode`}
                accessibilityState={{ selected: active }}
                style={styles.modeBtn}
              >
                <Text
                  style={[
                    styles.modeLabel,
                    {
                      color: active ? "#fff" : "rgba(255,255,255,0.55)",
                      fontFamily: active
                        ? "Inter_700Bold"
                        : "Inter_600SemiBold",
                    },
                  ]}
                >
                  {m.toUpperCase()}
                </Text>
                {active ? (
                  <View
                    style={[
                      styles.modeDot,
                      { backgroundColor: colors.primary },
                    ]}
                  />
                ) : (
                  <View style={styles.modeDotPlaceholder} />
                )}
              </Pressable>
            );
          })}
        </View>

        {/* Walkthrough Start control — recording starts HERE, never on
         * mode switch. Subsequent visits (intro already seen) start
         * from this button directly. */}
        {mode === "walkthru" && wtStatus === "idle" ? (
          <Button
            title="Start"
            onPress={() => void wtStart()}
            style={{ alignSelf: "center", marginTop: 8, minWidth: 160 }}
          />
        ) : null}
        {mode === "walkthru" && wtError ? (
          <Text style={styles.wtError}>{wtError}</Text>
        ) : null}

        {/* Hint */}
        <Text style={styles.hint}>
          {mode === "walkthru"
            ? wtStatus === "recording"
              ? "Talk as you go · Tap Done to finish"
              : wtStatus === "starting"
                ? "Starting…"
                : "Narrate the site while you snap photos"
            : mode === "video"
              ? recording
                ? "Tap to stop"
                : "Tap to record"
              : bursting
                ? "Hold to keep capturing…"
                : "Tap for one photo · Hold for burst"}
        </Text>
      </View>

      {/* Photo tray sheet — Modal over the camera; CameraView stays
          mounted underneath, so closing returns instantly with state
          intact. */}
      <TraySheet
        visible={trayOpen}
        photos={trayPhotos}
        onClose={() => setTrayOpen(false)}
        onRemovedPhoto={removeFromTray}
        primary={colors.primary}
      />

      {/* Walkthrough first-run explainer — shown once ever (flagged in
       * AsyncStorage). Its button is also the FIRST Start. */}
      <Modal
        visible={wtIntroVisible}
        animationType="fade"
        transparent
        onRequestClose={() => setWtIntroVisible(false)}
      >
        <View style={styles.wtIntroBackdrop}>
          <View
            style={[styles.wtIntroCard, { backgroundColor: colors.card }]}
          >
            <Feather name="mic" size={28} color={colors.primary} />
            <Text style={[styles.wtIntroTitle, { color: colors.foreground }]}>
              Talk while you shoot
            </Text>
            <Text
              style={[styles.wtIntroBody, { color: colors.mutedForeground }]}
            >
              Walk the site and describe what you see. Snap photos as you
              go. When you're done, AI turns your narration and photos into
              a report.
            </Text>
            <Button
              title="Start walkthrough"
              onPress={() => {
                void storage.setFlag(WT_INTRO_FLAG, true);
                setWtIntroVisible(false);
                void wtStart();
              }}
            />
          </View>
        </View>
      </Modal>

      {/* Walkthrough Done pipeline (connection check → upload block →
       * transcribe → generate). Cancel keeps photos, skips the report. */}
      <WalkthroughDoneSheet
        visible={wtSheetVisible}
        projectId={project.id}
        audio={wtAudio}
        sessionPhotos={wtPhotosRef.current}
        onDismiss={wtReset}
        onExit={() => {
          // Land on the project's Reports tab WITHOUT modal presentation:
          // 1) dismiss() pops this fullScreenModal off the stack, so the
          //    next action targets the underlying (non-modal) stack;
          // 2) replace() swaps the project screen already beneath the
          //    camera for the same project seeded on tab=reports — a
          //    normal card, no duplicate project entry behind it.
          // dismissTo() was rejected: it would pop back to the EXISTING
          // /project/[id] entry, which was mounted without the tab param
          // (lands on Photos, not Reports). wtReset AFTER dispatching.
          if (router.canDismiss()) router.dismiss();
          router.replace({
            pathname: "/project/[id]",
            params: { id: String(project.id), tab: "reports" },
          });
          wtReset();
        }}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Photo tray sheet: this session's photos (newest first, rendered from
// local URIs so they appear before upload finishes), with per-photo
// upload state and — once a backend mediaId exists — the same comments
// flow as the photo viewer (api.getMediaComments / api.createMediaComment,
// re-fetch after post).
// ---------------------------------------------------------------------------

/** Author display name; the `user` join is absent for deleted authors.
 *  (Mirrors the private helper in app/photo/[id].tsx.) */
function commentAuthorName(c: BackendCommentResponse): string {
  const name = [c.user?.firstName, c.user?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || "Deleted user";
}

/** "Jul 23, 2026, 5:29 PM" in device-local time — same format as the
 *  photo viewer / web comments UI. */
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

/**
 * One tray thumbnail. Subscribes to the photo's upload-queue item so
 * failures surface here (previously the tray only showed spinner/check,
 * so a failed or unrecoverable upload spun forever). Tapping a failed
 * tile opens a classified alert instead of the comment view.
 */
function TrayTile({
  photo,
  onExpand,
  onRemoved,
  size,
}: {
  photo: Photo;
  onExpand: () => void;
  onRemoved: (id: string) => void;
  size: number;
}) {
  const { deletePhoto } = useData();
  const queueItem = useUploadStatus(photo.uploadQueueId);
  const failed =
    queueItem?.status === "failed" || queueItem?.status === "unrecoverable";

  const onPress = () => {
    if (failed && queueItem && photo.uploadQueueId) {
      const classification = classifyUploadFailure(queueItem);
      if (classification === "unrecoverable") {
        Alert.alert(
          "Photo can't be uploaded",
          "The photo file is no longer on this device, so it can't be retried.",
          [
            {
              text: "Remove",
              style: "destructive",
              // deletePhoto also removes the queue item; onRemoved prunes
              // the tray's id list + session snapshot so the deleted photo
              // can't linger via the fallback map.
              onPress: () => {
                onRemoved(photo.id);
                void deletePhoto(photo.id);
              },
            },
            { text: "Cancel", style: "cancel" },
          ],
        );
      } else {
        Alert.alert(
          "Upload failed",
          classification === "auth"
            ? "We couldn't verify your session. It will retry automatically once you're signed in again."
            : "This usually means a connection problem. It will retry automatically — or retry now.",
          [
            {
              text: "Retry now",
              onPress: () => {
                if (photo.uploadQueueId)
                  void retryUploadQueueItem(photo.uploadQueueId);
              },
            },
            { text: "Cancel", style: "cancel" },
          ],
        );
      }
      return;
    }
    onExpand();
  };

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        failed
          ? "Photo upload failed. Tap for options."
          : "Review photo and add a comment"
      }
      style={[styles.trayTile, { width: size, height: size }]}
    >
      <Image
        source={{ uri: photo.uri }}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        transition={100}
      />
      {failed ? (
        <View style={styles.trayTileFailed}>
          <Feather name="alert-circle" size={10} color="#fff" />
        </View>
      ) : !photo.uploaded ? (
        <View style={styles.trayTileUploading}>
          <ActivityIndicator size="small" color="#fff" />
        </View>
      ) : (
        <View style={styles.trayTileDone}>
          <Feather name="check" size={10} color="#fff" />
        </View>
      )}
    </Pressable>
  );
}

function TraySheet({
  visible,
  photos,
  onClose,
  onRemovedPhoto,
  primary,
}: {
  visible: boolean;
  photos: Photo[];
  onClose: () => void;
  onRemovedPhoto: (id: string) => void;
  primary: string;
}) {
  const insets = useSafeAreaInsets();
  // Static read: portrait-locked app, so window size can't change while
  // the sheet is open. Dimensions.get registers NO listener → no unmount
  // cleanup (useWindowDimensions' subscription.remove() was the last
  // remaining hook cleanup in TraySheet's own frame).
  const { width: windowWidth, height: windowHeight } =
    Dimensions.get("window");
  // Explicit tile size: percentage widths ("31.5%") don't reliably
  // resolve inside a ScrollView content container in a Modal on device
  // (tiles collapsed to zero width → blank grid). 3 columns:
  // horizontal padding 16×2, gap 8×2.
  const tileSize = Math.floor((windowWidth - 32 - 16) / 3);
  // Expanded photo (comment view), by local photo id. Resolved against the
  // live `photos` prop so upload completion (mediaId arriving) re-renders
  // the comment area from the "Uploading…" note to the real input.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const expanded = expandedId
    ? (photos.find((p) => p.id === expandedId) ?? null)
    : null;

  // Comments state for the expanded photo (photo viewer pattern:
  // null = loading, re-fetch after post, sequence guard against stale
  // responses landing after the user switched photos).
  const [comments, setComments] = useState<BackendCommentResponse[] | null>(
    null,
  );
  const [commentsError, setCommentsError] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [postingComment, setPostingComment] = useState(false);
  const fetchSeq = useRef(0);
  const expandedMediaId = expanded?.mediaId;
  const expandedMediaIdRef = useRef(expandedMediaId);
  expandedMediaIdRef.current = expandedMediaId;

  const loadComments = useCallback(async (mid: number) => {
    const seq = ++fetchSeq.current;
    try {
      const rows = await api.getMediaComments(mid);
      if (fetchSeq.current !== seq) return;
      setComments(rows);
      setCommentsError(false);
    } catch {
      if (fetchSeq.current !== seq) return;
      setComments([]);
      setCommentsError(true);
    }
  }, []);

  useEffect(() => {
    fetchSeq.current++;
    setComments(null);
    setCommentsError(false);
    setCommentDraft("");
    setPostingComment(false);
    if (expandedMediaId !== undefined) void loadComments(expandedMediaId);
  }, [expandedMediaId, loadComments]);

  // Reset the expanded state whenever the sheet closes.
  useEffect(() => {
    if (!visible) setExpandedId(null);
  }, [visible]);

  const onPostComment = async () => {
    if (expandedMediaId === undefined) return;
    const content = commentDraft.trim();
    if (!content || postingComment) return;
    const mid = expandedMediaId;
    setPostingComment(true);
    try {
      await api.createMediaComment(mid, content);
    } catch (e) {
      setPostingComment(false);
      if (e instanceof ApiError && e.status === 401) return;
      setCommentsError(true);
      return;
    }
    setPostingComment(false);
    // POST returns the bare row without the joined user — re-fetch the
    // list instead of appending locally (photo viewer contract).
    if (expandedMediaIdRef.current === mid) {
      setCommentDraft("");
      void loadComments(mid);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.traySheetBackdrop} onPress={onClose} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View
          style={[
            styles.traySheet,
            {
              paddingBottom: insets.bottom + 12,
              // Bounded height so the inner ScrollView always gets a real
              // layout: cap at ~70% of the screen, keep at least room for
              // the header + one row of tiles.
              maxHeight: Math.floor(windowHeight * 0.7),
              minHeight: Math.min(
                Math.floor(windowHeight * 0.7),
                tileSize + 140,
              ),
            },
          ]}
        >
          <View style={styles.traySheetHandleRow}>
            <View style={styles.traySheetHandle} />
          </View>
          <View style={styles.traySheetHeader}>
            {expanded ? (
              <Pressable
                onPress={() => setExpandedId(null)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Back to tray"
                style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
              >
                <Feather name="chevron-left" size={18} color="#fff" />
                <Text style={styles.traySheetTitle}>All photos</Text>
              </Pressable>
            ) : (
              <Text style={styles.traySheetTitle}>
                This session · {photos.length} photo
                {photos.length === 1 ? "" : "s"}
              </Text>
            )}
            <Pressable
              onPress={onClose}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Close tray"
            >
              <Feather name="x" size={20} color="#fff" />
            </Pressable>
          </View>

          {expanded ? (
            <ScrollView
              style={{ flexGrow: 0 }}
              contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}
              keyboardShouldPersistTaps="handled"
            >
              <Image
                source={{ uri: expanded.uri }}
                style={styles.trayExpandedImg}
                contentFit="contain"
                transition={100}
              />
              {expanded.mediaId == null ? (
                <View style={styles.trayUploadingNote}>
                  <ActivityIndicator size="small" color="#fff" />
                  <Text style={styles.trayUploadingNoteText}>
                    Uploading… comments available shortly
                  </Text>
                </View>
              ) : (
                <View style={{ gap: 10 }}>
                  {comments === null ? (
                    <ActivityIndicator
                      size="small"
                      color="#fff"
                      style={{ marginVertical: 8 }}
                    />
                  ) : comments.length === 0 && !commentsError ? (
                    <Text style={styles.trayCommentMeta}>No comments yet</Text>
                  ) : (
                    comments.map((c) => (
                      <View key={c.id} style={styles.trayCommentRow}>
                        <Text style={styles.trayCommentAuthor}>
                          {commentAuthorName(c)}
                          <Text style={styles.trayCommentMeta}>
                            {"  "}
                            {formatCommentDate(c.createdAt)}
                          </Text>
                        </Text>
                        <Text style={styles.trayCommentBody}>{c.content}</Text>
                      </View>
                    ))
                  )}
                  {commentsError ? (
                    <Text style={[styles.trayCommentMeta, { color: "#fca5a5" }]}>
                      Couldn't load comments
                    </Text>
                  ) : null}
                  <View style={styles.trayCommentInputRow}>
                    <TextInput
                      value={commentDraft}
                      onChangeText={setCommentDraft}
                      placeholder="Add a comment…"
                      placeholderTextColor="rgba(255,255,255,0.45)"
                      style={styles.trayCommentInput}
                      multiline
                      editable={!postingComment}
                    />
                    <Pressable
                      onPress={() => void onPostComment()}
                      disabled={
                        postingComment || commentDraft.trim().length === 0
                      }
                      accessibilityRole="button"
                      accessibilityLabel="Post comment"
                      style={[
                        styles.trayCommentSend,
                        {
                          backgroundColor: primary,
                          opacity:
                            postingComment ||
                            commentDraft.trim().length === 0
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
                </View>
              )}
            </ScrollView>
          ) : (
            <ScrollView
              style={{ flexShrink: 1 }}
              contentContainerStyle={styles.trayGrid}
            >
              {photos.map((p) => (
                <TrayTile
                  key={p.id}
                  photo={p}
                  size={tileSize}
                  onExpand={() => setExpandedId(p.id)}
                  onRemoved={onRemovedPhoto}
                />
              ))}
            </ScrollView>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: "#000" },
  topBar: {
    // Now flows in the column above `previewArea` (was absolute).
    paddingHorizontal: 14,
    paddingBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  glassBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  // Side clusters share a fixed width so the middle `projectBadge`
  // is true-screen-centered. Width = 2 × glassBtn (38) + gap (8) =
  // 84, matching the right cluster's natural content width. The
  // left cluster only contains 1 button but reserves the same
  // footprint to stay symmetric.
  topSideCluster: {
    width: 84,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  topSideClusterRight: {
    justifyContent: "flex-end",
  },
  projectBadge: {
    flex: 1,
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 100,
    maxWidth: 280,
    alignSelf: "center",
  },
  // Holds the rounded camera preview frame. Flex:1 absorbs all
  // vertical space between the top bar and the bottom control
  // stack; the frame inside centers within it. Background black
  // so the slack above/below the 3:4 frame on tall phones reads
  // as letterbox bars.
  previewArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  // The clipped 3:4 camera frame. width:'100%' + aspectRatio
  // makes it as wide as possible; maxHeight:'100%' clamps the
  // derived height on short phones (iPhone SE), at which point
  // Yoga shrinks the width back to maintain the 3:4 aspect.
  // CompanyCam parity: borderRadius: 22 — matches their visual
  // (more pronounced than 16, less than iOS card-large 28).
  previewFrame: {
    width: "100%",
    aspectRatio: 3 / 4,
    maxHeight: "100%",
    borderRadius: 22,
    overflow: "hidden",
    backgroundColor: "#000",
  },
  projectName: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  projectMeta: {
    color: "rgba(255,255,255,0.75)",
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    marginTop: 1,
  },
  // Burst / REC indicator pill, anchored to top-center of the
  // preview area (sibling of `previewFrame` inside `previewArea`).
  previewPillBurst: {
    position: "absolute",
    top: 10,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(0,0,0,0.65)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 100,
  },
  recDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#ef4444",
  },
  burstText: {
    color: "#fff",
    fontFamily: "Inter_700Bold",
    fontSize: 13,
    letterSpacing: 1.2,
  },
  // Session/status pill (saved-count, "Starting camera…", error
  // banner). Anchored to top-center of the preview area. Error
  // pill overrides `top` to 50 so it can stack below a regular
  // status pill when both render.
  previewPillSession: {
    position: "absolute",
    top: 10,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#fff",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 100,
  },
  sessionPillText: {
    color: "#111",
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  controlStack: {
    // Now flows in the column below `previewArea` (was absolute).
    paddingHorizontal: 28,
    gap: 10,
  },
  zoomRow: {
    alignItems: "center",
    marginBottom: 4,
  },
  zoomGroup: {
    borderRadius: 100,
    overflow: "hidden",
  },
  zoomGroupInner: {
    flexDirection: "row",
    backgroundColor: "rgba(0,0,0,0.45)",
    padding: 4,
    borderRadius: 100,
  },
  zoomBtn: {
    minWidth: 44,
    height: 32,
    paddingHorizontal: 10,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  zoomLabel: {
    fontSize: 12,
  },
  bottomBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 4,
  },
  sideBtn: {
    width: 56,
    height: 56,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  leftCluster: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  trayBtn: {
    width: 56,
    height: 56,
    borderRadius: 16,
    overflow: "visible",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  trayThumb: {
    width: 56,
    height: 56,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.85)",
  },
  trayBadge: {
    position: "absolute",
    top: -6,
    right: -6,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    alignItems: "center",
    justifyContent: "center",
  },
  trayBadgeText: {
    color: "#fff",
    fontFamily: "Inter_700Bold",
    fontSize: 11,
  },
  traySheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  traySheet: {
    backgroundColor: "#161616",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: "100%",
  },
  traySheetHandleRow: {
    alignItems: "center",
    paddingTop: 10,
    paddingBottom: 4,
  },
  traySheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.25)",
  },
  traySheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  traySheetTitle: {
    color: "#fff",
    fontFamily: "Inter_700Bold",
    fontSize: 16,
  },
  trayGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  trayTile: {
    // width/height set explicitly per-render from useWindowDimensions —
    // percentage widths collapse inside this Modal's ScrollView on device.
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: "#262626",
  },
  trayTileUploading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  trayTileDone: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "rgba(22,163,74,0.9)",
    alignItems: "center",
    justifyContent: "center",
  },
  trayTileFailed: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "rgba(220,38,38,0.9)",
    alignItems: "center",
    justifyContent: "center",
  },
  trayExpandedImg: {
    width: "100%",
    aspectRatio: 4 / 3,
    borderRadius: 12,
    backgroundColor: "#262626",
  },
  trayUploadingNote: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  trayUploadingNoteText: {
    color: "rgba(255,255,255,0.75)",
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  trayCommentRow: {
    gap: 2,
  },
  trayCommentAuthor: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  trayCommentMeta: {
    color: "rgba(255,255,255,0.5)",
    fontFamily: "Inter_500Medium",
    fontSize: 12,
  },
  trayCommentBody: {
    color: "rgba(255,255,255,0.85)",
    fontFamily: "Inter_400Regular",
    fontSize: 14,
  },
  trayCommentInputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    marginTop: 4,
  },
  trayCommentInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 100,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "rgba(255,255,255,0.08)",
    color: "#fff",
    fontFamily: "Inter_400Regular",
    fontSize: 14,
  },
  trayCommentSend: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  shutter: {
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: {},
  shutterInnerPhoto: {
    backgroundColor: "#fff",
    width: 64,
    height: 64,
    borderRadius: 32,
  },
  shutterInnerBurst: {
    backgroundColor: "#ef4444",
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  shutterInnerRec: {
    backgroundColor: "#ef4444",
    width: 64,
    height: 64,
    borderRadius: 32,
  },
  shutterInnerRecStop: {
    backgroundColor: "#ef4444",
    width: 30,
    height: 30,
    borderRadius: 6,
  },
  doneBtn: {
    minWidth: 76,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  doneText: {
    color: "#fff",
    fontFamily: "Inter_700Bold",
    fontSize: 15,
  },
  modeRow: {
    flexDirection: "row",
    alignSelf: "center",
    gap: 24,
    marginTop: 6,
  },
  modeBtn: {
    alignItems: "center",
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  modeLabel: {
    fontSize: 12,
    letterSpacing: 1.4,
  },
  modeDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    marginTop: 4,
  },
  modeDotPlaceholder: {
    width: 5,
    height: 5,
    marginTop: 4,
  },
  wtError: {
    color: "#fca5a5",
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    textAlign: "center",
    marginTop: 6,
    paddingHorizontal: 24,
  },
  wtIntroBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.65)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  wtIntroCard: {
    width: "100%",
    maxWidth: 340,
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    gap: 12,
  },
  wtIntroTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 18,
    textAlign: "center",
  },
  wtIntroBody: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
    marginBottom: 4,
  },
  hint: {
    color: "rgba(255,255,255,0.7)",
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    textAlign: "center",
    marginTop: 4,
  },
  permTitle: {
    color: "#fff",
    fontSize: 22,
    fontFamily: "Inter_700Bold",
  },
  permBody: {
    color: "rgba(255,255,255,0.8)",
    fontFamily: "Inter_400Regular",
    fontSize: 15,
    lineHeight: 22,
  },
});
