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
import { reportBadge } from "@/lib/reportBadge";
import type { BackendReport } from "@/services/api";

interface Props {
  report: BackendReport;
  onPress: () => void;
}

/**
 * Compact card row used inside the project Reports tab.
 *
 * Status pill is read-only on mobile (workflow transitions are
 * web-only for R1). Tapping anywhere on the row navigates to detail.
 */
export function ReportListItem({ report, onPress }: Props) {
  const colors = useColors();
  // Defensive reads: an AI-generated report row may omit or carry an
  // unexpected status/title/date — render a neutral fallback, never
  // throw (this row crashed the project screen post-walkthrough).
  const status = typeof report.status === "string" ? report.status : "";
  const badge = reportBadge(report);
  const statusColor =
    badge.tone === "success"
      ? colors.success
      : badge.tone === "destructive"
        ? colors.destructive
        : colors.mutedForeground;
  const title =
    typeof report.title === "string" && report.title.length > 0
      ? report.title
      : "Untitled report";
  const updated =
    (typeof report.updatedAt === "string" ? report.updatedAt : null) ??
    (typeof report.createdAt === "string" ? report.createdAt : null);
  // Walkthrough pipeline rows: mid-generation and failed-generation
  // rows are NOT tappable — the detail screen has no sections to show
  // for either. Any unrecognized status renders as a normal report.
  const generating = status === "generating";
  const failed = status === "failed";
  const disabled = generating || failed;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          opacity: pressed && !disabled ? 0.85 : 1,
        },
      ]}
    >
      <View style={{ flex: 1, gap: 6 }}>
        <Text
          style={[
            styles.title,
            { color: failed ? colors.mutedForeground : colors.foreground },
          ]}
          numberOfLines={1}
        >
          {title}
        </Text>
        {generating ? (
          <View style={styles.metaRow}>
            <ActivityIndicator size="small" color={colors.mutedForeground} />
            <Text style={[styles.metaText, { color: colors.mutedForeground }]}>
              Generating report…
            </Text>
          </View>
        ) : failed ? (
          <Text style={[styles.metaText, { color: colors.destructive }]}>
            Report failed to generate
          </Text>
        ) : (
          <View style={styles.metaRow}>
            <View
              style={[
                styles.statusPill,
                {
                  backgroundColor: colors.muted,
                  borderColor: colors.border,
                },
              ]}
            >
              <View
                style={[styles.statusDot, { backgroundColor: statusColor }]}
              />
              <Text style={[styles.statusLabel, { color: statusColor }]}>
                {badge.label}
              </Text>
            </View>
            {updated ? (
              <Text
                style={[styles.metaText, { color: colors.mutedForeground }]}
              >
                Updated {formatRelative(updated)}
              </Text>
            ) : null}
          </View>
        )}
      </View>
      {disabled ? null : (
        <Feather
          name="chevron-right"
          size={18}
          color={colors.mutedForeground}
        />
      )}
    </Pressable>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
  },
  title: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: -0.2,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    textTransform: "capitalize",
  },
  metaText: { fontSize: 12, fontFamily: "Inter_500Medium" },
});
