import { Feather } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useColors } from "@/hooks/useColors";
import { api, ApiError } from "@/services/api";
import {
  dismissClockInPrompt,
  getClockInPromptQueue,
  recordClockInForRegion,
  subscribeToClockInPrompts,
  type ClockInPromptEvent,
} from "@/services/geofencing";

/**
 * Foreground prompt for the S31a auto clock-in flow.
 *
 * Subscribes to the geofencing module's prompt queue. Renders the
 * FIFO head when the queue is non-empty. Yes calls the clock-in API
 * (source: "auto"), primes the per-region debounce on success, and
 * dismisses the head. Not now just dismisses the head.
 *
 * Sticky: no auto-dismiss timer. Per the S31a UX decision —
 * contractors carrying gear for 45 seconds shouldn't lose a prompt
 * to a timer. Cost of annoying-when-ignored < cost of "auto clock-in
 * silently didn't work."
 *
 * Visual language: primary-action palette (orange/amber primary,
 * white CTA text) — distinct from the muted/info palette used by
 * LocationPermissionBanner. This is a positive action, not a warning.
 */

/**
 * Whether the banner currently has anything to render. Exposed as a
 * hook so the tabs layout can mirror the gate when deciding whether
 * to override SafeAreaInsetsContext (same pattern as
 * `useLocationBannerActive`).
 */
export function useClockInPromptActive(): boolean {
  const [depth, setDepth] = useState<number>(
    () => getClockInPromptQueue().length,
  );
  useEffect(() => {
    const unsub = subscribeToClockInPrompts((q) => setDepth(q.length));
    return unsub;
  }, []);
  return depth > 0;
}

export function ClockInPromptBanner() {
  const colors = useColors();
  const [queue, setQueue] = useState<ClockInPromptEvent[]>(() =>
    getClockInPromptQueue(),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = subscribeToClockInPrompts((q) => {
      setQueue(q);
      // Reset transient submit/error state when the head changes —
      // a stale error on a new project would be confusing.
      setError(null);
      setSubmitting(false);
    });
    return unsub;
  }, []);

  const head = queue[0];
  if (!head) return null;

  const onYes = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.clockIn(head.projectId, undefined, "auto");
      // Stamp debounce BEFORE dismiss so the next emit sees the
      // timestamp regardless of React render ordering.
      recordClockInForRegion(head.projectId);
      dismissClockInPrompt(head.projectId);
      // Note: dismissClockInPrompt notifies subscribers, which will
      // call our setQueue listener, which resets `submitting`. The
      // explicit setSubmitting(false) in `finally` is still needed
      // for the error path.
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `Clock in failed (${err.status}). Tap Yes to retry.`
          : err instanceof Error
            ? `Clock in failed: ${err.message}`
            : "Clock in failed.";
      setError(msg);
      console.log("[clock-in-prompt] api.clockIn failed:", err);
      setSubmitting(false);
    }
  };

  const onNotNow = () => {
    if (submitting) return;
    dismissClockInPrompt(head.projectId);
  };

  const additional = queue.length - 1;

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: colors.background,
          borderBottomColor: colors.border,
        },
      ]}
    >
      <Feather
        name="map-pin"
        size={18}
        color={colors.primary}
        style={styles.leadingIcon}
      />
      <View style={styles.body}>
        <Text style={[styles.title, { color: colors.foreground }]}>
          Clock in at {head.projectName}?
        </Text>
        {additional > 0 ? (
          <Text style={[styles.subtle, { color: colors.mutedForeground }]}>
            +{additional} more after this
          </Text>
        ) : null}
        {error ? (
          <Text style={[styles.errorText, { color: "#dc2626" }]}>{error}</Text>
        ) : null}
        <View style={styles.actions}>
          <Pressable
            onPress={onYes}
            disabled={submitting}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Clock in at ${head.projectName}`}
            style={[
              styles.primaryBtn,
              {
                backgroundColor: colors.primary,
                opacity: submitting ? 0.6 : 1,
              },
            ]}
          >
            {submitting ? (
              <ActivityIndicator
                size="small"
                color={colors.primaryForeground}
              />
            ) : (
              <Text
                style={[
                  styles.primaryBtnText,
                  { color: colors.primaryForeground },
                ]}
              >
                Yes
              </Text>
            )}
          </Pressable>
          <Pressable
            onPress={onNotNow}
            disabled={submitting}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Dismiss prompt"
            style={styles.secondaryBtn}
          >
            <Text
              style={[
                styles.secondaryBtnText,
                { color: colors.mutedForeground },
              ]}
            >
              Not now
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  leadingIcon: {
    marginTop: 2,
  },
  body: {
    flex: 1,
    gap: 8,
  },
  title: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    lineHeight: 18,
  },
  subtle: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  errorText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  actions: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    marginTop: 2,
  },
  primaryBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    minWidth: 56,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  secondaryBtn: {
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  secondaryBtnText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
});
