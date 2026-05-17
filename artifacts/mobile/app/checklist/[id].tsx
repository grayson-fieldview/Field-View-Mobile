import { Feather } from "@expo/vector-icons";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { ChecklistItemRow } from "@/components/ChecklistItemRow";
import { PhotoPickerModal } from "@/components/PhotoPickerModal";
import { useToast } from "@/contexts/ToastContext";
import KebabIcon from "@/components/KebabIcon";
import { useChecklistDetail } from "@/hooks/useProjectChecklists";
import { useColors } from "@/hooks/useColors";
import { ApiError, api, type BackendChecklistItem } from "@/services/api";
import { subscribeAttach } from "@/services/uploadQueue";

/**
 * Checklist detail screen (server-backed v2).
 *
 * Loads sections + items + per-item options/photos via useChecklistDetail.
 * The screen passes:
 *  - `title` and `projectId` through router params (set by the project
 *    list when navigating in) so we don't need an extra GET /checklists/:id
 *    just to render the header. Deep-link safety: if title is missing,
 *    we fall back to "Checklist".
 *  - `id` as the checklist instance id.
 *
 * Photo flow: each item's "Add photo" opens a small action sheet with
 * "Take new photo" (router.push to /capture with checklistItemId param —
 * the upload queue's post-upload tagger does the attach) and "Choose
 * from project photos" (PhotoPickerModal).
 *
 * Auto-refresh: subscribes to the upload queue so when an upload tagged
 * with one of our items reaches "uploaded", we refresh that item's
 * photos. The upload queue has already attached by then; we just pull
 * the new junction row.
 */
export default function ChecklistDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { showToast } = useToast();
  const params = useLocalSearchParams<{
    id: string;
    title?: string;
    projectId?: string;
  }>();
  const checklistId = params.id;
  const projectId = params.projectId;
  const titleParam = params.title;

  const detail = useChecklistDetail(checklistId);
  const {
    sections,
    items,
    optionsByItemId,
    photosByItemId,
    loading,
    error,
    refresh,
    refreshItemPhotos,
    updateItem,
    attachPhotoLocal,
    detachPhoto,
  } = detail;

  // --- per-item photo source picker state ---
  const [photoSourceForItemId, setPhotoSourceForItemId] = useState<string | null>(
    null,
  );
  const [pickerForItemId, setPickerForItemId] = useState<string | null>(null);

  // --- upload-queue → attach-event bridge ---
  // The upload queue performs the post-upload attach itself (with
  // retries) and emits an event when it settles. We listen for events
  // scoped to *our* items and update local state directly from the
  // event payload — no polling, no setTimeout race. On failure we still
  // try a refetch in case the attach actually landed but the response
  // didn't parse, and surface a toast.
  const itemIdSetRef = useRef<Set<string>>(new Set());
  itemIdSetRef.current = new Set(items.map((i) => String(i.id)));

  useEffect(() => {
    const unsub = subscribeAttach((evt) => {
      if (!itemIdSetRef.current.has(evt.checklistItemId)) return;
      if (evt.photo) {
        attachPhotoLocal(evt.checklistItemId, evt.photo);
      } else {
        // Belt-and-suspenders: refetch in case the row actually landed.
        void refreshItemPhotos(evt.checklistItemId);
        showToast(
          evt.error
            ? `Couldn't attach photo: ${evt.error}`
            : "Couldn't attach photo.",
        );
      }
    });
    return unsub;
  }, [attachPhotoLocal, refreshItemPhotos, showToast]);

  // Group items by section, keeping any sectionless items in a synthetic
  // "Other" bucket at the bottom. Items inside each bucket are already in
  // sortOrder courtesy of the server.
  const grouped = useMemo(() => {
    const bySection = new Map<string, BackendChecklistItem[]>();
    const looseItems: BackendChecklistItem[] = [];
    for (const it of items) {
      if (it.sectionId === null || it.sectionId === undefined) {
        looseItems.push(it);
      } else {
        const k = String(it.sectionId);
        const arr = bySection.get(k) ?? [];
        arr.push(it);
        bySection.set(k, arr);
      }
    }
    const orderedSections = sections
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return { bySection, orderedSections, looseItems };
  }, [items, sections]);

  // Derived progress: count fully-complete items vs total.
  const progress = useMemo(() => {
    let done = 0;
    for (const it of items) {
      const ph = photosByItemId[String(it.id)] ?? [];
      if (isItemComplete(it, ph.length)) done += 1;
    }
    return { done, total: items.length };
  }, [items, photosByItemId]);

  const onPickUpdateError = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) return;
    showToast(e instanceof Error ? e.message : "Couldn't save change.");
  };

  const handleUpdate = async (
    itemId: string,
    patch: Partial<BackendChecklistItem>,
  ) => {
    try {
      await updateItem(itemId, patch);
    } catch (e) {
      onPickUpdateError(e);
    }
  };

  const handleDetach = async (
    itemId: string,
    junctionId: string | number,
  ) => {
    try {
      await detachPhoto(itemId, junctionId);
    } catch (e) {
      onPickUpdateError(e);
    }
  };

  const openPhotoSource = (itemId: string) => {
    setPhotoSourceForItemId(itemId);
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["Cancel", "Take new photo", "Choose from project photos"],
          cancelButtonIndex: 0,
        },
        (idx) => {
          setPhotoSourceForItemId(null);
          if (idx === 1) launchCapture(itemId);
          else if (idx === 2) setPickerForItemId(itemId);
        },
      );
    } else {
      Alert.alert("Add photo", undefined, [
        { text: "Cancel", style: "cancel", onPress: () => setPhotoSourceForItemId(null) },
        {
          text: "Take new photo",
          onPress: () => {
            setPhotoSourceForItemId(null);
            launchCapture(itemId);
          },
        },
        {
          text: "Choose from project photos",
          onPress: () => {
            setPhotoSourceForItemId(null);
            setPickerForItemId(itemId);
          },
        },
      ]);
    }
  };

  const launchCapture = (itemId: string) => {
    if (!projectId) {
      showToast(
        "Couldn't open camera (missing project context). Re-open the checklist from the project page.",
      );
      return;
    }
    router.push({
      pathname: "/capture",
      params: { projectId, checklistItemId: itemId },
    });
  };

  const headerTitle = titleParam || "Checklist";

  // ----- Delete this checklist (header kebab) -----
  // Mirrors the report-detail kebab pattern: ActionSheetIOS on iOS,
  // Alert.alert fallback on Android/web. On confirm we call the server
  // DELETE directly (the project page's useProjectChecklists will
  // refetch on focus when we router.back()). We deliberately do NOT
  // wire the hook here — this screen receives `id` via deep link and
  // doesn't always have access to a projectId, so going through the
  // hook would be inert anyway. Server-first; local refresh on back.
  const handleDeleteChecklist = () => {
    if (!checklistId) return;
    Alert.alert(
      "Delete checklist?",
      "This will permanently remove the checklist and all its sections, items, and recorded responses.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await api.deleteChecklist(checklistId);
              showToast("Checklist deleted");
              router.back();
            } catch (e) {
              if (e instanceof ApiError && e.status === 401) return;
              showToast(
                e instanceof Error ? e.message : "Couldn't delete checklist.",
              );
            }
          },
        },
      ],
    );
  };

  const openKebab = () => {
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["Cancel", "Delete checklist"],
          cancelButtonIndex: 0,
          destructiveButtonIndex: 1,
        },
        (idx) => {
          if (idx === 1) handleDeleteChecklist();
        },
      );
    } else {
      Alert.alert("Checklist", undefined, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete checklist",
          style: "destructive",
          onPress: handleDeleteChecklist,
        },
      ]);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: headerTitle,
          // Explicit headerLeft fully replaces the system back button —
          // guarantees the back action works even if the default
          // chevron's hit region gets squeezed by a long title +
          // headerRight kebab on iOS.
          headerLeft: () => (
            <Pressable
              onPress={() => router.back()}
              hitSlop={16}
              accessibilityRole="button"
              accessibilityLabel="Back"
              style={{ paddingHorizontal: 8 }}
            >
              <Feather
                name="chevron-left"
                size={28}
                color={colors.foreground}
              />
            </Pressable>
          ),
          headerRight: () => (
            <Pressable
              onPress={openKebab}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Checklist options"
              style={{ paddingHorizontal: 4 }}
            >
              <KebabIcon size={20} color={colors.foreground} />
            </Pressable>
          ),
        }}
      />

      {loading && items.length === 0 ? (
        <View style={[styles.center, { paddingTop: insets.top + 80 }]}>
          <ActivityIndicator color={colors.mutedForeground} />
        </View>
      ) : error && items.length === 0 ? (
        <View style={[styles.center, { padding: 24, gap: 12 }]}>
          <Text
            style={{
              color: colors.destructive,
              fontFamily: "Inter_500Medium",
              textAlign: "center",
            }}
          >
            {error}
          </Text>
          <Button
            title="Retry"
            variant="secondary"
            onPress={() => void refresh()}
          />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{
            padding: 16,
            paddingBottom: insets.bottom + 32,
            gap: 16,
          }}
        >
          {/* Header / progress */}
          <View
            style={[
              styles.progressCard,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <Text
              style={[
                styles.progressSub,
                { color: colors.mutedForeground },
              ]}
            >
              {progress.done} / {progress.total} complete
            </Text>
            <View
              style={[
                styles.progressTrack,
                { backgroundColor: colors.border },
              ]}
            >
              <View
                style={[
                  styles.progressFill,
                  {
                    backgroundColor: colors.primary,
                    width: `${
                      progress.total === 0
                        ? 0
                        : (progress.done / progress.total) * 100
                    }%`,
                  },
                ]}
              />
            </View>
          </View>

          {grouped.orderedSections.map((sec) => {
            const its = grouped.bySection.get(String(sec.id)) ?? [];
            if (its.length === 0) return null;
            return (
              <View key={String(sec.id)} style={{ gap: 10 }}>
                <Text
                  style={[
                    styles.sectionTitle,
                    { color: colors.mutedForeground },
                  ]}
                >
                  {sec.title}
                </Text>
                {its.map((it) => (
                  <ChecklistItemRow
                    key={String(it.id)}
                    item={it}
                    options={optionsByItemId[String(it.id)] ?? []}
                    photos={photosByItemId[String(it.id)] ?? []}
                    onUpdate={(patch) => handleUpdate(String(it.id), patch)}
                    onAddPhoto={() => openPhotoSource(String(it.id))}
                    onDetachPhoto={(jid) => handleDetach(String(it.id), jid)}
                  />
                ))}
              </View>
            );
          })}

          {grouped.looseItems.length > 0 ? (
            <View style={{ gap: 10 }}>
              {grouped.orderedSections.length > 0 ? (
                <Text
                  style={[
                    styles.sectionTitle,
                    { color: colors.mutedForeground },
                  ]}
                >
                  Other
                </Text>
              ) : null}
              {grouped.looseItems.map((it) => (
                <ChecklistItemRow
                  key={String(it.id)}
                  item={it}
                  options={optionsByItemId[String(it.id)] ?? []}
                  photos={photosByItemId[String(it.id)] ?? []}
                  onUpdate={(patch) => handleUpdate(String(it.id), patch)}
                  onAddPhoto={() => openPhotoSource(String(it.id))}
                  onDetachPhoto={(jid) => handleDetach(String(it.id), jid)}
                />
              ))}
            </View>
          ) : null}

          {items.length === 0 ? (
            <View style={[styles.center, { padding: 32, gap: 8 }]}>
              <Feather name="list" size={28} color={colors.mutedForeground} />
              <Text
                style={{
                  color: colors.mutedForeground,
                  fontFamily: "Inter_500Medium",
                  fontSize: 14,
                  textAlign: "center",
                }}
              >
                This checklist has no items yet. Add items on the web.
              </Text>
            </View>
          ) : null}
        </ScrollView>
      )}

      {/* Choose-from-existing photo picker (one at a time across all items). */}
      {pickerForItemId && projectId ? (
        <PhotoPickerModal
          visible={true}
          onClose={() => setPickerForItemId(null)}
          projectId={projectId}
          itemId={pickerForItemId}
          alreadyAttachedMediaIds={
            new Set(
              (photosByItemId[pickerForItemId] ?? []).map((p) => p.mediaId),
            )
          }
          onAttached={(succeeded, failedCount) => {
            for (const ph of succeeded) {
              detail.attachPhotoLocal(pickerForItemId, ph);
            }
            if (failedCount > 0) {
              showToast(
                `Attached ${succeeded.length}, failed ${failedCount}.`,
              );
            } else if (succeeded.length > 0) {
              showToast(
                `Attached ${succeeded.length} photo${
                  succeeded.length === 1 ? "" : "s"
                }.`,
              );
            }
          }}
        />
      ) : null}
    </View>
  );
}

function isItemComplete(
  item: BackendChecklistItem,
  photoCount: number,
): boolean {
  const photoOk = (item.photosRequired ?? 0) <= photoCount;
  let hasValue = false;
  switch (item.fieldType) {
    case "yes_no":
      hasValue = item.valueBool === true || item.valueBool === false;
      break;
    case "rating":
      hasValue =
        typeof item.valueRating === "number" && item.valueRating > 0;
      break;
    case "text":
      hasValue =
        typeof item.valueText === "string" && item.valueText.trim().length > 0;
      break;
    case "multiple_choice":
      hasValue =
        typeof item.selectedOptionId === "number" && item.selectedOptionId > 0;
      break;
  }
  return hasValue && photoOk;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  progressCard: {
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
    gap: 8,
  },
  progressTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.3,
  },
  progressSub: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    overflow: "hidden",
    marginTop: 4,
  },
  progressFill: {
    height: "100%",
    borderRadius: 3,
  },
  sectionTitle: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginTop: 4,
    marginBottom: 2,
  },
});
