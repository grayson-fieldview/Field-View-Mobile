import { Feather } from "@expo/vector-icons";
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
import { Input } from "@/components/Input";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useToast } from "@/contexts/ToastContext";
import { useColors } from "@/hooks/useColors";
import { ApiError, api, type UserRole } from "@/services/api";
import type { Project } from "@/services/types";

const ROLE_OPTIONS: { value: UserRole; label: string; description: string }[] = [
  { value: "admin", label: "Admin", description: "Full access; can invite teammates" },
  { value: "manager", label: "Manager", description: "Manage projects and members" },
  { value: "standard", label: "Standard", description: "Access all projects" },
  { value: "restricted", label: "Restricted", description: "Only assigned projects" },
];

interface Props {
  visible: boolean;
  onClose: () => void;
  /** All projects in the account, for the restricted-role picker. */
  projects: Project[];
  /** Project the modal was launched from — pre-checked in the picker. */
  currentProjectId: string;
  /** Called after a successful invite so the parent can refresh assignments. */
  onSuccess: () => void;
}

/**
 * Admin-only modal for inviting a teammate. Submits to POST /api/invitations
 * which (a) creates a pending invitation row, (b) emails the recipient, and
 * (c) when role === "restricted" attaches assignedProjectIds[] so the future
 * user is project-scoped on accept.
 *
 * The trigger button + this modal are gated upstream on
 * `useAuth().user?.role === "admin"`. We do NOT re-check role here — by
 * contract this component never mounts for non-admins.
 */
export function AddTeamMemberModal({
  visible,
  onClose,
  projects,
  currentProjectId,
  onSuccess,
}: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { showToast } = useToast();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("standard");
  // Pre-check the launching project ONLY if it's assignable (numeric, real
  // backend ID). Local-draft projects have non-numeric IDs and the server
  // would 400 on them, so we don't seed the picker with them.
  const isAssignableId = (pid: string) => Number.isFinite(Number(pid));
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(
    () => (isAssignableId(currentProjectId) ? new Set([currentProjectId]) : new Set()),
  );
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{
    firstName?: string;
    lastName?: string;
    email?: string;
  }>({});

  // Reset form whenever the modal re-opens. Pre-check the current project
  // in the restricted picker (most-common case: "give this restricted user
  // access to the project I'm currently looking at").
  useEffect(() => {
    if (!visible) return;
    setFirstName("");
    setLastName("");
    setEmail("");
    setRole("standard");
    setSelectedProjectIds(
      isAssignableId(currentProjectId) ? new Set([currentProjectId]) : new Set(),
    );
    setSaving(false);
    setFieldErrors({});
  }, [visible, currentProjectId]);

  // Only "real" backend projects can be assigned — local-draft IDs aren't
  // numeric and the server would 400 on them. Filter the picker source
  // upfront so the user can't pick something that will fail submission.
  const assignableProjects = useMemo(
    () =>
      projects.filter((p) => Number.isFinite(Number(p.id))),
    [projects],
  );

  const trimmedFirst = firstName.trim();
  const trimmedLast = lastName.trim();
  const trimmedEmail = email.trim();
  const emailValid = /^\S+@\S+\.\S+$/.test(trimmedEmail);

  // Numeric IDs only — matches the server contract and what we'd actually
  // send. A user with only local-draft projects selected (impossible via
  // the picker, but defensive) shouldn't be able to submit.
  const validSelectedIds = useMemo(
    () =>
      Array.from(selectedProjectIds)
        .map((id) => Number(id))
        .filter((n) => Number.isFinite(n)),
    [selectedProjectIds],
  );

  const submitDisabled =
    saving ||
    !trimmedFirst ||
    !trimmedLast ||
    !emailValid ||
    (role === "restricted" && validSelectedIds.length === 0);

  const toggleProject = (id: string) => {
    setSelectedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    const errs: typeof fieldErrors = {};
    if (!trimmedFirst) errs.firstName = "Required";
    if (!trimmedLast) errs.lastName = "Required";
    if (!trimmedEmail) errs.email = "Required";
    else if (!emailValid) errs.email = "Enter a valid email address.";
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    setSaving(true);
    try {
      const payload: Parameters<typeof api.createInvitation>[0] = {
        email: trimmedEmail.toLowerCase(),
        firstName: trimmedFirst,
        lastName: trimmedLast,
        role,
      };
      // Server contract: only send assignedProjectIds when role is
      // "restricted". For other roles the field is rejected (400).
      if (role === "restricted") {
        payload.assignedProjectIds = validSelectedIds;
      }
      await api.createInvitation(payload);
      showToast(`Invite sent to ${payload.email}`);
      onSuccess();
      onClose();
    } catch (e) {
      handleInviteError(e, {
        showToast,
        setFieldErrors: (next) => setFieldErrors((prev) => ({ ...prev, ...next })),
      });
    } finally {
      setSaving(false);
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
            Add team member
          </Text>
          <View style={{ width: 50 }} />
        </View>

        <KeyboardAwareScrollViewCompat
          contentContainerStyle={{
            padding: 20,
            gap: 14,
            paddingBottom: insets.bottom + 40,
          }}
          bottomOffset={24}
          keyboardShouldPersistTaps="handled"
        >
          <Input
            label="First name"
            value={firstName}
            onChangeText={setFirstName}
            autoCapitalize="words"
            autoFocus
            error={fieldErrors.firstName}
          />
          <Input
            label="Last name"
            value={lastName}
            onChangeText={setLastName}
            autoCapitalize="words"
            error={fieldErrors.lastName}
          />
          <Input
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            error={fieldErrors.email}
          />

          <View style={{ gap: 6 }}>
            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>
              Role
            </Text>
            <View style={{ gap: 8 }}>
              {ROLE_OPTIONS.map((opt) => {
                const active = role === opt.value;
                return (
                  <Pressable
                    key={opt.value}
                    onPress={() => setRole(opt.value)}
                    style={[
                      styles.roleRow,
                      {
                        backgroundColor: colors.card,
                        borderColor: active ? colors.primary : colors.border,
                      },
                    ]}
                  >
                    <View
                      style={[
                        styles.radio,
                        {
                          borderColor: active ? colors.primary : colors.border,
                        },
                      ]}
                    >
                      {active ? (
                        <View
                          style={[
                            styles.radioDot,
                            { backgroundColor: colors.primary },
                          ]}
                        />
                      ) : null}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text
                        style={{
                          color: colors.foreground,
                          fontFamily: "Inter_600SemiBold",
                          fontSize: 15,
                        }}
                      >
                        {opt.label}
                      </Text>
                      <Text
                        style={{
                          color: colors.mutedForeground,
                          fontFamily: "Inter_400Regular",
                          fontSize: 12,
                          marginTop: 2,
                        }}
                      >
                        {opt.description}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {role === "restricted" ? (
            <View style={{ gap: 6 }}>
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>
                Projects they can access
              </Text>
              <View
                style={[
                  styles.projectList,
                  {
                    backgroundColor: colors.card,
                    borderColor: colors.border,
                  },
                ]}
              >
                {assignableProjects.length === 0 ? (
                  <Text
                    style={{
                      color: colors.mutedForeground,
                      fontFamily: "Inter_400Regular",
                      fontSize: 13,
                      padding: 14,
                    }}
                  >
                    No projects yet — create one before inviting a restricted
                    teammate.
                  </Text>
                ) : (
                  <ScrollView
                    style={{ maxHeight: 240 }}
                    nestedScrollEnabled
                    keyboardShouldPersistTaps="handled"
                  >
                    {assignableProjects.map((p) => {
                      const checked = selectedProjectIds.has(p.id);
                      return (
                        <Pressable
                          key={p.id}
                          onPress={() => toggleProject(p.id)}
                          style={[
                            styles.projectRow,
                            { borderBottomColor: colors.border },
                          ]}
                        >
                          <View
                            style={[
                              styles.checkbox,
                              {
                                borderColor: checked
                                  ? colors.primary
                                  : colors.border,
                                backgroundColor: checked
                                  ? colors.primary
                                  : "transparent",
                              },
                            ]}
                          >
                            {checked ? (
                              <Feather
                                name="check"
                                size={12}
                                color={colors.primaryForeground}
                              />
                            ) : null}
                          </View>
                          <Text
                            style={{
                              color: colors.foreground,
                              fontFamily: "Inter_500Medium",
                              fontSize: 14,
                              flex: 1,
                            }}
                            numberOfLines={1}
                          >
                            {p.name}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                )}
              </View>
              <Text
                style={{
                  color: colors.mutedForeground,
                  fontFamily: "Inter_400Regular",
                  fontSize: 12,
                }}
              >
                Restricted teammates only see the projects you check here.
              </Text>
            </View>
          ) : null}

          <Button
            title="Send invite"
            onPress={submit}
            loading={saving}
            disabled={submitDisabled}
            size="lg"
          />
        </KeyboardAwareScrollViewCompat>
      </View>
    </Modal>
  );
}

/**
 * Map known server invite errors to user-friendly toasts / inline errors
 * per the spec. Unrecognised errors fall through to a generic toast so
 * the user always gets feedback.
 */
function handleInviteError(
  e: unknown,
  ctx: {
    showToast: (msg: string) => void;
    setFieldErrors: (next: {
      firstName?: string;
      lastName?: string;
      email?: string;
    }) => void;
  },
): void {
  if (!(e instanceof ApiError)) {
    ctx.showToast(
      e instanceof Error ? e.message : "Couldn't send the invite. Try again.",
    );
    return;
  }

  const msg = (e.message ?? "").toLowerCase();

  if (e.status === 409) {
    if (msg.includes("trial_cap_reached") || msg.includes("trial cap")) {
      ctx.showToast("Trial is at the user limit");
      return;
    }
    if (msg.includes("no_seats_available") || msg.includes("no seats")) {
      ctx.showToast("No seats available — add more seats in Settings");
      return;
    }
    if (msg.includes("already been sent") || msg.includes("duplicate")) {
      ctx.setFieldErrors({ email: "An invite has already been sent to this email" });
      return;
    }
    ctx.showToast(e.message);
    return;
  }

  if (e.status === 403) {
    ctx.showToast("Only admins can invite admins or managers");
    return;
  }

  if (e.status === 400) {
    // Best-effort field mapping from the validation error body.
    const fieldErrs: { firstName?: string; lastName?: string; email?: string } = {};
    if (msg.includes("email")) fieldErrs.email = e.message;
    if (msg.includes("firstname") || msg.includes("first name"))
      fieldErrs.firstName = e.message;
    if (msg.includes("lastname") || msg.includes("last name"))
      fieldErrs.lastName = e.message;
    if (Object.keys(fieldErrs).length > 0) {
      ctx.setFieldErrors(fieldErrs);
      return;
    }
    ctx.showToast(e.message);
    return;
  }

  ctx.showToast(e.message || "Couldn't send the invite. Try again.");
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
  fieldLabel: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    letterSpacing: 0.2,
    textTransform: "uppercase",
  },
  roleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  projectList: {
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
  },
  projectRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
});
