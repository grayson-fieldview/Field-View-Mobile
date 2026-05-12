import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import React, { useEffect, useMemo, useState } from "react";
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

import { Input } from "@/components/Input";
import { useToast } from "@/contexts/ToastContext";
import { useColors } from "@/hooks/useColors";
import { ApiError, api, type BackendUser, type UserRole } from "@/services/api";

interface Props {
  visible: boolean;
  projectId: string | number;
  currentlyAssignedUserIds: string[];
  currentUserId: string | undefined;
  onClose: () => void;
  /** Called after a successful assignment so parent can refresh its list. */
  onAssigned: () => void;
}

/**
 * Admin-only modal for adding an EXISTING account user to the current
 * project. Mobile no longer invites brand-new users — that flow stays
 * web-only at app.field-view.com.
 *
 * The trigger button + this modal are gated upstream on
 * `useAuth().user?.role === "admin"`. We do NOT re-check role here.
 */
export function AssignUserToProjectModal({
  visible,
  projectId,
  currentlyAssignedUserIds,
  currentUserId,
  onClose,
  onAssigned,
}: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { showToast } = useToast();

  const [users, setUsers] = useState<BackendUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  /** Per-row submitting state — prevents double-tap and shows a row spinner. */
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  /** Per-row inline error (e.g. defensive 409). Keyed by user id. */
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  // Reset + load whenever the modal re-opens. We always re-fetch on open
  // so the list reflects any newly-invited users from the web app.
  useEffect(() => {
    if (!visible) return;
    setSearch("");
    setSubmittingId(null);
    setRowErrors({});
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const rows = await api.listAccountUsers();
        if (!cancelled) setUsers(Array.isArray(rows) ? rows : []);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) return;
        setLoadError(
          e instanceof Error ? e.message : "Couldn't load teammates.",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  // Set lookup is O(1) per check; rebuild on prop change.
  const assignedSet = useMemo(
    () => new Set(currentlyAssignedUserIds.map(String)),
    [currentlyAssignedUserIds],
  );

  const eligibleUsers = useMemo(() => {
    return users
      .filter((u) => {
        const id = String(u.id);
        if (currentUserId && id === String(currentUserId)) return false;
        if (u.deletedAt) return false;
        if (assignedSet.has(id)) return false;
        return true;
      })
      .sort((a, b) => {
        const aKey =
          (`${a.firstName ?? ""} ${a.lastName ?? ""}`.trim() || a.email)
            .toLowerCase();
        const bKey =
          (`${b.firstName ?? ""} ${b.lastName ?? ""}`.trim() || b.email)
            .toLowerCase();
        return aKey.localeCompare(bKey);
      });
  }, [users, currentUserId, assignedSet]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return eligibleUsers;
    return eligibleUsers.filter((u) => {
      const hay =
        `${u.firstName ?? ""} ${u.lastName ?? ""} ${u.email}`.toLowerCase();
      return hay.includes(q);
    });
  }, [eligibleUsers, search]);

  const assign = async (user: BackendUser) => {
    const id = String(user.id);
    if (submittingId) return;
    setSubmittingId(id);
    setRowErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      await api.assignUserToProject(projectId, id);
      const fullName =
        `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || user.email;
      showToast(`Added ${fullName} to project`);
      onAssigned();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setRowErrors((prev) => ({
          ...prev,
          [id]: "User is already assigned",
        }));
      } else {
        showToast(
          `Couldn't add user: ${
            e instanceof Error ? e.message : "unknown error"
          }`,
        );
      }
    } finally {
      setSubmittingId(null);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <View
          style={[
            styles.header,
            {
              paddingTop: insets.top + 8,
              borderBottomColor: colors.border,
            },
          ]}
        >
          <Pressable onPress={onClose} hitSlop={10}>
            <Text
              style={{
                color: colors.primary,
                fontFamily: "Inter_600SemiBold",
                fontSize: 16,
              }}
            >
              Cancel
            </Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.foreground }]}>
            Add user to project
          </Text>
          <View style={{ width: 50 }} />
        </View>

        <View style={{ paddingHorizontal: 20, paddingTop: 14, gap: 12 }}>
          <Text
            style={{
              color: colors.mutedForeground,
              fontFamily: "Inter_400Regular",
              fontSize: 13,
            }}
          >
            Select a teammate to give them access to this project.
          </Text>
          <Input
            value={search}
            onChangeText={setSearch}
            placeholder="Search by name or email"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        {loading && users.length === 0 ? (
          <View style={{ paddingVertical: 40, alignItems: "center" }}>
            <ActivityIndicator color={colors.mutedForeground} />
          </View>
        ) : loadError ? (
          <View style={{ padding: 20 }}>
            <Text
              style={{
                color: colors.destructive,
                fontFamily: "Inter_500Medium",
                fontSize: 14,
              }}
            >
              {loadError}
            </Text>
          </View>
        ) : eligibleUsers.length === 0 ? (
          <View style={{ padding: 24, gap: 6 }}>
            <Text
              style={{
                color: colors.foreground,
                fontFamily: "Inter_600SemiBold",
                fontSize: 15,
              }}
            >
              Everyone in your account is already on this project.
            </Text>
            <Text
              style={{
                color: colors.mutedForeground,
                fontFamily: "Inter_400Regular",
                fontSize: 13,
              }}
            >
              Invite new users from the web app at app.field-view.com.
            </Text>
          </View>
        ) : filteredUsers.length === 0 ? (
          <View style={{ padding: 24 }}>
            <Text
              style={{
                color: colors.mutedForeground,
                fontFamily: "Inter_400Regular",
                fontSize: 13,
              }}
            >
              No teammates match &ldquo;{search}&rdquo;.
            </Text>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={{
              padding: 20,
              paddingBottom: insets.bottom + 40,
              gap: 10,
            }}
            keyboardShouldPersistTaps="handled"
          >
            {filteredUsers.map((u) => {
              const id = String(u.id);
              const submitting = submittingId === id;
              const fullName =
                `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email;
              const initials =
                `${(u.firstName ?? "")[0] ?? ""}${(u.lastName ?? "")[0] ?? ""}`.toUpperCase() ||
                (u.email[0]?.toUpperCase() ?? "?");
              const rowError = rowErrors[id];
              return (
                <Pressable
                  key={id}
                  onPress={() => assign(u)}
                  disabled={submitting || submittingId !== null}
                  style={({ pressed }) => [
                    styles.row,
                    {
                      backgroundColor: colors.card,
                      borderColor: rowError ? colors.destructive : colors.border,
                      opacity:
                        submittingId !== null && !submitting ? 0.5 : pressed ? 0.85 : 1,
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.avatar,
                      { backgroundColor: colors.muted },
                    ]}
                  >
                    {u.profileImageUrl ? (
                      <Image
                        source={{ uri: u.profileImageUrl }}
                        style={{ width: 36, height: 36, borderRadius: 18 }}
                        contentFit="cover"
                      />
                    ) : (
                      <Text
                        style={{
                          color: colors.foreground,
                          fontFamily: "Inter_700Bold",
                          fontSize: 13,
                        }}
                      >
                        {initials}
                      </Text>
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text
                      style={{
                        color: colors.foreground,
                        fontFamily: "Inter_600SemiBold",
                        fontSize: 15,
                      }}
                      numberOfLines={1}
                    >
                      {fullName}
                    </Text>
                    <Text
                      style={{
                        color: colors.mutedForeground,
                        fontFamily: "Inter_400Regular",
                        fontSize: 12,
                        marginTop: 2,
                      }}
                      numberOfLines={1}
                    >
                      {u.email}
                    </Text>
                    {rowError ? (
                      <Text
                        style={{
                          color: colors.destructive,
                          fontFamily: "Inter_500Medium",
                          fontSize: 12,
                          marginTop: 4,
                        }}
                      >
                        {rowError}
                      </Text>
                    ) : null}
                  </View>
                  {submitting ? (
                    <ActivityIndicator
                      color={colors.mutedForeground}
                      style={{ marginLeft: 8 }}
                    />
                  ) : (
                    <RoleBadge role={u.role} colors={colors} />
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

function RoleBadge({
  role,
  colors,
}: {
  role: UserRole | undefined;
  colors: ReturnType<typeof useColors>;
}) {
  if (!role) return null;
  // Color-code per spec: admin orange, manager blue, restricted gray,
  // standard neutral. Using fixed brand colors so the pill reads the
  // same in light + dark modes.
  const palette: Record<UserRole, { bg: string; fg: string }> = {
    admin: { bg: "#FFEDD5", fg: "#9A3412" },
    manager: { bg: "#DBEAFE", fg: "#1E40AF" },
    restricted: { bg: "#E5E7EB", fg: "#374151" },
    standard: { bg: colors.muted, fg: colors.mutedForeground },
  };
  const { bg, fg } = palette[role];
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.badgeText, { color: fg }]}>{role}</Text>
    </View>
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
  title: { fontSize: 16, fontFamily: "Inter_600SemiBold" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
  },
  badgeText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    textTransform: "capitalize",
  },
});
