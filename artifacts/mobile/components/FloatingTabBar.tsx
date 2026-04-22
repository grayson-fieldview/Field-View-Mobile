import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { BlurView } from "expo-blur";
import React from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { QuickCaptureFAB } from "@/components/QuickCaptureFAB";
import { useColors } from "@/hooks/useColors";

const PILL_HEIGHT = 64;
const PILL_RADIUS = 32;
const SIDE_MARGIN = 16;
const BOTTOM_MARGIN = 0;

const FAB_SIZE = 64;
// 80% of FAB sits inside the pill, 20% hangs above it.
const FAB_OVERLAP = Math.round(FAB_SIZE * 0.8);

// Reserved horizontal space in the tab row for the FAB. This pushes Map to
// the left and Tasks to the right so the FAB doesn't cover them.
const CENTER_GAP = FAB_SIZE + 24; // 88px

export function FloatingTabBar({
  state,
  descriptors,
  navigation,
}: BottomTabBarProps) {
  const colors = useColors();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const insets = useSafeAreaInsets();

  const renderTab = (routeIndex: number) => {
    const route = state.routes[routeIndex];
    if (!route) return null;
    const { options } = descriptors[route.key];
    const isFocused = state.index === routeIndex;
    const color = isFocused ? colors.primary : colors.mutedForeground;
    const label =
      typeof options.tabBarLabel === "string"
        ? options.tabBarLabel
        : (options.title ?? route.name);

    const onPress = () => {
      const event = navigation.emit({
        type: "tabPress",
        target: route.key,
        canPreventDefault: true,
      });
      if (!isFocused && !event.defaultPrevented) {
        navigation.navigate(route.name as never);
      }
    };

    const icon = options.tabBarIcon
      ? options.tabBarIcon({ focused: isFocused, color, size: 22 })
      : null;

    return (
      <Pressable
        key={route.key}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={isFocused ? { selected: true } : {}}
        style={styles.tabBtn}
      >
        {icon}
        <Text numberOfLines={1} style={[styles.label, { color }]}>
          {label}
        </Text>
      </Pressable>
    );
  };

  // Pill extends through the home-indicator safe area so its bottom edge
  // is flush with the bottom of the screen (no visible gap below the bar).
  // Tab content stays in the upper visible portion via paddingBottom.
  const pillTotalHeight = PILL_HEIGHT + insets.bottom;

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.outer,
        {
          left: SIDE_MARGIN,
          right: SIDE_MARGIN,
          bottom: BOTTOM_MARGIN,
          height: pillTotalHeight,
        },
      ]}
    >
      <View
        style={[
          styles.pill,
          { height: pillTotalHeight },
          Platform.OS === "android"
            ? { elevation: 12, backgroundColor: colors.card }
            : {
                shadowColor: "#000",
                shadowOpacity: 0.35,
                shadowRadius: 16,
                shadowOffset: { width: 0, height: 8 },
              },
        ]}
      >
        {Platform.OS === "ios" ? (
          <BlurView
            intensity={90}
            tint={isDark ? "dark" : "light"}
            style={StyleSheet.absoluteFill}
          />
        ) : Platform.OS === "web" ? (
          <View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: isDark ? "#1C1C1E" : "rgba(255,255,255,0.92)" },
            ]}
          />
        ) : null}

        <View style={[styles.row, { paddingBottom: insets.bottom }]}>
          {renderTab(0)}
          {renderTab(1)}
          <View style={{ width: CENTER_GAP }} />
          {renderTab(2)}
          {renderTab(3)}
        </View>
      </View>

      <QuickCaptureFAB
        buttonStyle={{
          position: "absolute",
          left: "50%",
          marginLeft: -FAB_SIZE / 2,
          // 80% inside the pill's visible portion (overlap = 51),
          // 20% above its top edge. Anchored to the visible top so the
          // safe-area extension doesn't push the FAB down.
          bottom: insets.bottom + PILL_HEIGHT - FAB_OVERLAP,
        }}
      />
    </View>
  );
}

export const FLOATING_TAB_BAR_OVERLAY = PILL_HEIGHT + BOTTOM_MARGIN + 16;

const styles = StyleSheet.create({
  outer: {
    position: "absolute",
  },
  pill: {
    flex: 1,
    borderRadius: PILL_RADIUS,
    overflow: "hidden",
  },
  row: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 4,
  },
  tabBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    height: PILL_HEIGHT,
  },
  label: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    marginTop: 2,
  },
});
