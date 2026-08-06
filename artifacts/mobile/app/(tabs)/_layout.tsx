import { Feather } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { SymbolView } from "expo-symbols";
import React from "react";
import { Platform, View } from "react-native";

import { FloatingTabBar } from "@/components/FloatingTabBar";
import { useColors } from "@/hooks/useColors";

export default function TabLayout() {
  const isIOS = Platform.OS === "ios";
  const colors = useColors();

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
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
        {/* Hidden (non-tab) routes in this group. Declared explicitly
            with href: null so they never appear in the tab bar AND so
            the four real tabs keep deterministic route indexes 0–3 —
            FloatingTabBar renders state.routes by fixed index. */}
        <Tabs.Screen name="settings" options={{ href: null }} />
        <Tabs.Screen name="edit-profile" options={{ href: null }} />
      </Tabs>
    </View>
  );
}
