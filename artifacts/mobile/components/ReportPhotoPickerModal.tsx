import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import React, { useEffect, useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { useData } from "@/contexts/DataContext";
import { useColors } from "@/hooks/useColors";
import type { BackendReportSectionPhoto } from "@/services/api";

interface Props {
  visible: boolean;
  onClose: () => void;
  projectId: string;
  /** Filter out media already attached to this section. */
  alreadyAttachedMediaIds: Set<number>;
  /** How many additional photos this report can still accept (50 - total). */
  remainingSlots: number;
  /**
   * Single batch attach. Receives the chosen mediaIds (capped client-side
   * by remainingSlots) and resolves with the new junction rows or throws.
   * Mirrors POST /api/sections/:id/photos { mediaIds: number[1..50] }.
   */
  onAttach: (mediaIds: number[]) => Promise<BackendReportSectionPhoto[]>;
  /** Toast hook from the parent. */
  onResult: (succeededCount: number, failed: boolean) => void;
}

const TILE_GAP = 8;
const TILES_PER_ROW = 3;

/**
 * Mirror of components/PhotoPickerModal scoped to the report's project
 * photos and using the BATCH attach endpoint (not N parallel calls).
 *
 * The 50-photo report cap is enforced client-side via remainingSlots:
 * once selected.size >= remainingSlots, additional tiles dim and become
 * unselectable. The server enforces the same cap as a backstop.
 */
export function ReportPhotoPickerModal({
  visible,
  onClose,
  projectId,
  alreadyAttachedMediaIds,
  remainingSlots,
  onAttach,
  onResult,
}: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { photos } = useData();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [attaching, setAttaching] = useState(false);

  useEffect(() => {
    if (visible) setSelected(new Set());
  }, [visible]);

  // Same media-id resolution as PhotoPickerModal:
  //  - server-originated photos carry `mediaId` from the mapper,
  //  - locally-captured photos pick up `mediaId` after the upload queue
  //    reconciles, and
  //  - legacy rows fall back to Number(p.id).
  // Photos with no resolvable mediaId are skipped (would 400 the batch).
  const candidates = useMemo(() => {
    const out: Array<{ photo: (typeof photos)[number]; mediaId: number }> = [];
    for (const p of photos) {
      if (p.projectId !== projectId) continue;
      if (!p.uploaded) continue;
      const mediaId =
        typeof p.mediaId === "number" && Number.isFinite(p.mediaId)
          ? p.mediaId
          : Number(p.id);
      if (!Number.isFinite(mediaId)) continue;
      if (alreadyAttachedMediaIds.has(mediaId)) continue;
      out.push({ photo: p, mediaId });
    }
    return out;
  }, [photos, projectId, alreadyAttachedMediaIds]);

  const toggle = (id: string) => {
    if (attaching) return;
    setSelected((curr) => {
      const next = new Set(curr);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < remainingSlots) {
        next.add(id);
      }
      return next;
    });
  };

  const attachSelected = async () => {
    if (selected.size === 0 || attaching) return;
    setAttaching(true);
    const mediaIdByLocalId = new Map(
      candidates.map((c) => [c.photo.id, c.mediaId]),
    );
    const mediaIds = Array.from(selected)
      .map((id) => mediaIdByLocalId.get(id))
      .filter((m): m is number => typeof m === "number")
      .slice(0, remainingSlots);
    let succeededCount = 0;
    let failed = false;
    try {
      const created = await onAttach(mediaIds);
      succeededCount = created.length;
    } catch {
      failed = true;
    }
    setAttaching(false);
    onResult(succeededCount, failed);
    onClose();
  };

  const atSelectionCap =
    selected.size >= remainingSlots && remainingSlots > 0;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <View
          style={[
            styles.header,
            { paddingTop: insets.top + 8, borderBottomColor: colors.border },
          ]}
        >
          <Pressable onPress={onClose} hitSlop={10} disabled={attaching}>
            <Text
              style={[
                styles.headerBtn,
                { color: attaching ? colors.mutedForeground : colors.primary },
              ]}
            >
              Cancel
            </Text>
          </Pressable>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>
            Choose photos
          </Text>
          <View style={{ width: 50 }} />
        </View>

        {remainingSlots <= 0 ? (
          <View style={{ flex: 1, justifyContent: "center" }}>
            <EmptyState
              icon="alert-circle"
              title="Photo cap reached"
              description="This report already has the maximum of 50 photos. Detach some before adding more."
            />
          </View>
        ) : candidates.length === 0 ? (
          <View style={{ flex: 1, justifyContent: "center" }}>
            <EmptyState
              icon="image"
              title="No photos to attach"
              description="Take photos for this project first, or all of its photos are already attached to this section."
            />
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={{
              padding: 16,
              paddingBottom: insets.bottom + 110,
            }}
          >
            <Text
              style={{
                color: colors.mutedForeground,
                fontSize: 12,
                fontFamily: "Inter_500Medium",
                marginBottom: 10,
              }}
            >
              Up to {remainingSlots} more photo{remainingSlots === 1 ? "" : "s"} can
              be attached to this report.
            </Text>
            <View style={styles.grid}>
              {candidates.map(({ photo: p }) => {
                const isSel = selected.has(p.id);
                const dimmed = !isSel && atSelectionCap;
                return (
                  <Pressable
                    key={p.id}
                    onPress={() => toggle(p.id)}
                    disabled={attaching || dimmed}
                    style={[
                      styles.tile,
                      {
                        borderColor: isSel ? colors.primary : colors.border,
                        borderWidth: isSel ? 2.5 : 1,
                        opacity: dimmed ? 0.4 : 1,
                      },
                    ]}
                  >
                    <Image
                      source={{ uri: p.remoteUrl ?? p.uri }}
                      style={styles.tileImg}
                      contentFit="cover"
                    />
                    {isSel ? (
                      <View
                        style={[
                          styles.checkBubble,
                          { backgroundColor: colors.primary },
                        ]}
                      >
                        <Feather
                          name="check"
                          size={14}
                          color={colors.primaryForeground}
                        />
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        )}

        {candidates.length > 0 && remainingSlots > 0 ? (
          <View
            style={[
              styles.footer,
              {
                borderTopColor: colors.border,
                backgroundColor: colors.background,
                paddingBottom: insets.bottom + 12,
              },
            ]}
          >
            <Button
              title={
                selected.size === 0
                  ? "Select photos"
                  : `Attach (${selected.size})`
              }
              size="lg"
              loading={attaching}
              disabled={selected.size === 0}
              onPress={() => void attachSelected()}
            />
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { fontFamily: "Inter_600SemiBold", fontSize: 16 },
  headerTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: TILE_GAP },
  tile: {
    width: `${100 / TILES_PER_ROW - 2}%`,
    aspectRatio: 1,
    borderRadius: 10,
    overflow: "hidden",
    position: "relative",
  },
  tileImg: { width: "100%", height: "100%" },
  checkBubble: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
