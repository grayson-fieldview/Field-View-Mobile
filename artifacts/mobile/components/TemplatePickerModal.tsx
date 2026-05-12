import { Feather } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { useColors } from "@/hooks/useColors";
import {
  ApiError,
  api,
  type BackendChecklistTemplate,
} from "@/services/api";

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Resolves with the id of the chosen template; parent does the apply. */
  onPick: (templateId: string | number) => Promise<void>;
}

/**
 * Mobile cannot author new templates — only pick one to apply. Lists the
 * account's templates with section/item counts (when the server supplies
 * them) so the user knows what they're spawning.
 */
export function TemplatePickerModal({ visible, onClose, onPick }: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [templates, setTemplates] = useState<BackendChecklistTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickingId, setPickingId] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const list = await api.listChecklistTemplates();
        if (cancelled) return;
        setTemplates(Array.isArray(list) ? list : []);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) return;
        setError(e instanceof Error ? e.message : "Couldn't load templates.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const choose = async (templateId: string | number) => {
    setPickingId(String(templateId));
    try {
      await onPick(templateId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't apply template.");
    } finally {
      setPickingId(null);
    }
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
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={[styles.headerBtn, { color: colors.primary }]}>
              Cancel
            </Text>
          </Pressable>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>
            Apply template
          </Text>
          <View style={{ width: 50 }} />
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.mutedForeground} />
          </View>
        ) : error ? (
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
              onPress={() => {
                // Re-trigger by toggling — quick hack: re-set error so the
                // effect doesn't re-run. Just reload via a fresh call.
                setError(null);
                setLoading(true);
                api
                  .listChecklistTemplates()
                  .then((list) =>
                    setTemplates(Array.isArray(list) ? list : []),
                  )
                  .catch((e) =>
                    setError(
                      e instanceof Error
                        ? e.message
                        : "Couldn't load templates.",
                    ),
                  )
                  .finally(() => setLoading(false));
              }}
            />
          </View>
        ) : templates.length === 0 ? (
          <View style={[styles.center, { padding: 32 }]}>
            <Feather name="layers" size={28} color={colors.mutedForeground} />
            <Text
              style={{
                color: colors.mutedForeground,
                fontFamily: "Inter_500Medium",
                textAlign: "center",
                marginTop: 12,
                lineHeight: 20,
              }}
            >
              No templates available yet. Create one on the web to get started.
            </Text>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={{
              padding: 20,
              gap: 12,
              paddingBottom: insets.bottom + 40,
            }}
          >
            {templates.map((t) => {
              const counts: string[] = [];
              if (typeof t.sectionCount === "number")
                counts.push(`${t.sectionCount} section${t.sectionCount === 1 ? "" : "s"}`);
              if (typeof t.itemCount === "number")
                counts.push(`${t.itemCount} item${t.itemCount === 1 ? "" : "s"}`);
              const isPicking = pickingId === String(t.id);
              return (
                <Pressable
                  key={String(t.id)}
                  disabled={pickingId !== null}
                  onPress={() => void choose(t.id)}
                  style={({ pressed }) => [
                    styles.card,
                    {
                      backgroundColor: colors.card,
                      borderColor: colors.border,
                      opacity: pickingId !== null && !isPicking ? 0.4 : pressed ? 0.85 : 1,
                    },
                  ]}
                >
                  <View style={{ flex: 1, gap: 4 }}>
                    {t.category ? (
                      <Text
                        style={{
                          color: colors.mutedForeground,
                          fontSize: 11,
                          fontFamily: "Inter_600SemiBold",
                          letterSpacing: 1,
                          textTransform: "uppercase",
                        }}
                      >
                        {t.category}
                      </Text>
                    ) : null}
                    <Text style={[styles.cardTitle, { color: colors.foreground }]}>
                      {t.title}
                    </Text>
                    {t.description ? (
                      <Text
                        numberOfLines={2}
                        style={{
                          color: colors.mutedForeground,
                          fontSize: 13,
                          fontFamily: "Inter_400Regular",
                          lineHeight: 18,
                        }}
                      >
                        {t.description}
                      </Text>
                    ) : null}
                    {counts.length > 0 ? (
                      <Text
                        style={{
                          color: colors.mutedForeground,
                          fontSize: 12,
                          fontFamily: "Inter_500Medium",
                          marginTop: 2,
                        }}
                      >
                        {counts.join(" • ")}
                      </Text>
                    ) : null}
                  </View>
                  {isPicking ? (
                    <ActivityIndicator color={colors.primary} />
                  ) : (
                    <Feather
                      name="chevron-right"
                      size={20}
                      color={colors.mutedForeground}
                    />
                  )}
                </Pressable>
              );
            })}
          </ScrollView>
        )}
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
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
  },
  cardTitle: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: -0.2,
  },
});
