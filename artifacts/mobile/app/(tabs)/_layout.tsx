import { Feather } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { SymbolView } from "expo-symbols";
import React, { useMemo } from "react";
import { Platform, View } from "react-native";
import {
  SafeAreaInsetsContext,
  useSafeAreaInsets,
} from "react-native-safe-area-context";

import { FloatingTabBar } from "@/components/FloatingTabBar";
import {
  LocationBannerProvider,
  LocationPermissionBanner,
  useLocationBannerActive,
} from "@/components/LocationPermissionBanner";
import { useColors } from "@/hooks/useColors";
import { GeofenceSyncProvider } from "@/hooks/useGeofenceSync";

export default function TabLayout() {
  // Providers must wrap the inner layout so:
  //   - `useLocationBannerActive` resolves to a real value (not the
  //     default `false`) inside the SafeAreaInsetsContext override below.
  //   - `GeofenceSyncProvider` mounts the geofence lifecycle hook
  //     exactly once for the authenticated tabs session, and exposes
  //     its state to consumers (e.g. ProfileScreen's debug surface)
  //     without any of them re-mounting the AppState listener or
  //     debounce clock. Provider auto-tears-down on sign-out via the
  //     AuthContext re-render that unmounts the tabs tree.
  return (
    <LocationBannerProvider>
      <GeofenceSyncProvider>
        <TabLayoutInner />
      </GeofenceSyncProvider>
    </LocationBannerProvider>
  );
}

function TabLayoutInner() {
  const isIOS = Platform.OS === "ios";
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const locBannerActive = useLocationBannerActive();

  // The S31a confirmation banner (and its mount/inset gate) was
  // removed in S31b. Silent-auto clock-in fires a notification
  // instead of a foreground banner, so the only banner left to
  // gate the safe-area-top is LocationPermissionBanner.
  //
  // Tab screens already pad their scroll content with `insets.top + 12`
  // internally. When the location banner consumes the safe-area-top
  // above them, we zero out their `insets.top` reading to avoid
  // stacking another status-bar of dead space below the banner.
  // Bottom inset is preserved so the FloatingTabBar still clears the
  // home indicator.
  const adjustedInsets = useMemo(
    () => ({ ...insets, top: locBannerActive ? 0 : insets.top }),
    [insets, locBannerActive],
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {locBannerActive ? (
        <View
          style={{
            paddingTop: insets.top,
            backgroundColor: colors.background,
          }}
        >
          <LocationPermissionBanner />
        </View>
      ) : null}
      <SafeAreaInsetsContext.Provider value={adjustedInsets}>
        <View style={{ flex: 1 }}>
          <Tabs
            tabBar={(props) => <FloatingTabBar {...props} />}
            screenOptions={{
              headerShown: false,
            }}
          >
            <Tabs.Screen
              name="index"
              options={{
                title: "Projects",
                tabBarIcon: ({ color }) =>
                  isIOS ? (
                    <SymbolView name="folder" tintColor={color} size={22} />
                  ) : (
                    <Feather name="folder" size={22} color={color} />
                  ),
              }}
            />
            <Tabs.Screen
              name="map"
              options={{
                title: "Map",
                tabBarIcon: ({ color }) =>
                  isIOS ? (
                    <SymbolView name="map" tintColor={color} size={22} />
                  ) : (
                    <Feather name="map" size={22} color={color} />
                  ),
              }}
            />
            <Tabs.Screen
              name="tasks"
              options={{
                title: "Tasks",
                tabBarIcon: ({ color }) =>
                  isIOS ? (
                    <SymbolView name="checklist" tintColor={color} size={22} />
                  ) : (
                    <Feather name="check-square" size={22} color={color} />
                  ),
              }}
            />
            <Tabs.Screen
              name="profile"
              options={{
                title: "Profile",
                tabBarIcon: ({ color }) =>
                  isIOS ? (
                    <SymbolView name="person.circle" tintColor={color} size={22} />
                  ) : (
                    <Feather name="user" size={22} color={color} />
                  ),
              }}
            />
          </Tabs>
        </View>
      </SafeAreaInsetsContext.Provider>
    </View>
  );
}
