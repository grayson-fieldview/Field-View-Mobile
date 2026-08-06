import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { Row } from "@/components/Row";
import { useColors } from "@/hooks/useColors";
import { api, type BillingSummary } from "@/services/api";

/**
 * Billing — read-only account billing summary. Hidden (href: null)
 * route in the (tabs) group, pushed from Settings → About → Billing
 * (admin-only row; the endpoint 403s non-admins anyway).
 *
 * DISPLAY-ONLY by design: no manage/upgrade/change-plan links — Apple
 * flags external purchase paths. No plan name or renewal date (don't
 * exist server-side). Never branch on billingProvider (unreliable in
 * current prod config).
 *
 * States: spinner while fetching; full-screen error + Retry on
 * failure (never a half-empty screen); rows only once data arrived.
 */
export default function BillingScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getBillingSummary();
      setSummary(data);
    } catch (e) {
      setSummary(null);
      setError(
        e instanceof Error
          ? e.message
          : "Couldn't load billing info. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // "trialing" → "Trial", "past_due" → "Past due", "canceled" →
  // "Canceled", "active" → "Active". Unknown values fall through to a
  // generic title-casing so a future status still renders something.
  const statusLabel = (raw: string): string => {
    switch (raw) {
      case "trialing":
        return "Trial";
      case "active":
        return "Active";
      case "past_due":
        return "Past due";
      case "canceled":
        return "Canceled";
      default: {
        const s = raw.replace(/_/g, " ");
        return s.charAt(0).toUpperCase() + s.slice(1);
      }
    }
  };

  const formatDate = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  return (
    <ScrollView
      style={[styles.wrap, { backgroundColor: colors.background }]}
      contentContainerStyle={{
        paddingTop: insets.top + (Platform.OS === "web" ? 67 : 12),
        paddingBottom: insets.bottom + 100,
        // Lets the loading/error containers (flex: 1) center themselves
        // in the space below the header instead of hugging the top.
        flexGrow: 1,
      }}
    >
      {/* Header: back chevron + title (tabs have headerShown: false). */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backBtn}
        >
          <Feather name="chevron-left" size={28} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>
          Billing
        </Text>
        <View style={styles.backBtn} />
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Text style={[styles.errorText, { color: colors.mutedForeground }]}>
            {error}
          </Text>
          <View style={{ marginTop: 16, alignSelf: "stretch" }}>
            <Button title="Retry" variant="secondary" onPress={load} />
          </View>
        </View>
      ) : summary ? (
        <View style={styles.section}>
          <Text style={[styles.accountName, { color: colors.foreground }]}>
            {summary.accountName}
          </Text>
          <Row
            icon="activity"
            label="Status"
            value={statusLabel(summary.status)}
          />
          {summary.trialEndsAt !== null ? (
            <Row
              icon="calendar"
              label="Trial ends"
              value={formatDate(summary.trialEndsAt)}
            />
          ) : null}
          <Row
            icon="users"
            label="Seats"
            value={`${summary.seats.used} of ${summary.seats.total}`}
          />
          <Row
            icon="folder"
            label="Active projects"
            value={String(summary.activeProjects)}
          />
          <Row
            icon="image"
            label="Photos"
            value={String(summary.photoCount)}
          />
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
  },
  backBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
  },
  centered: {
    flex: 1,
    marginHorizontal: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  errorText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
  },
  section: { marginTop: 16, marginHorizontal: 20 },
  accountName: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.3,
    marginBottom: 8,
  },
});
