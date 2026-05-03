import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useColors } from "@/hooks/useColors";

/**
 * Receipt banner shown at the top of the project detail screen
 * after a silent-auto clock-in notification tap.
 *
 * Pure presentational — all state (visibility, error, in-flight
 * undo) is owned by the parent. The parent is also responsible for
 * the 30s auto-dismiss timer, the scroll-dismissal hook, and any
 * "active entry not found" gating (in which case it renders null
 * instead of this component).
 *
 * Visual treatment is intentionally subordinate to the S31a action
 * banner that this UX replaces:
 *   - Card background (not orange) — informational, not a CTA
 *   - 1px border in the standard divider color
 *   - Smaller padding + tighter type than the location banner
 * The Undo button is the only orange affordance, scoped tight so it
 * reads as "discoverable correction" rather than "primary action".
 */
export function ClockInReceiptBanner({
  visible,
  time,
  projectName,
  error,
  undoing,
  onUndo,
  onDismiss,
}: {
  visible: boolean;
  /** Clock-in time, formatted "h:mm AM/PM" in the user's locale. */
  time: Date;
  /** Project name — included in accessibility label, not the visible body. */
  projectName: string;
  /** Sticky inline error from a failed undo attempt. Banner doesn't auto-dismiss while set. */
  error: string | null;
  undoing: boolean;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const colors = useColors();

  if (!visible) return null;

  // Same format as the notification body — locale-aware, no leading
  // zero on hour, no seconds. Matches what the user just tapped.
  const timeLabel = time.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel={
        error
          ? `Couldn't undo clock-in at ${projectName}: ${error}`
          : `Clocked in at ${projectName} at ${timeLabel}. Undo available.`
      }
      style={[
        styles.wrap,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          // Subtle elevation — not the heavy shadow used on modals.
          shadowColor: "#000",
        },
      ]}
    >
      <View style={styles.row}>
        <View style={styles.iconWrap}>
          <Feather
            name={error ? "alert-circle" : "check-circle"}
            size={18}
            color={error ? colors.destructive : colors.mutedForeground}
          />
        </View>
        <View style={styles.body}>
          {error ? (
            <Text
              style={[styles.errorTxt, { color: colors.destructive }]}
              numberOfLines={2}
            >
              Couldn&apos;t undo — {error}
            </Text>
          ) : (
            <Text
              style={[styles.bodyTxt, { color: colors.foreground }]}
              numberOfLines={1}
            >
              Just clocked in at {timeLabel} — tap Undo if this was a mistake
            </Text>
          )}
        </View>
        {/* Undo button. Hidden once an error is shown — at that point
            the user's only action is dismissal (via X). They can
            still clock out manually from the ClockBar at the bottom
            of the screen. Re-enabling Undo after error would lead to
            confusing retry semantics for window-expired / ownership
            failures, which are non-recoverable. */}
        {error ? null : (
          <Pressable
            onPress={onUndo}
            disabled={undoing}
            accessibilityRole="button"
            accessibilityLabel="Undo clock-in"
            hitSlop={8}
            style={({ pressed }) => [
              styles.undoBtn,
              {
                opacity: undoing ? 0.6 : pressed ? 0.7 : 1,
              },
            ]}
          >
            {undoing ? (
              <ActivityIndicator size="small" color="#ef9003" />
            ) : (
              <Text style={styles.undoTxt}>Undo</Text>
            )}
          </Pressable>
        )}
        <Pressable
          onPress={onDismiss}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Dismiss receipt"
          style={({ pressed }) => [
            styles.closeBtn,
            { opacity: pressed ? 0.5 : 1 },
          ]}
        >
          <Feather name="x" size={16} color={colors.mutedForeground} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: 12,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  iconWrap: {
    width: 22,
    alignItems: "center",
  },
  body: {
    flex: 1,
  },
  bodyTxt: {
    fontSize: 13,
    lineHeight: 18,
  },
  errorTxt: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "500",
  },
  undoBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 50,
    alignItems: "center",
    justifyContent: "center",
  },
  undoTxt: {
    color: "#ef9003",
    fontSize: 14,
    fontWeight: "600",
  },
  closeBtn: {
    padding: 4,
  },
});
