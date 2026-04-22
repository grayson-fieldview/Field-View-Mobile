import { Feather } from "@expo/vector-icons";
import * as Location from "expo-location";
import { useRouter } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { LoadingScreen } from "@/components/LoadingScreen";
import { QuickCaptureFAB } from "@/components/QuickCaptureFAB";
import { useData } from "@/contexts/DataContext";
import { useColors } from "@/hooks/useColors";

import { MapView, Marker, PROVIDER_DEFAULT } from "@/components/MapBackend";

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
        >
          {projectsWithCoords.map((p) => (
            <Marker
              key={p.id}
              coordinate={{
                latitude: p.latitude as number,
                longitude: p.longitude as number,
              }}
              title={p.name}
              description={p.address || undefined}
              pinColor={colors.primary}
              onCalloutPress={() => router.push(`/project/${p.id}`)}
            />
          ))}
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

      <QuickCaptureFAB />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
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
