import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { useToast } from "@/contexts/ToastContext";
import { useColors } from "@/hooks/useColors";
import type { BackendReportSectionPhoto } from "@/services/api";
import type { SectionWithPhotos } from "@/hooks/useReportDetail";

interface Props {
  section: SectionWithPhotos;
  onUpdateMeta: (patch: {
    title?: string;
    summary?: string | null;
  }) => Promise<void>;
  onDelete: () => Promise<void>;
  onAddPhoto: () => void;
  onUpdatePhoto: (
    photoId: string | number,
    patch: { caption?: string | null; description?: string | null },
  ) => Promise<void>;
  onDetachPhoto: (photoId: string | number) => Promise<void>;
}

const DEBOUNCE_MS = 500;

/**
 * Per-section editor card.
 *
 * Title + summary are inline-edited and PATCHed on a 500ms debounce.
 * Title is required (empty string skipped). Photo strip below shows
 * thumbnails: tap → caption/description modal, long-press → detach
 * confirmation. The footer "Delete section" wipes the section + its
 * junction rows (the underlying media is preserved server-side).
 *
 * The local state is kept in sync with incoming props ONLY when no
 * debounce timer is currently pending — otherwise a refresh racing
 * with an in-flight save would clobber the user's keystrokes.
 */
export function ReportSectionCard({
  section,
  onUpdateMeta,
  onDelete,
  onAddPhoto,
  onUpdatePhoto,
  onDetachPhoto,
}: Props) {
  const colors = useColors();
  const { showToast } = useToast();
  const [title, setTitle] = useState(section.title);
  const [summary, setSummary] = useState(section.summary ?? "");
  const [editingPhoto, setEditingPhoto] =
    useState<BackendReportSectionPhoto | null>(null);
  const [deleting, setDeleting] = useState(false);

  const titleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const summaryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTitleSavedRef = useRef(section.title);
  const lastSummarySavedRef = useRef(section.summary ?? "");

  // Reconcile from prop only when no pending debounce — protects
  // in-flight keystrokes from a refresh-induced overwrite.
  useEffect(() => {
    if (titleTimerRef.current === null && section.title !== title) {
      setTitle(section.title);
      lastTitleSavedRef.current = section.title;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section.title]);

  useEffect(() => {
    const next = section.summary ?? "";
    if (summaryTimerRef.current === null && next !== summary) {
      setSummary(next);
      lastSummarySavedRef.current = next;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section.summary]);

  useEffect(() => {
    return () => {
      if (titleTimerRef.current) clearTimeout(titleTimerRef.current);
      if (summaryTimerRef.current) clearTimeout(summaryTimerRef.current);
    };
  }, []);

  const queueTitleSave = (value: string) => {
    if (titleTimerRef.current) clearTimeout(titleTimerRef.current);
    titleTimerRef.current = setTimeout(() => {
      titleTimerRef.current = null;
      const trimmed = value.trim();
      if (!trimmed || trimmed === lastTitleSavedRef.current) return;
      lastTitleSavedRef.current = trimmed;
      onUpdateMeta({ title: trimmed }).catch((e) =>
        showToast(e instanceof Error ? e.message : "Couldn't save section."),
      );
    }, DEBOUNCE_MS);
  };

  const queueSummarySave = (value: string) => {
    if (summaryTimerRef.current) clearTimeout(summaryTimerRef.current);
    summaryTimerRef.current = setTimeout(() => {
      summaryTimerRef.current = null;
      // Empty string → null so the server clears the field rather than
      // storing an empty string.
      const next = value === "" ? null : value;
      const cmp = next ?? "";
      if (cmp === lastSummarySavedRef.current) return;
      lastSummarySavedRef.current = cmp;
      onUpdateMeta({ summary: next }).catch((e) =>
        showToast(e instanceof Error ? e.message : "Couldn't save section."),
      );
    }, DEBOUNCE_MS);
  };

  const handleDelete = () => {
    Alert.alert(
      "Delete section?",
      `"${section.title}" and its photo attachments will be removed from this report. The underlying photos are not deleted.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setDeleting(true);
            try {
              await onDelete();
              // Parent removes the card from the list — no need to
              // reset deleting; the component will unmount.
            } catch (e) {
              showToast(
                e instanceof Error ? e.message : "Couldn't delete section.",
              );
              setDeleting(false);
            }
          },
        },
      ],
    );
  };

  const handleLongPressPhoto = (photo: BackendReportSectionPhoto) => {
    Alert.alert(
      "Detach photo?",
      "It will be removed from this section but kept in the project library.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Detach",
          style: "destructive",
          onPress: () => {
            onDetachPhoto(photo.id).catch((e) =>
              showToast(e instanceof Error ? e.message : "Couldn't detach."),
            );
          },
        },
      ],
    );
  };

  const photoUrl = (p: BackendReportSectionPhoto): string =>
    p.url ?? p.media?.url ?? "";

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <TextInput
        value={title}
        onChangeText={(v) => {
          setTitle(v);
          queueTitleSave(v);
        }}
        placeholder="Section title"
        placeholderTextColor={colors.mutedForeground}
        editable={!deleting}
        style={[styles.titleInput, { color: colors.foreground }]}
      />
      <TextInput
        value={summary}
        onChangeText={(v) => {
          setSummary(v);
          queueSummarySave(v);
        }}
        placeholder="Add a short summary (optional)"
        placeholderTextColor={colors.mutedForeground}
        editable={!deleting}
        multiline
        style={[
          styles.summaryInput,
          {
            color: colors.foreground,
            backgroundColor: colors.background,
            borderColor: colors.border,
          },
        ]}
      />

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingVertical: 4 }}
      >
        {section.photos.map((p) => (
          <Pressable
            key={String(p.id)}
            onPress={() => setEditingPhoto(p)}
            onLongPress={() => handleLongPressPhoto(p)}
            disabled={deleting}
            style={[styles.thumb, { borderColor: colors.border }]}
          >
            <Image
              source={{ uri: photoUrl(p) }}
              style={styles.thumbImg}
              contentFit="cover"
            />
            {p.caption ? (
              <View style={styles.captionBar}>
                <Text numberOfLines={1} style={styles.captionText}>
                  {p.caption}
                </Text>
              </View>
            ) : null}
          </Pressable>
        ))}
        <Pressable
          onPress={onAddPhoto}
          disabled={deleting}
          style={[
            styles.addThumb,
            { borderColor: colors.border, backgroundColor: colors.muted },
          ]}
        >
          <Feather name="plus" size={20} color={colors.foreground} />
          <Text
            style={{
              color: colors.mutedForeground,
              fontSize: 11,
              fontFamily: "Inter_500Medium",
              marginTop: 4,
            }}
          >
            Add photo
          </Text>
        </Pressable>
      </ScrollView>

      <Pressable
        onPress={handleDelete}
        disabled={deleting}
        style={({ pressed }) => [
          styles.deleteBtn,
          { opacity: pressed ? 0.6 : 1 },
        ]}
      >
        {deleting ? (
          <ActivityIndicator color={colors.destructive} size="small" />
        ) : (
          <Feather name="trash-2" size={14} color={colors.destructive} />
        )}
        <Text
          style={{
            color: colors.destructive,
            fontFamily: "Inter_600SemiBold",
            fontSize: 12,
          }}
        >
          Delete section
        </Text>
      </Pressable>

      <PhotoCaptionModal
        photo={editingPhoto}
        onClose={() => setEditingPhoto(null)}
        onSave={(patch) =>
          editingPhoto
            ? onUpdatePhoto(editingPhoto.id, patch)
            : Promise.resolve()
        }
      />
    </View>
  );
}

interface CaptionModalProps {
  photo: BackendReportSectionPhoto | null;
  onClose: () => void;
  onSave: (patch: {
    caption?: string | null;
    description?: string | null;
  }) => Promise<void>;
}

function PhotoCaptionModal({ photo, onClose, onSave }: CaptionModalProps) {
  const colors = useColors();
  const { showToast } = useToast();
  const insets = useSafeAreaInsets();
  const [caption, setCaption] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  // Reset fields whenever the modal target changes.
  useEffect(() => {
    if (photo) {
      setCaption(photo.caption ?? "");
      setDescription(photo.description ?? "");
    }
  }, [photo]);

  const save = async () => {
    if (!photo) return;
    setSaving(true);
    try {
      await onSave({
        caption: caption === "" ? null : caption,
        description: description === "" ? null : description,
      });
      onClose();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Couldn't save photo.");
    } finally {
      setSaving(false);
    }
  };

  const url = photo?.url ?? photo?.media?.url ?? "";

  return (
    <Modal
      visible={photo !== null}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.modalOverlay}
      >
        <View
          style={[
            styles.modalCard,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              paddingBottom: insets.bottom + 16,
            },
          ]}
        >
          <Text style={[styles.modalTitle, { color: colors.foreground }]}>
            Photo details
          </Text>
          {url ? (
            <Image
              source={{ uri: url }}
              style={styles.modalImage}
              contentFit="cover"
            />
          ) : null}
          <TextInput
            value={caption}
            onChangeText={setCaption}
            placeholder="Caption"
            placeholderTextColor={colors.mutedForeground}
            editable={!saving}
            style={[
              styles.modalInput,
              {
                color: colors.foreground,
                backgroundColor: colors.background,
                borderColor: colors.border,
              },
            ]}
          />
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="Description (optional)"
            placeholderTextColor={colors.mutedForeground}
            editable={!saving}
            multiline
            style={[
              styles.modalInput,
              {
                color: colors.foreground,
                backgroundColor: colors.background,
                borderColor: colors.border,
                minHeight: 60,
                textAlignVertical: "top",
              },
            ]}
          />
          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Button
                title="Cancel"
                variant="secondary"
                onPress={onClose}
                disabled={saving}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                title="Save"
                onPress={() => void save()}
                loading={saving}
              />
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    gap: 10,
  },
  titleInput: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.3,
    paddingVertical: 4,
  },
  summaryInput: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 44,
    textAlignVertical: "top",
  },
  thumb: {
    width: 86,
    height: 86,
    borderRadius: 10,
    borderWidth: 1,
    overflow: "hidden",
    position: "relative",
  },
  thumbImg: { width: "100%", height: "100%" },
  captionBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 4,
    paddingVertical: 3,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  captionText: { color: "white", fontSize: 10, fontFamily: "Inter_500Medium" },
  addThumb: {
    width: 86,
    height: 86,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
  },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 6,
    marginTop: 4,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  modalCard: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    padding: 18,
    gap: 12,
  },
  modalTitle: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.2,
  },
  modalImage: {
    width: "100%",
    aspectRatio: 16 / 10,
    borderRadius: 10,
    backgroundColor: "#000",
  },
  modalInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: "Inter_500Medium",
    fontSize: 14,
  },
});
