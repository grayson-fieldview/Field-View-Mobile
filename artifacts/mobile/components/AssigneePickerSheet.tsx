import { Feather } from "@expo/vector-icons";
import {
  BottomSheetBackdrop,
  type BottomSheetBackdropProps,
  BottomSheetModal,
  BottomSheetScrollView,
} from "@gorhom/bottom-sheet";
import { Image } from "expo-image";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Input } from "@/components/Input";
import { useColors } from "@/hooks/useColors";
import {
  ApiError,
  api,
  type BackendUser,
  type UserRole,
} from "@/services/api";

/**
 * Selection emitted by the picker. `null` means "Unassigned" — callers
 * should pass `assignedToId: null` to the API to clear the field.
 */
export type AssigneeSelection = {
  userId: string;
  displayName: string;
} | null;

interface Props {
  visible: boolean;
  projectId: string | number;
  /** Currently-selected user id (null/undefined for unassigned). Just renders the checkmark. */
  selectedUserId?: string | null;
  onClose: () => void;
  onSelect: (selection: AssigneeSelection) => void;
}

/**
 * Bottom-sheet picker for assigning a task to an account teammate.
 *
 * On open, fetches `/api/users?assignableForProjectId=<projectId>` so
 * the server returns the role-aware list (admin/manager/standard always;
 * restricted only when explicitly assigned to the project). This matches
 * web's assignee-picker behavior since the 2026-05 role rework. It is
 * intentionally NOT scoped to project_assignments — managers/admins who
 * aren't on the project Team tab still need to be assignable here.
 *
 * Always includes an "Unassigned" option at the top. Tapping a row
 * immediately fires `onSelect` and closes — no separate "Save" step,
 * mirroring the iOS native picker convention.
 */
export function AssigneePickerSheet({
  visible,
  projectId,
  selectedUserId,
  onClose,
  onSelect,
}: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const [users, setUsers] = useState<BackendUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!visible) return;
    setSearch("");
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const rows = await api.listUsers({ assignableForProjectId: projectId });
        if (cancelled) return;
        // Filter out soft-deleted users client-side — same convention
        // AssignUserToProjectModal uses. Server may or may not include
        // them depending on caller role; safer to always drop them here.
        const live = (Array.isArray(rows) ? rows : []).filter(
          (u) => u.deletedAt == null,
        );
        setUsers(live);
      } catch (e) {
        if (cancelled) return;
        // A 401 used to bail silently here, leaving an empty, unusable
        // picker with no explanation (build 40 Bug C). Make it loud —
        // it's almost always a dropped session.
        if (e instanceof ApiError && e.status === 401) {
          setLoadError(
            "Your session expired — couldn't load teammates. Pull to retry or sign in again.",
          );
          return;
        }
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
  }, [visible, projectId]);

  // Sort by display name so the list reads predictably.
  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) => {
      const aKey =
        (`${a.firstName ?? ""} ${a.lastName ?? ""}`.trim() || a.email)
          .toLowerCase();
      const bKey =
        (`${b.firstName ?? ""} ${b.lastName ?? ""}`.trim() || b.email)
          .toLowerCase();
      return aKey.localeCompare(bKey);
    });
  }, [users]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sortedUsers;
    return sortedUsers.filter((u) => {
      const hay =
        `${u.firstName ?? ""} ${u.lastName ?? ""} ${u.email}`.toLowerCase();
      return hay.includes(q);
    });
  }, [sortedUsers, search]);

  const handleSelect = (selection: AssigneeSelection) => {
    onSelect(selection);
    onClose();
  };

  // Present/dismiss follows the `visible` prop so callers keep their
  // existing boolean-state API; drag-to-dismiss syncs back via onDismiss.
  // Only call dismiss() while the modal is actually presented. gorhom's
  // dismiss() does not early-exit from MODAL_STATUS.INITIAL, so a redundant
  // dismiss on a non-presented modal (on mount, or in the echo after
  // onDismiss already ran and reset gorhom to INITIAL) wedges it in
  // DISMISSING and permanently blocks the next present(). Track "currently
  // presented" and clear it in onDismiss so the post-close effect echo skips.
  const sheetRef = useRef<BottomSheetModal>(null);
  const presentedRef = useRef(false);
  useEffect(() => {
    if (visible) {
      presentedRef.current = true;
      sheetRef.current?.present();
    } else if (presentedRef.current) {
      presentedRef.current = false;
      sheetRef.current?.dismiss();
    }
  }, [visible]);

  return (
    <BottomSheetModal
      ref={sheetRef}
      onDismiss={() => {
        presentedRef.current = false;
        onClose();
      }}
      enablePanDownToClose
      snapPoints={["75%"]}
      enableDynamicSizing={false}
      backgroundStyle={{
        backgroundColor: colors.background,
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
      }}
      handleIndicatorStyle={{
        backgroundColor: colors.mutedForeground,
        width: 36,
      }}
      backdropComponent={ClearBackdrop}
      keyboardBehavior="extend"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
    >
      <View style={{ flex: 1 }}>
        <View
          style={[
            styles.header,
            {
              paddingTop: 4,
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
            Assign to
          </Text>
          <View style={{ width: 50 }} />
        </View>

        {users.length > 4 ? (
          <View style={{ paddingHorizontal: 20, paddingTop: 14 }}>
            <Input
              value={search}
              onChangeText={setSearch}
              placeholder="Search teammates"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        ) : null}

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
        ) : (
          <BottomSheetScrollView
            contentContainerStyle={{
              padding: 20,
              paddingBottom: insets.bottom + 40,
              gap: 8,
            }}
            keyboardShouldPersistTaps="handled"
          >
            {/* Always-present "Unassigned" row at the top. */}
            <Pressable
              onPress={() => handleSelect(null)}
              style={({ pressed }) => [
                styles.row,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <View
                style={[
                  styles.avatar,
                  { backgroundColor: colors.muted },
                ]}
              >
                <Feather
                  name="user-x"
                  size={18}
                  color={colors.mutedForeground}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    color: colors.foreground,
                    fontFamily: "Inter_600SemiBold",
                    fontSize: 15,
                  }}
                >
                  Unassigned
                </Text>
                <Text
                  style={{
                    color: colors.mutedForeground,
                    fontFamily: "Inter_400Regular",
                    fontSize: 12,
                    marginTop: 2,
                  }}
                >
                  Nobody is assigned to this task
                </Text>
              </View>
              {!selectedUserId ? (
                <Feather name="check" size={18} color={colors.primary} />
              ) : null}
            </Pressable>

            {users.length === 0 ? (
              <View style={{ padding: 20, gap: 6 }}>
                <Text
                  style={{
                    color: colors.foreground,
                    fontFamily: "Inter_600SemiBold",
                    fontSize: 14,
                  }}
                >
                  No teammates available.
                </Text>
                <Text
                  style={{
                    color: colors.mutedForeground,
                    fontFamily: "Inter_400Regular",
                    fontSize: 13,
                  }}
                >
                  Invite someone to your account first.
                </Text>
              </View>
            ) : filtered.length === 0 ? (
              <View style={{ padding: 16 }}>
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
              filtered.map((u) => {
                const id = String(u.id);
                const fullName =
                  `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email;
                const initials =
                  `${(u.firstName ?? "")[0] ?? ""}${
                    (u.lastName ?? "")[0] ?? ""
                  }`.toUpperCase() ||
                  (u.email[0]?.toUpperCase() ?? "?");
                const isSelected = selectedUserId === id;
                // BackendProjectAssignment used `avatarUrl`; BackendUser
                // uses `profileImageUrl`. Same semantic — display picture.
                const avatarUrl = u.profileImageUrl;
                return (
                  <Pressable
                    key={id}
                    onPress={() =>
                      handleSelect({ userId: id, displayName: fullName })
                    }
                    style={({ pressed }) => [
                      styles.row,
                      {
                        backgroundColor: colors.card,
                        borderColor: isSelected
                          ? colors.primary
                          : colors.border,
                        opacity: pressed ? 0.85 : 1,
                      },
                    ]}
                  >
                    <View
                      style={[
                        styles.avatar,
                        { backgroundColor: colors.muted },
                      ]}
                    >
                      {avatarUrl ? (
                        <Image
                          source={{ uri: avatarUrl }}
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
                    </View>
                    <RoleBadge role={u.role} colors={colors} />
                    {isSelected ? (
                      <Feather
                        name="check"
                        size={18}
                        color={colors.primary}
                        style={{ marginLeft: 8 }}
                      />
                    ) : null}
                  </Pressable>
                );
              })
            )}
          </BottomSheetScrollView>
        )}
      </View>
    </BottomSheetModal>
  );
}

/**
 * Transparent-but-tappable backdrop — no dim over the screen behind,
 * tap outside still dismisses (matches the photo-viewer sheets).
 */
function ClearBackdrop(props: BottomSheetBackdropProps) {
  return (
    <BottomSheetBackdrop
      {...props}
      appearsOnIndex={0}
      disappearsOnIndex={-1}
      opacity={0}
      pressBehavior="close"
    />
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
