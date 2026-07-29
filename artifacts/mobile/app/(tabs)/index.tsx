import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";

import { ThumbImage } from "@/components/ThumbImage";
import { thumbKeyForUri } from "@/services/thumbnails";
import * as Location from "expo-location";
import { useFocusEffect, useRouter } from "expo-router";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AppState,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { LoadingScreen } from "@/components/LoadingScreen";
import { useData } from "@/contexts/DataContext";
import { useColors } from "@/hooks/useColors";
import type { Project } from "@/services/types";

type SortMode = "nearby" | "recent";

const METERS_PER_MILE = 1609.344;

function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
) {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function formatMiles(meters: number): string {
  const miles = meters / METERS_PER_MILE;
  if (miles < 0.1) {
    const feet = Math.round(meters * 3.28084);
    return `${feet} ft`;
  }
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}

export default function ProjectsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { projects, photos, tasks, ready, syncError, refresh } = useData();

  // Refresh whenever the screen gains focus. The DataContext throttles this
  // internally so it's safe to call frequently.
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const [sortMode, setSortMode] = useState<SortMode>("nearby");
  const [query, setQuery] = useState("");
  // Track ONLY user-initiated pull-to-refresh. Bound to the FlatList's
  // `refreshing` prop so iOS doesn't animate the RefreshControl inset
  // for programmatic background refreshes (focus/foreground), which
  // produced a glitchy empty gap at the top of the list on back-nav.
  // The global DataContext `syncing` state is intentionally NOT used here.
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [userLoc, setUserLoc] = useState<{ lat: number; lng: number } | null>(
    null,
  );

  // Refresh the foreground GPS fix that powers "Nearby" sort + the
  // distance labels under each project card. Called on:
  //   - initial mount
  //   - tab focus (back-nav from project detail, tab switch back)
  //   - AppState → "active" (foreground after background)
  // Without these triggers, the fix is taken once at mount and goes
  // permanently stale until the JS bundle restarts — so distances
  // and "Nearby" sort order frozen at wherever the user opened the
  // app, regardless of subsequent movement.
  //
  // CHECK-ONLY (Build 23 follow-up — Issue 2 hardening).
  // This screen MUST NEVER call requestForegroundPermissionsAsync.
  // (onboarding)/location is the single owner of the foreground
  // permission prompt — having (tabs)/index also prompt was the
  // structural defect that surfaced the iOS dialog before the
  // onboarding pre-prompt could render on cold launch (because
  // (tabs)/index briefly mounted in the AuthGate-routing window).
  // If permission isn't granted yet, we silently skip location.
  // `filteredAndSorted` below already falls back to createdAt
  // ordering when userLoc === null, so the UX degradation is just
  // "no distance labels + no Nearby sort" until the user finishes
  // onboarding — which on next focus/foreground transition will
  // pick up the fix automatically without any further code change.
  //
  // Concurrency: mount + focus + AppState→active can fire in quick
  // succession on cold-launch. `requestIdRef` is a monotonically
  // increasing counter; only the response from the latest request
  // is allowed to write state, so an older slow fetch can't
  // overwrite a newer one (last-writer-wins → newest-writer-wins).
  // `mountedRef` blocks setState after unmount to silence the React
  // "update on unmounted component" dev warning.
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshUserLoc = useCallback(async () => {
    if (Platform.OS === "web") return;
    const myId = ++requestIdRef.current;
    try {
      const existing = await Location.getForegroundPermissionsAsync();
      if (existing.status !== "granted") {
        // Not granted yet — silent no-op. Do NOT prompt here; the
        // onboarding flow owns the request. Sort falls back to
        // createdAt via the !userLoc branch in filteredAndSorted.
        return;
      }
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      if (!mountedRef.current) return;
      if (myId !== requestIdRef.current) return;
      setUserLoc({
        lat: loc.coords.latitude,
        lng: loc.coords.longitude,
      });
    } catch {
      /* ignore — keep last good fix */
    }
  }, []);

  // Initial fix on mount.
  useEffect(() => {
    void refreshUserLoc();
  }, [refreshUserLoc]);

  // Tab focus → re-fetch (covers back-nav from project detail after
  // driving, tab switch back to Projects).
  useFocusEffect(
    useCallback(() => {
      void refreshUserLoc();
    }, [refreshUserLoc]),
  );

  // AppState → "active" → re-fetch (covers app foregrounded after
  // backgrounded; the user driving with the app off-screen).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshUserLoc();
    });
    return () => sub.remove();
  }, [refreshUserLoc]);

  const stats = useMemo(() => {
    const byProject = new Map<
      string,
      { photos: number; openTasks: number }
    >();
    for (const p of projects)
      byProject.set(p.id, {
        photos: typeof p.photoCount === "number" ? p.photoCount : 0,
        openTasks: 0,
      });
    for (const ph of photos) {
      if (ph.remote) continue;
      const s = byProject.get(ph.projectId);
      if (s) s.photos += 1;
    }
    for (const t of tasks) {
      if (t.done) continue;
      const s = byProject.get(t.projectId);
      if (s) s.openTasks += 1;
    }
    return byProject;
  }, [projects, photos, tasks]);

  const coverFor = useMemo(() => {
    const m = new Map<string, string | undefined>();
    for (const p of projects) m.set(p.id, p.coverPhotoUrl);
    for (const ph of photos) {
      if (m.get(ph.projectId)) continue;
      m.set(ph.projectId, ph.uri);
    }
    return m;
  }, [projects, photos]);

  const filteredAndSorted = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? projects.filter((p) => {
          return (
            p.name.toLowerCase().includes(q) ||
            (p.address ?? "").toLowerCase().includes(q) ||
            (p.client ?? "").toLowerCase().includes(q)
          );
        })
      : projects;

    if (sortMode === "recent" || !userLoc) {
      return [...filtered].sort((a, b) =>
        (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
      );
    }
    return [...filtered].sort((a, b) => {
      const da =
        a.latitude != null && a.longitude != null
          ? distanceMeters(userLoc, { lat: a.latitude, lng: a.longitude })
          : Number.POSITIVE_INFINITY;
      const db =
        b.latitude != null && b.longitude != null
          ? distanceMeters(userLoc, { lat: b.latitude, lng: b.longitude })
          : Number.POSITIVE_INFINITY;
      if (da === db)
        return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
      return da - db;
    });
  }, [projects, query, sortMode, userLoc]);

  const distanceLabelFor = (p: Project): string | null => {
    if (sortMode !== "nearby" || !userLoc) return null;
    if (p.latitude == null || p.longitude == null) return null;
    return formatMiles(
      distanceMeters(userLoc, {
        lat: p.latitude,
        lng: p.longitude,
      }),
    );
  };

  if (!ready) return <LoadingScreen />;

  return (
    <View style={[styles.wrap, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + (Platform.OS === "web" ? 67 : 12),
            borderBottomColor: colors.border,
          },
        ]}
      >
        <View>
          <Text style={[styles.eyebrow, { color: colors.mutedForeground }]}>
            FIELD VIEW
          </Text>
          <Text style={[styles.title, { color: colors.foreground }]}>
            Projects
          </Text>
        </View>
        <Pressable
          accessibilityLabel="New project"
          onPress={() => router.push("/project/new")}
          style={({ pressed }) => [
            styles.plus,
            {
              backgroundColor: colors.primary,
              opacity: pressed ? 0.85 : 1,
            },
          ]}
        >
          <Feather name="plus" size={22} color={colors.primaryForeground} />
        </Pressable>
      </View>

      <View style={styles.toggleRow}>
        <SortToggle
          icon="map-pin"
          label="Nearby"
          active={sortMode === "nearby"}
          onPress={() => setSortMode("nearby")}
        />
        <SortToggle
          icon="clock"
          label="Recent"
          active={sortMode === "recent"}
          onPress={() => setSortMode("recent")}
        />
      </View>

      <View
        style={[
          styles.searchWrap,
          {
            backgroundColor: colors.muted,
            borderColor: colors.border,
          },
        ]}
      >
        <Feather name="search" size={16} color={colors.mutedForeground} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search projects, address, client…"
          placeholderTextColor={colors.mutedForeground}
          style={[styles.searchInput, { color: colors.foreground }]}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
        />
        {query ? (
          <Pressable
            onPress={() => setQuery("")}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
          >
            <Feather
              name="x-circle"
              size={16}
              color={colors.mutedForeground}
            />
          </Pressable>
        ) : null}
      </View>

      {syncError ? (
        <Pressable
          onPress={() => refresh()}
          style={{
            marginHorizontal: 16,
            marginTop: 8,
            padding: 12,
            borderRadius: 10,
            backgroundColor: colors.card,
            borderWidth: 1,
            borderColor: colors.destructive,
          }}
        >
          <Text
            style={{
              color: colors.destructive,
              fontFamily: "Inter_500Medium",
              fontSize: 13,
            }}
          >
            Couldn’t load projects from the server. Tap to retry.
          </Text>
          <Text
            style={{
              color: colors.mutedForeground,
              fontSize: 11,
              marginTop: 4,
              fontFamily: "Inter_400Regular",
            }}
            numberOfLines={2}
          >
            {syncError}
          </Text>
        </Pressable>
      ) : null}

      <FlatList
        data={filteredAndSorted}
        keyExtractor={(item) => item.id}
        refreshing={pullRefreshing}
        onRefresh={async () => {
          setPullRefreshing(true);
          try {
            await refresh({ force: true });
          } finally {
            setPullRefreshing(false);
          }
        }}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          padding: 16,
          paddingBottom: insets.bottom + 110,
          gap: 12,
          flexGrow: 1,
        }}
        renderItem={({ item }) => (
          <ProjectCard
            project={item}
            cover={coverFor.get(item.id)}
            photoCount={stats.get(item.id)?.photos ?? 0}
            openTaskCount={stats.get(item.id)?.openTasks ?? 0}
            distanceLabel={distanceLabelFor(item)}
            onPress={() => router.push(`/project/${item.id}`)}
          />
        )}
        ListEmptyComponent={
          <View style={{ flex: 1, justifyContent: "center", paddingTop: 60 }}>
            {query ? (
              <EmptyState
                icon="search"
                title="No matches"
                description={`Nothing matches "${query}". Try a different search.`}
              />
            ) : (
              <EmptyState
                icon="folder"
                title="No projects yet"
                description="Create your first project to start capturing photos, tasks, and checklists."
                action={
                  <Button
                    title="Create project"
                    onPress={() => router.push("/project/new")}
                  />
                }
              />
            )}
          </View>
        }
      />
    </View>
  );
}

function SortToggle({
  icon,
  label,
  active,
  onPress,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.toggle,
        {
          backgroundColor: active ? colors.primary : colors.muted,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <Feather
        name={icon}
        size={14}
        color={active ? colors.primaryForeground : colors.foreground}
      />
      <Text
        style={[
          styles.toggleLabel,
          {
            color: active ? colors.primaryForeground : colors.foreground,
          },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function ProjectCard({
  project,
  cover,
  photoCount,
  openTaskCount,
  distanceLabel,
  onPress,
}: {
  project: Project;
  cover?: string;
  photoCount: number;
  openTaskCount: number;
  distanceLabel: string | null;
  onPress: () => void;
}) {
  const colors = useColors();
  const status = (project.status ?? "active").toLowerCase();
  const statusColor =
    status === "active"
      ? colors.primary
      : status === "complete" || status === "completed"
        ? colors.success
        : colors.mutedForeground;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          opacity: pressed ? 0.95 : 1,
          transform: [{ scale: pressed ? 0.99 : 1 }],
        },
      ]}
    >
      <View style={[styles.cover, { backgroundColor: colors.muted }]}>
        {cover ? (
          // Bounded decode (memory fix part C): covers are ORIGINAL S3
          // urls (recentPhotos[0].url) — thumbnail them like grid tiles
          // so memory pressure doesn't start on the project list.
          <ThumbImage
            cacheKey={`cover-${thumbKeyForUri(cover)}`}
            uri={cover}
            style={StyleSheet.absoluteFill as never}
          />
        ) : (
          <View
            style={[
              StyleSheet.absoluteFill,
              { alignItems: "center", justifyContent: "center" },
            ]}
          >
            <Feather name="image" size={24} color={colors.mutedForeground} />
          </View>
        )}
      </View>

      <View style={styles.cardBody}>
        <Text
          style={[styles.cardTitle, { color: colors.foreground }]}
          numberOfLines={1}
        >
          {project.name}
        </Text>
        <Text
          style={[styles.cardMeta, { color: colors.mutedForeground }]}
          numberOfLines={1}
        >
          {project.address || project.client || "No address"}
        </Text>
        {distanceLabel ? (
          <View style={styles.distanceRow}>
            <Feather name="navigation" size={11} color={colors.primary} />
            <Text style={[styles.distance, { color: colors.primary }]}>
              {distanceLabel}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.cardRight}>
        <RightStat
          icon="camera"
          value={photoCount}
          color={colors.foreground}
          muted={colors.mutedForeground}
        />
        <RightStat
          icon="check-square"
          value={openTaskCount}
          color={colors.foreground}
          muted={colors.mutedForeground}
        />
        <View
          style={[
            styles.statusPill,
            { backgroundColor: statusColor + "22" },
          ]}
        >
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
        </View>
      </View>
    </Pressable>
  );
}

function RightStat({
  icon,
  value,
  color,
  muted,
}: {
  icon: keyof typeof Feather.glyphMap;
  value: number | string;
  color: string;
  muted: string;
}) {
  return (
    <View style={styles.rightStat}>
      <Feather name={icon} size={12} color={muted} />
      <Text style={[styles.rightStatValue, { color }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  eyebrow: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 2,
    marginBottom: 2,
  },
  title: {
    fontSize: 32,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.8,
  },
  plus: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  toggleRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
    gap: 10,
  },
  toggle: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 11,
    borderRadius: 100,
  },
  toggleLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 4,
    // Breathing room between the (non-sticky) search bar and the
    // FlatList viewport below — without this, scrolling cards clip
    // flush against the search bar's bottom edge.
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === "ios" ? 10 : 6,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  searchInput: {
    flex: 1,
    fontFamily: "Inter_500Medium",
    fontSize: 14,
    padding: 0,
  },
  card: {
    borderWidth: 1,
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    padding: 10,
    gap: 12,
  },
  cover: { width: 84, height: 84, borderRadius: 12, overflow: "hidden" },
  cardBody: { flex: 1, gap: 4, minWidth: 0 },
  cardTitle: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: -0.2,
  },
  cardMeta: { fontSize: 12, fontFamily: "Inter_400Regular" },
  distanceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
  },
  distance: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  cardRight: { alignItems: "flex-end", gap: 6, paddingLeft: 4 },
  rightStat: { flexDirection: "row", alignItems: "center", gap: 4 },
  rightStatValue: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  statusPill: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
});
