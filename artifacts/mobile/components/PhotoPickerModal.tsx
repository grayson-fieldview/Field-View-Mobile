import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import React, { useMemo, useState } from "react";
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
import { api, type BackendChecklistItemPhoto } from "@/services/api";

interface Props {
  visible: boolean;
  onClose: () => void;
  projectId: string;
  /**
   * Checklist mode: the item to attach to via api.attachPhotoToItem.
   * Omit when using `onAttachMediaIds` (task mode).
   */
  itemId?: string;
  /** mediaIds already attached to this item/task — filtered out of the grid. */
  alreadyAttachedMediaIds: Set<number>;
  /**
   * Checklist mode: called once with each successful attach's junction
   * row after all complete. Lets the parent insert rows into local
   * state without a round-trip and surface a toast on settle.
   */
  onAttached?: (
    photos: BackendChecklistItemPhoto[],
    failedCount: number,
  ) => void;
  /**
   * Generic mode (tasks): the picker only collects mediaIds; the caller
   * performs the attach (e.g. one bulk POST) and owns success/error
   * handling. Errors must be caught inside — the picker closes either
   * way. Mutually exclusive with itemId/onAttached.
   */
  onAttachMediaIds?: (mediaIds: number[]) => Promise<void>;
}

const TILE_GAP = 8;
const TILES_PER_ROW = 3;

/**
 * Choose-from-existing-photos picker. Reads from DataContext.photos
 * (already loaded for the project) — no extra fetch — and attaches the
 * selected ones in parallel via api.attachPhotoToItem. Failed attaches
 * are reported back via onAttached so the parent can toast.
 */
export function PhotoPickerModal({
  visible,
  onClose,
  projectId,
  itemId,
  alreadyAttachedMediaIds,
  onAttached,
  onAttachMediaIds,
}: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { photos } = useData();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [attaching, setAttaching] = useState(false);

  // Reset selection whenever the picker opens.
  React.useEffect(() => {
    if (visible) setSelected(new Set());
  }, [visible]);

  // Resolve a server media id for each candidate. Backend-originated
  // photos carry `mediaId` from the mapper; locally-captured photos
  // pick it up after the upload queue reconciles. As a last resort we
  // try `Number(p.id)` for legacy rows whose id is the stringified
  // media id. Photos with no resolvable mediaId are filtered out —
  // attaching them would mean POSTing NaN.
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
    setSelected((curr) => {
      const next = new Set(curr);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const attachSelected = async () => {
    if (selected.size === 0 || attaching) return;
    setAttaching(true);
    // Map the local photo-id selection back to server media ids using
    // the candidate map built above (so we never POST NaN).
    const mediaIdByLocalId = new Map(
      candidates.map((c) => [c.photo.id, c.mediaId]),
    );
    const mediaIds = Array.from(selected)
      .map((id) => mediaIdByLocalId.get(id))
      .filter((m): m is number => typeof m === "number");
    // Pre-build mediaId → source URL so we can patch the junction row
    // if the server response omits the convenience `url` field (the
    // bulk-attach endpoint may return rows without the joined media url).
    // Backend-originated photos populate `remoteUrl`; locally-captured-
    // then-uploaded photos may only have the local `uri`, which still
    // renders fine in expo-image.
    // Normalize empty strings to missing so `""` doesn't short-circuit
    // the fallback chain (nullish coalescing keeps `""`, which would
    // leave us with a no-url junction row even when `uri` is valid).
    const nonEmpty = (s: string | undefined | null): string | undefined =>
      typeof s === "string" && s.trim().length > 0 ? s : undefined;
    const urlByMediaId = new Map<number, string>();
    for (const c of candidates) {
      const fallbackUrl = nonEmpty(c.photo.remoteUrl) ?? nonEmpty(c.photo.uri);
      if (fallbackUrl) urlByMediaId.set(c.mediaId, fallbackUrl);
    }
    if (onAttachMediaIds) {
      // Generic (task) mode: hand the ids to the caller, who does the
      // attach and owns error handling. Close either way.
      try {
        await onAttachMediaIds(mediaIds);
      } finally {
        setAttaching(false);
        onClose();
      }
      return;
    }
    if (!itemId) {
      // Misconfigured caller: no attach target. Fail soft.
      setAttaching(false);
      onClose();
      return;
    }
    const results = await Promise.allSettled(
      mediaIds.map(async (mediaId) => {
        const photo = await api.attachPhotoToItem(itemId, mediaId);
        if (!nonEmpty(photo.url)) {
          const fallback = urlByMediaId.get(mediaId);
          if (fallback) return { ...photo, url: fallback };
        }
        return photo;
      }),
    );
    const succeeded: BackendChecklistItemPhoto[] = [];
    let failedCount = 0;
    for (const r of results) {
      if (r.status === "fulfilled") succeeded.push(r.value);
      else failedCount += 1;
    }
    onAttached?.(succeeded, failedCount);
    setAttaching(false);
    onClose();
  };

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

        {candidates.length === 0 ? (
          <View style={{ flex: 1, justifyContent: "center" }}>
            <EmptyState
              icon="image"
              title="No photos to attach"
              description="Take photos for this project first, or all of its photos are already attached to this item."
            />
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={{
              padding: 16,
              paddingBottom: insets.bottom + 96,
            }}
          >
            <View style={styles.grid}>
              {candidates.map(({ photo: p }) => {
                const isSel = selected.has(p.id);
                return (
                  <Pressable
                    key={p.id}
                    onPress={() => toggle(p.id)}
                    disabled={attaching}
                    style={[
                      styles.tile,
                      {
                        borderColor: isSel ? colors.primary : colors.border,
                        borderWidth: isSel ? 2.5 : 1,
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

        {candidates.length > 0 ? (
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
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: TILE_GAP,
  },
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
