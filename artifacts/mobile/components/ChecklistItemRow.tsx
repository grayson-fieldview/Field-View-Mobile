import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import React, { useEffect, useRef, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useColors } from "@/hooks/useColors";
import type {
  BackendChecklistItem,
  BackendChecklistItemOption,
  BackendChecklistItemPhoto,
} from "@/services/api";

interface Props {
  item: BackendChecklistItem;
  options: BackendChecklistItemOption[];
  photos: BackendChecklistItemPhoto[];
  /** Patches a value field — caller routes to useChecklistDetail.updateItem. */
  onUpdate: (patch: Partial<BackendChecklistItem>) => Promise<void>;
  /** Open the photo source picker (Take / Choose) — parent owns the modals. */
  onAddPhoto: () => void;
  /** Detach a previously-attached photo. */
  onDetachPhoto: (junctionId: string | number) => Promise<void>;
}

const TEXT_DEBOUNCE_MS = 500;
const NOTES_DEBOUNCE_MS = 600;

/**
 * One checklist item: label + helpText + the appropriate value editor for
 * the field type, plus collapsible notes and a horizontal photo strip.
 *
 * Optimistic-write convention: text inputs hold local state and debounce
 * the commit to the parent's onUpdate. Switches / radios / stars commit
 * immediately on tap.
 */
export function ChecklistItemRow({
  item,
  options,
  photos,
  onUpdate,
  onAddPhoto,
  onDetachPhoto,
}: Props) {
  const colors = useColors();
  const [notesOpen, setNotesOpen] = useState(
    !!(item.notes && item.notes.length > 0),
  );

  const isComplete = computeComplete(item, photos.length);

  const photosNeeded = Math.max(
    0,
    (item.photosRequired ?? 0) - photos.length,
  );

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <View style={styles.headerRow}>
        <View
          style={[
            styles.dot,
            {
              backgroundColor: isComplete ? colors.primary : "transparent",
              borderColor: isComplete ? colors.primary : colors.border,
            },
          ]}
        >
          {isComplete ? (
            <Feather name="check" size={11} color={colors.primaryForeground} />
          ) : null}
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[styles.label, { color: colors.foreground }]}>
            {item.label}
            {item.required ? (
              <Text style={{ color: colors.destructive }}> *</Text>
            ) : null}
          </Text>
          {item.helpText ? (
            <Text
              style={[styles.help, { color: colors.mutedForeground }]}
            >
              {item.helpText}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={{ marginTop: 12 }}>
        <FieldEditor item={item} options={options} onUpdate={onUpdate} />
      </View>

      {/* Notes (collapsible) */}
      <Pressable
        onPress={() => setNotesOpen((v) => !v)}
        style={styles.notesHeader}
      >
        <Feather
          name={notesOpen ? "chevron-down" : "chevron-right"}
          size={14}
          color={colors.mutedForeground}
        />
        <Text style={[styles.notesHeaderTxt, { color: colors.mutedForeground }]}>
          Notes{item.notes ? ` · ${item.notes.length}` : ""}
        </Text>
      </Pressable>
      {notesOpen ? (
        <NotesField
          initial={item.notes ?? ""}
          onCommit={(v) => onUpdate({ notes: v.length > 0 ? v : null })}
        />
      ) : null}

      {/* Photo strip */}
      <View style={styles.photoSection}>
        <View style={styles.photoHeader}>
          <Text
            style={[styles.photoHeaderTxt, { color: colors.mutedForeground }]}
          >
            Photos
            {item.photosRequired ? (
              <Text style={{ color: photosNeeded > 0 ? colors.destructive : colors.mutedForeground }}>
                {" "}
                · {photos.length}/{item.photosRequired}
              </Text>
            ) : photos.length > 0 ? (
              <Text> · {photos.length}</Text>
            ) : null}
          </Text>
          <Pressable
            onPress={onAddPhoto}
            hitSlop={8}
            style={[
              styles.addPhotoBtn,
              { borderColor: colors.border, backgroundColor: colors.accent },
            ]}
          >
            <Feather name="plus" size={14} color={colors.foreground} />
            <Text
              style={[styles.addPhotoTxt, { color: colors.foreground }]}
            >
              Add
            </Text>
          </Pressable>
        </View>
        {photos.length > 0 ? (
          <View style={styles.photoStrip}>
            {photos.map((p) => (
              <Pressable
                key={String(p.id)}
                onLongPress={() => confirmDetach(p, onDetachPhoto)}
                style={[styles.thumb, { borderColor: colors.border }]}
              >
                {typeof p.url === "string" && p.url.trim().length > 0 ? (
                  <Image
                    source={{ uri: p.url }}
                    style={styles.thumbImg}
                    contentFit="cover"
                  />
                ) : (
                  // Safety net: if a future code path lands a junction
                  // row without `url`, show a muted square instead of a
                  // broken/blank image so the regression is visible but
                  // not user-breaking. See TECH_DEBT.md.
                  <View
                    style={[
                      styles.thumbImg,
                      { backgroundColor: colors.border },
                    ]}
                  />
                )}
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function confirmDetach(
  photo: BackendChecklistItemPhoto,
  onDetach: (id: string | number) => Promise<void>,
) {
  const doDetach = () => {
    void onDetach(photo.id);
  };
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ["Cancel", "Remove from item"],
        destructiveButtonIndex: 1,
        cancelButtonIndex: 0,
      },
      (idx) => {
        if (idx === 1) doDetach();
      },
    );
  } else {
    Alert.alert("Remove photo from this item?", undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: doDetach },
    ]);
  }
}

// ----- field-type editors -----

function FieldEditor({
  item,
  options,
  onUpdate,
}: {
  item: BackendChecklistItem;
  options: BackendChecklistItemOption[];
  onUpdate: (patch: Partial<BackendChecklistItem>) => Promise<void>;
}) {
  switch (item.fieldType) {
    case "yes_no":
      return (
        <YesNoField
          value={item.valueBool ?? null}
          onChange={(v) => onUpdate({ valueBool: v })}
        />
      );
    case "rating":
      return (
        <RatingField
          value={item.valueRating ?? null}
          onChange={(v) => onUpdate({ valueRating: v })}
        />
      );
    case "text":
      return (
        <TextValueField
          initial={item.valueText ?? ""}
          onCommit={(v) =>
            onUpdate({ valueText: v.length > 0 ? v : null })
          }
        />
      );
    case "multiple_choice":
      return (
        <MultipleChoiceField
          options={options}
          value={item.selectedOptionId ?? null}
          onChange={(v) => onUpdate({ selectedOptionId: v })}
        />
      );
    default:
      return null;
  }
}

function YesNoField({
  value,
  onChange,
}: {
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  const colors = useColors();
  const segs: { label: string; v: boolean | null }[] = [
    { label: "No", v: false },
    { label: "Yes", v: true },
  ];
  return (
    <View style={[styles.segment, { borderColor: colors.border }]}>
      {segs.map((s) => {
        const on = value === s.v;
        return (
          <Pressable
            key={s.label}
            onPress={() => onChange(on ? null : s.v)}
            style={[
              styles.segmentBtn,
              {
                backgroundColor: on ? colors.primary : "transparent",
              },
            ]}
          >
            <Text
              style={{
                color: on ? colors.primaryForeground : colors.foreground,
                fontFamily: "Inter_600SemiBold",
                fontSize: 14,
              }}
            >
              {s.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function RatingField({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const colors = useColors();
  return (
    <View style={styles.starRow}>
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = value !== null && value >= n;
        return (
          <Pressable
            key={n}
            hitSlop={6}
            onPress={() => onChange(value === n ? null : n)}
          >
            <Feather
              name="star"
              size={28}
              color={filled ? colors.primary : colors.border}
              style={{
                opacity: filled ? 1 : 0.7,
              }}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

function TextValueField({
  initial,
  onCommit,
}: {
  initial: string;
  onCommit: (v: string) => Promise<void>;
}) {
  const colors = useColors();
  const [val, setVal] = useState(initial);
  const lastCommitted = useRef(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // If the upstream value changes (e.g. revert after PATCH failure), sync.
  useEffect(() => {
    setVal(initial);
    lastCommitted.current = initial;
  }, [initial]);

  const schedule = (next: string) => {
    setVal(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (next !== lastCommitted.current) {
        lastCommitted.current = next;
        void onCommit(next);
      }
    }, TEXT_DEBOUNCE_MS);
  };

  const flush = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (val !== lastCommitted.current) {
      lastCommitted.current = val;
      void onCommit(val);
    }
  };

  return (
    <TextInput
      value={val}
      onChangeText={schedule}
      onBlur={flush}
      placeholder="Enter response…"
      placeholderTextColor={colors.mutedForeground}
      multiline
      style={[
        styles.textInput,
        {
          color: colors.foreground,
          backgroundColor: colors.background,
          borderColor: colors.border,
        },
      ]}
    />
  );
}

function MultipleChoiceField({
  options,
  value,
  onChange,
}: {
  options: BackendChecklistItemOption[];
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const colors = useColors();
  if (options.length === 0) {
    return (
      <Text
        style={{
          color: colors.mutedForeground,
          fontFamily: "Inter_400Regular",
          fontSize: 13,
          fontStyle: "italic",
        }}
      >
        No choices configured for this item.
      </Text>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      {options.map((o) => {
        const numId = Number(o.id);
        const on = value === numId;
        return (
          <Pressable
            key={String(o.id)}
            onPress={() => onChange(on ? null : numId)}
            style={[
              styles.radioRow,
              {
                borderColor: on ? colors.primary : colors.border,
                backgroundColor: on ? colors.accent : "transparent",
              },
            ]}
          >
            <View
              style={[
                styles.radioDot,
                {
                  borderColor: on ? colors.primary : colors.border,
                },
              ]}
            >
              {on ? (
                <View
                  style={[
                    styles.radioInner,
                    { backgroundColor: colors.primary },
                  ]}
                />
              ) : null}
            </View>
            <Text
              style={{
                color: colors.foreground,
                fontSize: 14,
                fontFamily: "Inter_500Medium",
                flex: 1,
              }}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function NotesField({
  initial,
  onCommit,
}: {
  initial: string;
  onCommit: (v: string) => Promise<void>;
}) {
  const colors = useColors();
  const [val, setVal] = useState(initial);
  const lastCommitted = useRef(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setVal(initial);
    lastCommitted.current = initial;
  }, [initial]);

  const schedule = (next: string) => {
    setVal(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (next !== lastCommitted.current) {
        lastCommitted.current = next;
        void onCommit(next);
      }
    }, NOTES_DEBOUNCE_MS);
  };

  const flush = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (val !== lastCommitted.current) {
      lastCommitted.current = val;
      void onCommit(val);
    }
  };

  return (
    <TextInput
      value={val}
      onChangeText={schedule}
      onBlur={flush}
      placeholder="Add a note…"
      placeholderTextColor={colors.mutedForeground}
      multiline
      style={[
        styles.notesInput,
        {
          color: colors.foreground,
          backgroundColor: colors.background,
          borderColor: colors.border,
        },
      ]}
    />
  );
}

// ----- completeness -----

/**
 * Returns true when the item has a value AND meets its photosRequired
 * threshold. Mirrors the server's notion (cf. completedAt is stamped
 * when the item transitions to "has value"), with the extra photo gate.
 */
function computeComplete(
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
  card: {
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
    gap: 4,
  },
  headerRow: {
    flexDirection: "row",
    gap: 12,
  },
  dot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  label: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: -0.1,
    lineHeight: 20,
  },
  help: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  segment: {
    flexDirection: "row",
    borderRadius: 12,
    borderWidth: 1,
    padding: 3,
    gap: 3,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 9,
    alignItems: "center",
  },
  starRow: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  textInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 48,
    textAlignVertical: "top",
    fontSize: 15,
    fontFamily: "Inter_500Medium",
  },
  radioRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderRadius: 10,
  },
  radioDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  radioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  notesHeader: {
    marginTop: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  notesHeaderTxt: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  notesInput: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 64,
    textAlignVertical: "top",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  photoSection: {
    marginTop: 14,
    gap: 10,
  },
  photoHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  photoHeaderTxt: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  addPhotoBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  addPhotoTxt: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  photoStrip: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  thumb: {
    width: 64,
    height: 64,
    borderRadius: 8,
    overflow: "hidden",
    borderWidth: 1,
  },
  thumbImg: { width: "100%", height: "100%" },
});
