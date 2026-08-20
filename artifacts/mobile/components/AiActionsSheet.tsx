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

import { useAiCredits } from "@/hooks/useAiCredits";
import { useColors } from "@/hooks/useColors";
import {
  outOfCreditsMessage,
  outOfCreditsMessageFromBody,
  totalAiCredits,
} from "@/services/aiCredits";
import { isInsufficientAiCredits } from "@/services/api";

const SNAP_AI = ["42%"];

/**
 * AI actions sheet, opened from the floating cluster's AI button.
 * Lists the two billable AI flows and their shared GET /api/credits total.
 * The old per-feature /api/ai/usage meter stays available elsewhere but is
 * intentionally not shown here: it is not the actual credit gate.
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
  const { credits, refresh } = useAiCredits();
  const [checkingCredits, setCheckingCredits] = useState(false);
  const [creditMessage, setCreditMessage] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      presentedRef.current = true;
      sheetRef.current?.present();
      let cancelled = false;
      setCreditMessage(null);
      setCheckingCredits(true);
      refresh()
        .then((latest) => {
          if (!cancelled && totalAiCredits(latest) <= 0) {
            setCreditMessage(outOfCreditsMessage(latest.next_reset_at));
          }
        })
        .catch(() => {
          if (!cancelled) {
            setCreditMessage(
              "Couldn't check available credits. Try again before starting an AI action.",
            );
          }
        })
        .finally(() => {
          if (!cancelled) setCheckingCredits(false);
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

  const startBillableAction = async (action: () => void) => {
    if (checkingCredits) return;
    setCreditMessage(null);
    setCheckingCredits(true);
    try {
      // Always revalidate just before entering the action. For a
      // walkthrough this happens before capture requests microphone access,
      // preventing a user from recording a site visit with no credits.
      const latest = await refresh();
      if (totalAiCredits(latest) <= 0) {
        setCreditMessage(outOfCreditsMessage(latest.next_reset_at));
        return;
      }
      action();
    } catch (e) {
      setCreditMessage(
        isInsufficientAiCredits(e)
          ? outOfCreditsMessageFromBody(e.body)
          : "Couldn't check available credits. Try again before starting an AI action.",
      );
    } finally {
      setCheckingCredits(false);
    }
  };

  const rows: {
    key: string;
    icon: React.ComponentProps<typeof Feather>["name"];
    title: string;
    desc: string;
    onPress: () => void;
  }[] = [
    {
      key: "walkthrough",
      icon: "mic",
      title: "Walkthrough",
      desc: "Talk and capture — get an AI-written report",
      onPress: () => void startBillableAction(onWalkthrough),
    },
    {
      key: "report",
      icon: "file-text",
      title: "Generate Report",
      desc: "Pick photos, add a note, get a report",
      onPress: () => void startBillableAction(onGenerateReport),
    },
  ];
  const noCredits = credits ? totalAiCredits(credits) <= 0 : false;

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
        <Text style={[styles.creditTotal, { color: colors.mutedForeground }]}>
          {credits
            ? `${totalAiCredits(credits)} AI credit${totalAiCredits(credits) === 1 ? "" : "s"} remaining`
            : "Checking available credits…"}
        </Text>
        {creditMessage ? (
          <Text style={[styles.creditMessage, { color: colors.destructive }]}>
            {creditMessage}
          </Text>
        ) : null}
        {rows.map((r) => (
          <Pressable
            key={r.key}
            onPress={r.onPress}
            disabled={checkingCredits || noCredits}
            accessibilityRole="button"
            accessibilityLabel={r.title}
            style={({ pressed }) => [
              styles.row,
              {
                backgroundColor: colors.muted,
                opacity:
                  checkingCredits || noCredits ? 0.5 : pressed ? 0.85 : 1,
              },
            ]}
          >
            <View style={[styles.rowIcon, { backgroundColor: colors.primary }]}>
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
            <Feather
              name="chevron-right"
              size={18}
              color={colors.mutedForeground}
            />
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
  creditTotal: { fontFamily: "Inter_500Medium", fontSize: 13, marginTop: -8 },
  creditMessage: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    lineHeight: 18,
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
});
