import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { Feather } from "@expo/vector-icons";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { api, type AiUsageEntry } from "@/services/api";

const SNAP_AI = ["38%"];

/**
 * AI actions sheet, opened from the floating cluster's AI button.
 * Lists the two AI flows with a remaining-usage badge per row from
 * GET /api/ai/usage (fetched fresh per open; badge is best-effort —
 * a failed fetch never blocks the actions).
 *
 * presentedRef guard: never dismiss() a non-presented modal (INITIAL →
 * DISMISSING wedge).
 */
export function AiActionsSheet({
  visible,
  onClose,
  onWalkthrough,
  onGenerateReport,
}: {
  visible: boolean;
  onClose: () => void;
  onWalkthrough: () => void;
  onGenerateReport: () => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);
  const presentedRef = useRef(false);
  const [usage, setUsage] = useState<AiUsageEntry[] | null>(null);

  useEffect(() => {
    if (visible) {
      presentedRef.current = true;
      sheetRef.current?.present();
      let cancelled = false;
      setUsage(null);
      api
        .getAiUsage()
        .then((rows) => {
          if (!cancelled) setUsage(rows);
        })
        .catch(() => {
          /* badge stays hidden — non-fatal */
        });
      return () => {
        cancelled = true;
      };
    } else if (presentedRef.current) {
      presentedRef.current = false;
      sheetRef.current?.dismiss();
    }
  }, [visible]);

  const Backdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="close"
      />
    ),
    [],
  );

  // Feature-key matching is deliberately fuzzy: the endpoint is new and
  // exact keys are unconfirmed (see report). Unlimited/absent → no badge.
  const remainingFor = (needle: string): number | null => {
    if (!usage) return null;
    const row = usage.find((u) =>
      u.feature.toLowerCase().includes(needle),
    );
    if (!row || !(row.limit > 0)) return null;
    return Math.max(0, row.remaining);
  };

  const rows: {
    key: string;
    icon: React.ComponentProps<typeof Feather>["name"];
    title: string;
    desc: string;
    remaining: number | null;
    onPress: () => void;
  }[] = [
    {
      key: "walkthrough",
      icon: "mic",
      title: "Walkthrough",
      desc: "Talk and capture — get an AI-written report",
      remaining: remainingFor("walk"),
      onPress: onWalkthrough,
    },
    {
      key: "report",
      icon: "file-text",
      title: "Generate Report",
      desc: "Pick photos, add a note, get a report",
      remaining: remainingFor("report"),
      onPress: onGenerateReport,
    },
  ];

  return (
    <BottomSheetModal
      ref={sheetRef}
      snapPoints={SNAP_AI}
      enableDynamicSizing={false}
      enablePanDownToClose
      onDismiss={() => {
        presentedRef.current = false;
        onClose();
      }}
      backdropComponent={Backdrop}
      backgroundStyle={{ backgroundColor: colors.card }}
      handleIndicatorStyle={{ backgroundColor: colors.mutedForeground }}
      android_keyboardInputMode="adjustResize"
    >
      <BottomSheetView
        style={[styles.body, { paddingBottom: insets.bottom + 12 }]}
      >
        <Text style={[styles.title, { color: colors.foreground }]}>
          AI actions
        </Text>
        {rows.map((r) => (
          <Pressable
            key={r.key}
            onPress={r.onPress}
            accessibilityRole="button"
            accessibilityLabel={r.title}
            style={({ pressed }) => [
              styles.row,
              {
                backgroundColor: colors.muted,
                opacity: pressed ? 0.85 : 1,
              },
            ]}
          >
            <View
              style={[styles.rowIcon, { backgroundColor: colors.primary }]}
            >
              <Feather
                name={r.icon}
                size={18}
                color={colors.primaryForeground}
              />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[styles.rowTitle, { color: colors.foreground }]}>
                {r.title}
              </Text>
              <Text
                style={[styles.rowDesc, { color: colors.mutedForeground }]}
                numberOfLines={2}
              >
                {r.desc}
              </Text>
            </View>
            {r.remaining !== null ? (
              <View
                style={[
                  styles.usageBadge,
                  { backgroundColor: colors.card, borderColor: colors.border },
                ]}
              >
                <Text
                  style={[
                    styles.usageBadgeText,
                    { color: colors.mutedForeground },
                  ]}
                >
                  {r.remaining} left
                </Text>
              </View>
            ) : null}
          </Pressable>
        ))}
      </BottomSheetView>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, gap: 12 },
  title: {
    fontFamily: "Inter_700Bold",
    fontSize: 17,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 14,
    padding: 12,
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTitle: { fontFamily: "Inter_600SemiBold", fontSize: 15 },
  rowDesc: { fontFamily: "Inter_400Regular", fontSize: 12.5 },
  usageBadge: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  usageBadgeText: { fontFamily: "Inter_600SemiBold", fontSize: 11 },
});
