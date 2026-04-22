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

// FAB geometry. Keep in sync with QuickCaptureFAB FAB_SIZE.
const FAB_SIZE = 64;
const FAB_RADIUS = FAB_SIZE / 2;

// Notch is a smaller circular arc (rx=ry) so the dip cradles the round FAB.
// Gap of ~6px between FAB edge and notch edge for a clean "docked" look.
const NOTCH_RADIUS = FAB_RADIUS + 6; // 38
const NOTCH_HALF_CHORD = NOTCH_RADIUS - 2; // 36 → chord width ~72px
// Depth of the notch, computed from circle geometry:
// d = r - sqrt(r² - chord²/4) ≈ 26 with r=38, chord=72.
const NOTCH_DEPTH = Math.round(
  NOTCH_RADIUS - Math.sqrt(NOTCH_RADIUS ** 2 - NOTCH_HALF_CHORD ** 2),
);

// FAB sits with ~30% of its height inside the notch and ~70% above the pill.
const FAB_OVERLAP = 20; // px of FAB dipping below pill top
const SHADOW_TOP_PAD = 6; // breathing room above the FAB for shadow blur
const FAB_RAISE = SHADOW_TOP_PAD + FAB_SIZE - FAB_OVERLAP; // pill top offset
const FAB_TOP = FAB_RAISE - FAB_SIZE + FAB_OVERLAP; // = SHADOW_TOP_PAD

const SIDE_MARGIN = 16;
const BOTTOM_MARGIN_EXTRA = 16;

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

  // Pill outline with a concave notch carved into the top-center.
  const path = [
    `M ${PILL_RADIUS} 0`,
    `L ${cx - NOTCH_HALF_CHORD} 0`,
    // Circular arc (rx = ry = NOTCH_RADIUS), sweep=1 dips downward.
    `A ${NOTCH_RADIUS} ${NOTCH_RADIUS} 0 0 1 ${cx + NOTCH_HALF_CHORD} 0`,
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
        <Text numberOfLines={1} style={[styles.label, { color }]}>
          {label}
        </Text>
      </Pressable>
    );
  };

  // Dark gray fill for the pill — distinct from the page background so the
  // pill reads as a solid container.
  const pillFill = "#1C1C1E";
  const borderColor = "rgba(255,255,255,0.06)";

  // Width reserved in the tab row for the FAB / notch area. Matches the
  // chord width plus a little padding so the notch sits in clean negative
  // space between Map and Tasks.
  const CENTER_RESERVED = NOTCH_HALF_CHORD * 2 + 16; // 88

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.outer,
        {
          left: SIDE_MARGIN,
          right: SIDE_MARGIN,
          bottom: insets.bottom + BOTTOM_MARGIN_EXTRA,
          height: PILL_HEIGHT + FAB_RAISE,
        },
      ]}
    >
      {/* Pill background sits at the bottom of the outer wrap. */}
      <View
        style={[
          styles.pillWrap,
          { width: pillW, height: PILL_HEIGHT },
          Platform.OS === "android"
            ? { elevation: 12 }
            : {
                shadowColor: "#000",
                shadowOpacity: 0.45,
                shadowRadius: 16,
                shadowOffset: { width: 0, height: 8 },
              },
        ]}
      >
        <Svg width={pillW} height={PILL_HEIGHT}>
          <Path
            d={path}
            fill={pillFill}
            stroke={borderColor}
            strokeWidth={1}
          />
        </Svg>
      </View>

      {/* Tab row sits over the flat (non-notch) portion of the pill. */}
      <View
        pointerEvents="box-none"
        style={[
          styles.contentRow,
          {
            top: FAB_RAISE + NOTCH_DEPTH * 0.5,
            height: PILL_HEIGHT - NOTCH_DEPTH * 0.5,
          },
        ]}
      >
        <View style={styles.half}>
          {renderTab(0)}
          {renderTab(1)}
        </View>
        <View style={{ width: CENTER_RESERVED }} />
        <View style={styles.half}>
          {renderTab(2)}
          {renderTab(3)}
        </View>
      </View>

      {/* FAB docked in the notch — ~70% above the pill, ~30% inside. */}
      <QuickCaptureFAB
        buttonStyle={{
          position: "absolute",
          left: "50%",
          marginLeft: -FAB_RADIUS,
          top: FAB_TOP,
        }}
      />
    </View>
  );
}

// Total vertical footprint the floating bar consumes (pill + raise + bottom
// gap). Screens can use TAB_BAR_OVERLAY to pad their scroll content.
export const TAB_BAR_OVERLAY = PILL_HEIGHT + FAB_RAISE + BOTTOM_MARGIN_EXTRA;

const styles = StyleSheet.create({
  outer: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "flex-end",
  },
  pillWrap: {
    position: "absolute",
    bottom: 0,
    alignSelf: "center",
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
