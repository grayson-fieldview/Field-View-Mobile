import { Feather } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as FileSystem from "expo-file-system/legacy";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import * as MediaLibrary from "expo-media-library";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Sentry from "@sentry/react-native";

import { Button } from "@/components/Button";
import { LetterboxOverlay } from "@/components/LetterboxOverlay";
import { useAuth } from "@/contexts/AuthContext";
import { useData } from "@/contexts/DataContext";
import { useColors } from "@/hooks/useColors";
import {
  cropToAspectRatio,
  DEFAULT_PHOTO_ASPECT_RATIO,
} from "@/services/imageProcessing";
import type { Photo } from "@/services/types";

const HOLD_TO_BURST_MS = 350;

type ZoomPreset = { label: string; value: number };
const ZOOM_PRESETS: ZoomPreset[] = [
  { label: ".5x", value: 0 },
  { label: "1x", value: 0.05 },
  { label: "4x", value: 0.45 },
];

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heic",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
};

interface PreparedUpload {
  localUri: string;
  originalName: string;
  mimeType: string;
  fileSize: number;
}

/**
 * Copies a captured (or imported) file from its temporary location into the
 * app's private cache directory under `fieldview/photos/`. Returns metadata
 * suitable for the upload queue. Returns null on web (no cacheDirectory) or
 * if the copy fails — callers should fall back to using the source uri
 * without enqueueing.
 */
async function prepareForUpload(
  sourceUri: string,
  fallbackMime = "image/jpeg",
): Promise<PreparedUpload | null> {
  try {
    if (!FileSystem.cacheDirectory) {
      // Web or sandboxed env — no stable cache dir to copy into.
      return null;
    }
    const dir = `${FileSystem.cacheDirectory}fieldview/photos/`;
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(
      () => {
        /* already exists */
      },
    );

    // Derive extension from source uri (strip query string if any).
    const qIdx = sourceUri.indexOf("?");
    const cleanUri = qIdx >= 0 ? sourceUri.slice(0, qIdx) : sourceUri;
    const dotIdx = cleanUri.lastIndexOf(".");
    const rawExt = dotIdx > 0 ? cleanUri.slice(dotIdx + 1).toLowerCase() : "";
    const safeExt = /^[a-z0-9]{1,4}$/.test(rawExt) ? rawExt : "jpg";
    const mimeType = MIME_BY_EXT[safeExt] ?? fallbackMime;

    const originalName = `${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}.${safeExt}`;
    const localUri = `${dir}${originalName}`;

    await FileSystem.copyAsync({ from: sourceUri, to: localUri });
    const info = await FileSystem.getInfoAsync(localUri);
    const fileSize = (info as { size?: number }).size ?? 0;

    console.log(
      `[capture] prepared ${originalName} (${mimeType}, ${fileSize} bytes) at ${localUri}`,
    );
    return { localUri, originalName, mimeType, fileSize };
  } catch (e) {
    console.log("[capture] prepareForUpload failed:", e);
    return null;
  }
}

export default function CaptureScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { projectId, checklistItemId } = useLocalSearchParams<{
    projectId: string;
    /**
     * Optional. When set, every photo captured (single shot OR burst) in
     * this session is auto-attached to the named checklist item once it
     * finishes uploading. Forwarded into the upload-queue entries so the
     * post-upload tagger calls api.attachPhotoToItem on success.
     */
    checklistItemId?: string;
  }>();
  const { projects, addPhoto, addPhotosBatch } = useData();
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
  const [mode, setMode] = useState<"photo" | "video">("photo");
  const [zoomIdx, setZoomIdx] = useState(1); // default 1x
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
      mountedRef.current = false;
      burstActive.current = false;
      if (holdTimer.current) {
        clearTimeout(holdTimer.current);
        holdTimer.current = null;
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
    return () => clearTimeout(t);
  }, [statusMsg]);

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
        await addPhoto({
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
        });
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
      await addPhotosBatch(
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
        })),
      );
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
      const result = await cameraRef.current.recordAsync({ maxDuration: 300 });
      setRecording(false);
      if (result?.uri) {
        // Save to camera roll if available (best-effort, independent of upload).
        try {
          const perm = await MediaLibrary.requestPermissionsAsync();
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
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setErrorMsg("Photo library access denied.");
        return;
      }
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
          latitude: locationCoord?.latitude,
          longitude: locationCoord?.longitude,
          accuracy: locationCoord?.accuracy,
          originalName: p?.originalName,
          mimeType: p?.mimeType,
          fileSize: p?.fileSize,
          checklistItemId,
        })),
      );
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

  // Differentiate tap vs. hold for the shutter.
  const onShutterPressIn = () => {
    if (!cameraReady) return;
    if (mode === "video") return; // video uses tap-to-start, tap-to-stop
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

  const zoomValue = ZOOM_PRESETS[zoomIdx]?.value ?? 0.05;

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
        <View style={styles.previewFrame}>
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing={facing}
            flash={flash}
            zoom={zoomValue}
            mode={mode}
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
          {mode === "photo" ? (
            <LetterboxOverlay ratio={captureAspectRatio} />
          ) : null}
        </View>

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
                const active = i === zoomIdx;
                return (
                  <Pressable
                    key={z.label}
                    onPress={() => {
                      Haptics.selectionAsync().catch(() => {});
                      setZoomIdx(i);
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
                      {z.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </BlurView>
        </View>

        {/* Bottom main row: gallery, shutter, done */}
        <View style={styles.bottomBar}>
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
            onPress={() => router.back()}
            disabled={saving || recording}
            accessibilityLabel="Done"
            style={({ pressed }) => [
              styles.doneBtn,
              {
                backgroundColor: "rgba(255,255,255,0.16)",
                opacity: saving || recording ? 0.4 : pressed ? 0.8 : 1,
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
          {(["photo", "video"] as const).map((m) => {
            const active = mode === m;
            return (
              <Pressable
                key={m}
                onPress={() => {
                  if (recording) return;
                  Haptics.selectionAsync().catch(() => {});
                  setMode(m);
                }}
                disabled={recording}
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

        {/* Hint */}
        <Text style={styles.hint}>
          {mode === "video"
            ? recording
              ? "Tap to stop"
              : "Tap to record"
            : bursting
              ? "Hold to keep capturing…"
              : "Tap for one photo · Hold for burst"}
        </Text>
      </View>
    </View>
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
