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
import { useGeofenceSync } from "@/hooks/useGeofenceSync";

export default function TabLayout() {
  // Provider must wrap the inner layout so `useLocationBannerActive`
  // resolves to a real value (not the default `false`) inside the
  // SafeAreaInsetsContext override below.
  return (
    <LocationBannerProvider>
      <TabLayoutInner />
    </LocationBannerProvider>
  );
}

function TabLayoutInner() {
  const isIOS = Platform.OS === "ios";
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const bannerActive = useLocationBannerActive();

  // Drives iOS geofence registration lifecycle. The hook handles its
  // own auth + permission gating internally and is a no-op on Android
  // and on Dev Builds without the expo-task-manager native binding.
  // Mounted here (inside the LocationBannerProvider scope, not at the
  // root layout) so it lives exactly as long as the authenticated tabs
  // session — auto-tears-down on sign-out via AuthContext re-render.
  useGeofenceSync();

  // Tab screens already pad their scroll content with `insets.top + 12`
  // internally. When the banner consumes the safe-area-top above them,
  // we need to zero out their `insets.top` reading to avoid stacking
  // another status-bar of dead space below the banner. Bottom inset is
  // preserved so the FloatingTabBar still clears the home indicator.
  const adjustedInsets = useMemo(
    () => ({ ...insets, top: bannerActive ? 0 : insets.top }),
    [insets, bannerActive],
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {bannerActive ? (
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
