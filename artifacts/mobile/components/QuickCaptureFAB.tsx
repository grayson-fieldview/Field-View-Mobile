import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as Location from "expo-location";
import { useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useData } from "@/contexts/DataContext";
import { useColors } from "@/hooks/useColors";
import type { Project } from "@/services/types";

function haversineMiles(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

type Nearest = {
  project: Project;
  distance: number | null;
};

export function QuickCaptureFAB() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { projects } = useData();

  const [open, setOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [nearest, setNearest] = useState<Nearest | null>(null);
  const [otherChoices, setOtherChoices] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);

  const projectsWithCoords = useMemo(
    () =>
      projects.filter(
        (p) => typeof p.latitude === "number" && typeof p.longitude === "number",
      ),
    [projects],
  );

  const openSheet = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setOpen(true);
    setError(null);
    setResolving(true);
    setNearest(null);
    setOtherChoices([]);

    try {
      let coords: { latitude: number; longitude: number } | null = null;

      if (Platform.OS !== "web") {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === "granted") {
          try {
            const loc = await Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.Balanced,
            });
            coords = {
              latitude: loc.coords.latitude,
              longitude: loc.coords.longitude,
            };
          } catch {
            /* swallow */
          }
        }
      }

      if (coords && projectsWithCoords.length > 0) {
        const ranked = projectsWithCoords
          .map((p) => ({
            project: p,
            distance: haversineMiles(coords!, {
              latitude: p.latitude as number,
              longitude: p.longitude as number,
            }),
          }))
          .sort((a, b) => a.distance - b.distance);
        setNearest(ranked[0]);
        setOtherChoices(ranked.slice(1, 4).map((r) => r.project));
      } else if (projects.length > 0) {
        // Fallback: most recently created project.
        const sorted = [...projects].sort((a, b) =>
          (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
        );
        setNearest({ project: sorted[0], distance: null });
        setOtherChoices(sorted.slice(1, 4));
        if (!coords) {
          setError(
            "Location unavailable — showing your most recent project instead.",
          );
        } else {
          setError("None of your projects have a saved location yet.");
        }
      } else {
        setError("You don't have any projects yet. Create one first.");
      }
    } finally {
      setResolving(false);
    }
  };

  const goToCapture = (projectId: string) => {
    setOpen(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
      () => {},
    );
    router.push({ pathname: "/capture", params: { projectId } });
  };

  return (
    <>
      <Pressable
        onPress={openSheet}
        accessibilityRole="button"
        accessibilityLabel="Quick capture: take photos at the project closest to you"
        // Sits half above / half over the tab bar (matches reference UI).
        // Tab bar heights vary: iOS ~49 + safe area, Android ~56, web 84.
        style={({ pressed }) => [
          styles.fab,
          {
            bottom:
              Platform.OS === "web"
                ? 84 - FAB_H / 2 + 6
                : Platform.OS === "ios"
                  ? insets.bottom + 49 - FAB_H / 2 + 4
                  : insets.bottom + 56 - FAB_H / 2 + 4,
            backgroundColor: colors.primary,
            transform: [{ scale: pressed ? 0.95 : 1 }],
            shadowColor: "#000",
          },
        ]}
      >
        <Feather name="camera" size={28} color={colors.primaryForeground} />
      </Pressable>

      <Modal
        transparent
        animationType="fade"
        visible={open}
        onRequestClose={() => setOpen(false)}
      >
        <Pressable
          style={styles.scrim}
          onPress={() => setOpen(false)}
          accessibilityLabel="Dismiss"
        >
          <Pressable
            onPress={() => {}}
            style={[
              styles.sheet,
              {
                backgroundColor: colors.background,
                paddingBottom: insets.bottom + 20,
                borderColor: colors.border,
              },
            ]}
          >
            <View style={styles.handle} />

            <View style={styles.headerRow}>
              <View
                style={[
                  styles.iconBubble,
                  { backgroundColor: colors.primary + "22" },
                ]}
              >
                <Feather name="camera" size={20} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.title, { color: colors.foreground }]}>
                  Quick capture
                </Text>
                <Text
                  style={[styles.subtitle, { color: colors.mutedForeground }]}
                >
                  Confirm where to start shooting.
                </Text>
              </View>
            </View>

            {resolving ? (
              <View style={styles.loadingBlock}>
                <ActivityIndicator color={colors.primary} />
                <Text
                  style={[
                    styles.loadingText,
                    { color: colors.mutedForeground },
                  ]}
                >
                  Finding the project closest to you…
                </Text>
              </View>
            ) : nearest ? (
              <>
                <View
                  style={[
                    styles.nearestCard,
                    {
                      backgroundColor: colors.muted,
                      borderColor: colors.border,
                    },
                  ]}
                >
                  <View style={styles.nearestRow}>
                    <Feather
                      name="map-pin"
                      size={16}
                      color={colors.primary}
                    />
                    <Text
                      style={[
                        styles.nearestLabel,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      {nearest.distance != null
                        ? nearest.distance < 0.1
                          ? "You're here"
                          : `${nearest.distance.toFixed(
                              nearest.distance < 10 ? 1 : 0,
                            )} mi away`
                        : "Most recent project"}
                    </Text>
                  </View>
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.nearestName,
                      { color: colors.foreground },
                    ]}
                  >
                    {nearest.project.name}
                  </Text>
                  {nearest.project.address ? (
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.nearestAddress,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      {nearest.project.address}
                    </Text>
                  ) : null}
                </View>

                {error ? (
                  <Text
                    style={[
                      styles.errorText,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    {error}
                  </Text>
                ) : null}

                <Pressable
                  onPress={() => goToCapture(nearest.project.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Start camera for ${nearest.project.name}`}
                  style={({ pressed }) => [
                    styles.primaryBtn,
                    {
                      backgroundColor: colors.primary,
                      opacity: pressed ? 0.92 : 1,
                    },
                  ]}
                >
                  <Feather
                    name="camera"
                    size={18}
                    color={colors.primaryForeground}
                  />
                  <Text
                    style={[
                      styles.primaryBtnText,
                      { color: colors.primaryForeground },
                    ]}
                  >
                    Start camera here
                  </Text>
                </Pressable>

                {otherChoices.length > 0 ? (
                  <View style={{ marginTop: 16 }}>
                    <Text
                      style={[
                        styles.sectionLabel,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      Or pick another
                    </Text>
                    {otherChoices.map((p) => (
                      <Pressable
                        key={p.id}
                        onPress={() => goToCapture(p.id)}
                        style={({ pressed }) => [
                          styles.altRow,
                          {
                            borderColor: colors.border,
                            opacity: pressed ? 0.7 : 1,
                          },
                        ]}
                      >
                        <Feather
                          name="folder"
                          size={16}
                          color={colors.mutedForeground}
                        />
                        <Text
                          numberOfLines={1}
                          style={[
                            styles.altText,
                            { color: colors.foreground },
                          ]}
                        >
                          {p.name}
                        </Text>
                        <Feather
                          name="chevron-right"
                          size={16}
                          color={colors.mutedForeground}
                        />
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </>
            ) : (
              <View style={styles.loadingBlock}>
                <Feather
                  name="alert-circle"
                  size={22}
                  color={colors.mutedForeground}
                />
                <Text
                  style={[
                    styles.loadingText,
                    { color: colors.mutedForeground, textAlign: "center" },
                  ]}
                >
                  {error ?? "No projects available."}
                </Text>
              </View>
            )}

            <Pressable
              onPress={() => setOpen(false)}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              style={styles.cancelBtn}
            >
              <Text
                style={[
                  styles.cancelText,
                  { color: colors.mutedForeground },
                ]}
              >
                Cancel
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const FAB_W = 64;
const FAB_H = 76;

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    left: 0,
    right: 0,
    alignSelf: "center",
    marginHorizontal: "auto",
    width: FAB_W,
    height: FAB_H,
    borderRadius: FAB_W / 2,
    alignItems: "center",
    justifyContent: "center",
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 16,
    zIndex: 1000,
  },
  scrim: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  handle: {
    alignSelf: "center",
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: "rgba(127,127,127,0.35)",
    marginBottom: 14,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 16,
  },
  iconBubble: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontFamily: "Inter_700Bold", fontSize: 18 },
  subtitle: { fontFamily: "Inter_400Regular", fontSize: 13, marginTop: 2 },
  loadingBlock: {
    paddingVertical: 28,
    alignItems: "center",
    gap: 10,
  },
  loadingText: { fontFamily: "Inter_500Medium", fontSize: 13 },
  nearestCard: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
  },
  nearestRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
  },
  nearestLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  nearestName: { fontFamily: "Inter_700Bold", fontSize: 17 },
  nearestAddress: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    marginTop: 2,
  },
  errorText: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    marginBottom: 12,
  },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 52,
    borderRadius: 100,
  },
  primaryBtnText: { fontFamily: "Inter_700Bold", fontSize: 15 },
  sectionLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  altRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  altText: { flex: 1, fontFamily: "Inter_500Medium", fontSize: 14 },
  cancelBtn: { alignItems: "center", paddingVertical: 14, marginTop: 6 },
  cancelText: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
});
