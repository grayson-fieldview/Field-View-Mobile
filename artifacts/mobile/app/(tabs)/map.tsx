import { Feather } from "@expo/vector-icons";
import * as Location from "expo-location";
import { useRouter } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Dimensions,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { LoadingScreen } from "@/components/LoadingScreen";
import { useData } from "@/contexts/DataContext";
import { useColors } from "@/hooks/useColors";

import { MapView, Marker, PROVIDER_DEFAULT } from "@/components/MapBackend";

const BUBBLE_RADIUS_MILES = 3;
const BUBBLE_OVERLAP_W_PX = 160;
const BUBBLE_OVERLAP_H_PX = 36;
const MILES_PER_DEG_LAT = 69;

export default function MapScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { projects, ready } = useData();

  const [region, setRegion] = useState<{
    latitude: number;
    longitude: number;
    latitudeDelta: number;
    longitudeDelta: number;
  } | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const mapRef = useRef<any>(null);

  const projectsWithCoords = useMemo(
    () =>
      projects.filter(
        (p) => typeof p.latitude === "number" && typeof p.longitude === "number",
      ),
    [projects],
  );

  const markerModes = useMemo(() => {
    const modes = new Map<string, "pin" | "bubble">();
    if (!region || projectsWithCoords.length === 0) {
      for (const p of projectsWithCoords) modes.set(p.id, "pin");
      return modes;
    }
    const radiusMiles = (region.latitudeDelta * MILES_PER_DEG_LAT) / 2;
    if (radiusMiles > BUBBLE_RADIUS_MILES) {
      for (const p of projectsWithCoords) modes.set(p.id, "pin");
      return modes;
    }
    for (const p of projectsWithCoords) modes.set(p.id, "bubble");
    const { width: screenW, height: screenH } = Dimensions.get("window");
    const pxPerDegLng = screenW / region.longitudeDelta;
    const pxPerDegLat = screenH / region.latitudeDelta;
    for (let i = 0; i < projectsWithCoords.length; i++) {
      for (let j = i + 1; j < projectsWithCoords.length; j++) {
        const a = projectsWithCoords[i];
        const b = projectsWithCoords[j];
        const dx =
          Math.abs(
            (a.longitude as number) - (b.longitude as number),
          ) * pxPerDegLng;
        const dy =
          Math.abs(
            (a.latitude as number) - (b.latitude as number),
          ) * pxPerDegLat;
        if (dx < BUBBLE_OVERLAP_W_PX && dy < BUBBLE_OVERLAP_H_PX) {
          modes.set(a.id, "pin");
          modes.set(b.id, "pin");
        }
      }
    }
    return modes;
  }, [region, projectsWithCoords]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (Platform.OS === "web") return;
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") {
          if (!cancelled) {
            setPermissionDenied(true);
            // Fall back to centroid of project pins.
            if (projectsWithCoords.length > 0) {
              const avgLat =
                projectsWithCoords.reduce(
                  (s, p) => s + (p.latitude as number),
                  0,
                ) / projectsWithCoords.length;
              const avgLng =
                projectsWithCoords.reduce(
                  (s, p) => s + (p.longitude as number),
                  0,
                ) / projectsWithCoords.length;
              setRegion({
                latitude: avgLat,
                longitude: avgLng,
                latitudeDelta: 0.5,
                longitudeDelta: 0.5,
              });
            }
          }
          return;
        }
        const loc = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (cancelled) return;
        setRegion({
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05,
        });
      } catch {
        if (!cancelled) {
          setPermissionDenied(true);
          if (projectsWithCoords.length > 0) {
            const avgLat =
              projectsWithCoords.reduce(
                (s, p) => s + (p.latitude as number),
                0,
              ) / projectsWithCoords.length;
            const avgLng =
              projectsWithCoords.reduce(
                (s, p) => s + (p.longitude as number),
                0,
              ) / projectsWithCoords.length;
            setRegion({
              latitude: avgLat,
              longitude: avgLng,
              latitudeDelta: 0.5,
              longitudeDelta: 0.5,
            });
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectsWithCoords.length]);

  if (!ready) return <LoadingScreen />;

  if (Platform.OS === "web") {
    return (
      <View
        style={[
          styles.wrap,
          {
            backgroundColor: colors.background,
            paddingTop: insets.top + 80,
            padding: 24,
          },
        ]}
      >
        <Text style={{ color: colors.foreground, fontSize: 16 }}>
          The map view is available in the iOS and Android builds — open Field
          View on your phone to see all your project pins.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.wrap, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + 12,
            backgroundColor: colors.background,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <View>
          <Text style={[styles.eyebrow, { color: colors.mutedForeground }]}>
            FIELD VIEW
          </Text>
          <Text style={[styles.title, { color: colors.foreground }]}>Map</Text>
        </View>
        <Pressable
          accessibilityLabel="Recenter on me"
          onPress={async () => {
            try {
              const loc = await Location.getCurrentPositionAsync({
                accuracy: Location.Accuracy.Balanced,
              });
              const next = {
                latitude: loc.coords.latitude,
                longitude: loc.coords.longitude,
                latitudeDelta: 0.02,
                longitudeDelta: 0.02,
              };
              setRegion(next);
              mapRef.current?.animateToRegion(next, 400);
            } catch {
              /* noop */
            }
          }}
          style={({ pressed }) => [
            styles.recenter,
            {
              backgroundColor: colors.primary,
              opacity: pressed ? 0.85 : 1,
            },
          ]}
        >
          <Feather
            name="navigation"
            size={20}
            color={colors.primaryForeground}
          />
        </Pressable>
      </View>

      {region ? (
        <MapView
          ref={mapRef}
          provider={PROVIDER_DEFAULT}
          style={StyleSheet.absoluteFill}
          initialRegion={region}
          showsUserLocation={!permissionDenied}
          showsMyLocationButton={false}
          showsCompass
          onRegionChangeComplete={(r: typeof region) => r && setRegion(r)}
        >
          {projectsWithCoords.map((p) => {
            const mode = markerModes.get(p.id) ?? "pin";
            const coordinate = {
              latitude: p.latitude as number,
              longitude: p.longitude as number,
            };
            const onPress = () => router.push(`/project/${p.id}`);
            if (mode === "bubble") {
              return (
                <Marker
                  key={`${p.id}-bubble`}
                  coordinate={coordinate}
                  anchor={{ x: 0.5, y: 1 }}
                  onPress={onPress}
                  tracksViewChanges={false}
                >
                  <ProjectBubble
                    name={p.name}
                    bg={colors.card}
                    border={colors.border}
                    fg={colors.foreground}
                  />
                </Marker>
              );
            }
            return (
              <Marker
                key={`${p.id}-pin`}
                coordinate={coordinate}
                pinColor={colors.primary}
                onPress={onPress}
              />
            );
          })}
        </MapView>
      ) : (
        <View
          style={[
            StyleSheet.absoluteFill,
            { alignItems: "center", justifyContent: "center" },
          ]}
        >
          <Text style={{ color: colors.mutedForeground }}>
            {permissionDenied
              ? "Location permission denied. Showing project pins only."
              : "Locating you…"}
          </Text>
        </View>
      )}
    </View>
  );
}

function ProjectBubble({
  name,
  bg,
  border,
  fg,
}: {
  name: string;
  bg: string;
  border: string;
  fg: string;
}) {
  return (
    <View style={styles.bubbleWrap}>
      <View
        style={[styles.bubble, { backgroundColor: bg, borderColor: border }]}
      >
        <Text
          numberOfLines={1}
          ellipsizeMode="tail"
          style={[styles.bubbleText, { color: fg }]}
        >
          {name}
        </Text>
      </View>
      <View style={[styles.bubbleTail, { borderTopColor: bg }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  bubbleWrap: { alignItems: "center" },
  bubble: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 150,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  bubbleText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  bubbleTail: {
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderTopWidth: 6,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    marginTop: -StyleSheet.hairlineWidth,
  },
  header: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  eyebrow: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 2,
    marginBottom: 2,
  },
  title: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.6,
  },
  recenter: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
});
