import { Feather } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import * as Location from "expo-location";
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

import { Button } from "@/components/Button";
import { useData } from "@/contexts/DataContext";
import { useColors } from "@/hooks/useColors";
import type { Photo } from "@/services/types";

export default function CaptureScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const { projects, addPhotosBatch } = useData();
  const project = projects.find((p) => p.id === projectId);

  const [permission, requestPermission] = useCameraPermissions();
  const [locationGranted, setLocationGranted] = useState<boolean | null>(null);
  const [locationCoord, setLocationCoord] = useState<
    Pick<Photo, "latitude" | "longitude" | "accuracy"> | null
  >(null);
  const [facing, setFacing] = useState<"back" | "front">("back");
  const [flash, setFlash] = useState<"off" | "on" | "auto">("off");
  const [bursting, setBursting] = useState(false);
  const [captureCount, setCaptureCount] = useState(0);
  const [sessionCount, setSessionCount] = useState(0);
  const [saving, setSaving] = useState(false);

  const cameraRef = useRef<CameraView | null>(null);
  const burstActive = useRef(false);

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

  if (!project) {
    return (
      <View style={[styles.wrap, { backgroundColor: "#000" }]}>
        <Text style={{ color: "#fff", textAlign: "center", marginTop: 100 }}>
          Project not found.
        </Text>
        <View style={{ padding: 20 }}>
          <Button title="Close" onPress={() => router.back()} variant="secondary" />
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
          { backgroundColor: "#000", paddingTop: insets.top + 40, padding: 24, gap: 16 },
        ]}
      >
        <Feather name="camera" size={36} color={colors.primary} />
        <Text style={styles.permTitle}>Camera access needed</Text>
        <Text style={styles.permBody}>
          Field View needs your camera to capture project photos. You can revoke access anytime from system settings.
        </Text>
        <Button title="Grant camera access" onPress={requestPermission} size="lg" />
        <Button title="Cancel" variant="ghost" onPress={() => router.back()} />
      </View>
    );
  }

  const buffer = useRef<
    Array<{ uri: string; takenAt: string; latitude?: number; longitude?: number; accuracy?: number }>
  >([]);

  const captureOnce = async () => {
    if (!cameraRef.current) return;
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.7,
        skipProcessing: true,
        exif: false,
      });
      if (!photo?.uri) return;
      buffer.current.push({
        uri: photo.uri,
        takenAt: new Date().toISOString(),
        latitude: locationCoord?.latitude,
        longitude: locationCoord?.longitude,
        accuracy: locationCoord?.accuracy,
      });
      setCaptureCount((c) => c + 1);
    } catch {
      /* drop */
    }
  };

  const startBurst = async () => {
    if (bursting || saving) return;
    burstActive.current = true;
    setBursting(true);
    buffer.current = [];
    setCaptureCount(0);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});

    // Fire captures as fast as the camera allows, without awaiting between shots
    // to maintain 5+ photos per second on modern devices.
    while (burstActive.current) {
      await captureOnce();
    }
  };

  const stopBurst = async () => {
    if (!bursting) return;
    burstActive.current = false;
    setBursting(false);
    setSaving(true);
    try {
      if (buffer.current.length > 0) {
        await addPhotosBatch(
          buffer.current.map((b) => ({
            projectId: project.id,
            uri: b.uri,
            takenAt: b.takenAt,
            latitude: b.latitude,
            longitude: b.longitude,
            accuracy: b.accuracy,
          })),
        );
        setSessionCount((s) => s + buffer.current.length);
        buffer.current = [];
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      }
    } finally {
      setSaving(false);
      setCaptureCount(0);
    }
  };

  const toggleFacing = () =>
    setFacing((f) => (f === "back" ? "front" : "back"));
  const toggleFlash = () =>
    setFlash((f) => (f === "off" ? "on" : f === "on" ? "auto" : "off"));

  return (
    <View style={styles.wrap}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={facing}
        flash={flash}
      />

      <View style={[styles.topBar, { paddingTop: insets.top + 10 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.circleBtn}>
          <Feather name="x" size={22} color="#fff" />
        </Pressable>

        <View style={styles.projectBadge}>
          <Text style={styles.projectName} numberOfLines={1}>
            {project.name}
          </Text>
          <Text style={styles.projectMeta}>
            {locationCoord
              ? `GPS · ${locationCoord.latitude?.toFixed(4)}, ${locationCoord.longitude?.toFixed(4)}`
              : locationGranted === false
                ? "GPS off"
                : "Acquiring GPS…"}
          </Text>
        </View>

        <Pressable onPress={toggleFlash} hitSlop={12} style={styles.circleBtn}>
          <Feather
            name={flash === "off" ? "zap-off" : "zap"}
            size={20}
            color={flash === "on" ? colors.primary : "#fff"}
          />
        </Pressable>
      </View>

      {bursting ? (
        <View style={styles.burstIndicator}>
          <View style={styles.recDot} />
          <Text style={styles.burstText}>BURST · {captureCount}</Text>
        </View>
      ) : sessionCount > 0 ? (
        <View style={styles.sessionPill}>
          <Feather name="check" size={14} color="#111" />
          <Text style={styles.sessionPillText}>
            {sessionCount} photo{sessionCount === 1 ? "" : "s"} saved
          </Text>
        </View>
      ) : null}

      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 20 }]}>
        <Pressable onPress={toggleFacing} hitSlop={12} style={styles.sideBtn}>
          <Feather name="refresh-ccw" size={22} color="#fff" />
        </Pressable>

        <Pressable
          onPressIn={startBurst}
          onPressOut={stopBurst}
          style={({ pressed }) => [
            styles.shutter,
            { transform: [{ scale: pressed || bursting ? 0.94 : 1 }] },
          ]}
        >
          <View
            style={[
              styles.shutterInner,
              {
                backgroundColor: bursting ? colors.destructive : "#fff",
                borderRadius: bursting ? 16 : 34,
                width: bursting ? 36 : 64,
                height: bursting ? 36 : 64,
              },
            ]}
          />
        </Pressable>

        <View style={styles.sideBtn}>
          {saving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Pressable onPress={() => router.back()} hitSlop={12}>
              <Feather name="check-circle" size={22} color="#fff" />
            </Pressable>
          )}
        </View>
      </View>

      <View style={[styles.hintWrap, { bottom: insets.bottom + 120 }]}>
        <Text style={styles.hint}>
          {bursting ? "Hold to keep capturing…" : "Press and hold to burst-capture"}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: "#000" },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  circleBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  projectBadge: {
    flex: 1,
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 100,
    maxWidth: 280,
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
  burstIndicator: {
    position: "absolute",
    top: "40%",
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(0,0,0,0.65)",
    paddingHorizontal: 16,
    paddingVertical: 10,
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
    fontSize: 14,
    letterSpacing: 1.2,
  },
  sessionPill: {
    position: "absolute",
    top: 110,
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
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sideBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  shutter: {
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 4,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: {
    backgroundColor: "#fff",
  },
  hintWrap: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  hint: {
    color: "rgba(255,255,255,0.85)",
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    backgroundColor: "rgba(0,0,0,0.35)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 100,
    overflow: "hidden",
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
