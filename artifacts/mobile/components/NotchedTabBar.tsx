import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import React from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";

import { QuickCaptureFAB } from "@/components/QuickCaptureFAB";
import { useColors } from "@/hooks/useColors";

const PILL_HEIGHT = 64;
const PILL_RADIUS = 32;
const NOTCH_WIDTH = 88;
const NOTCH_DEPTH = 26;
const SIDE_MARGIN = 16;
const BOTTOM_MARGIN_EXTRA = 12;
const FAB_SIZE = 64;
// How far the FAB sits above the pill's top edge. Roughly 70% of the
// circle floats above the bar; the remaining ~30% dips into the notch.
const FAB_RAISE = 44;

export function NotchedTabBar({
  state,
  descriptors,
  navigation,
}: BottomTabBarProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width: screenW } = useWindowDimensions();

  const pillW = Math.max(280, screenW - SIDE_MARGIN * 2);
  const cx = pillW / 2;

  const path = [
    `M ${PILL_RADIUS} 0`,
    `L ${cx - NOTCH_WIDTH / 2} 0`,
    `A ${NOTCH_WIDTH / 2} ${NOTCH_DEPTH} 0 0 1 ${cx + NOTCH_WIDTH / 2} 0`,
    `L ${pillW - PILL_RADIUS} 0`,
    `A ${PILL_RADIUS} ${PILL_RADIUS} 0 0 1 ${pillW} ${PILL_RADIUS}`,
    `L ${pillW} ${PILL_HEIGHT - PILL_RADIUS}`,
    `A ${PILL_RADIUS} ${PILL_RADIUS} 0 0 1 ${pillW - PILL_RADIUS} ${PILL_HEIGHT}`,
    `L ${PILL_RADIUS} ${PILL_HEIGHT}`,
    `A ${PILL_RADIUS} ${PILL_RADIUS} 0 0 1 0 ${PILL_HEIGHT - PILL_RADIUS}`,
    `L 0 ${PILL_RADIUS}`,
    `A ${PILL_RADIUS} ${PILL_RADIUS} 0 0 1 ${PILL_RADIUS} 0`,
    "Z",
  ].join(" ");

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
        <Text
          numberOfLines={1}
          style={[styles.label, { color }]}
        >
          {label}
        </Text>
      </Pressable>
    );
  };

  const bottomOffset = insets.bottom + BOTTOM_MARGIN_EXTRA;
  const pillFill = colors.card;
  // Slight border helps the pill read against very dark backgrounds.
  const borderColor = colors.border;

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.outer,
        {
          left: SIDE_MARGIN,
          right: SIDE_MARGIN,
          bottom: bottomOffset,
          height: PILL_HEIGHT + FAB_RAISE,
        },
      ]}
    >
      {/* Pill background sits at the bottom of the outer wrap. */}
      <View
        style={[
          styles.pillWrap,
          Platform.OS === "android"
            ? { elevation: 12 }
            : {
                shadowColor: "#000",
                shadowOpacity: 0.3,
                shadowRadius: 12,
                shadowOffset: { width: 0, height: 6 },
              },
        ]}
      >
        <Svg width={pillW} height={PILL_HEIGHT}>
          <Path d={path} fill={pillFill} stroke={borderColor} strokeWidth={1} />
        </Svg>
      </View>

      {/* Tab buttons row, positioned over the flat portion of the pill. */}
      <View
        pointerEvents="box-none"
        style={[
          styles.contentRow,
          {
            top: FAB_RAISE,
            height: PILL_HEIGHT,
            // Push icons + labels into the flat portion of the bar so the
            // notch dip doesn't pull them downward visually.
            paddingTop: NOTCH_DEPTH * 0.55,
          },
        ]}
      >
        <View style={styles.half}>
          {renderTab(0)}
          {renderTab(1)}
        </View>
        <View style={{ width: NOTCH_WIDTH }} />
        <View style={styles.half}>
          {renderTab(2)}
          {renderTab(3)}
        </View>
      </View>

      {/* FAB docked in the notch. Top half floats above pill, bottom dips in. */}
      <QuickCaptureFAB
        buttonStyle={{
          position: "absolute",
          left: "50%",
          marginLeft: -FAB_SIZE / 2,
          top: FAB_RAISE - FAB_SIZE / 2,
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "flex-end",
  },
  pillWrap: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  contentRow: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
  },
  half: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "center",
  },
  tabBtn: {
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    paddingVertical: 4,
    minWidth: 56,
  },
  label: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    marginTop: 2,
  },
});
