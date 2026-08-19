import { Feather } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Button } from "@/components/Button";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { api, ApiError, type BackendContact, type ContactType } from "@/services/api";
import { mapBackendProjectContact } from "@/services/mappers";
import type { ProjectContact } from "@/services/types";

const TYPE_LABELS: Record<ContactType, string> = {
  owner: "Owner",
  renter: "Renter",
  property_manager: "Property manager",
  gc: "GC",
  other: "Other",
};
const CONTACT_TYPES = Object.keys(TYPE_LABELS) as ContactType[];

function contactName(c: { firstName: string; lastName?: string | null }) {
  return `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "(no name)";
}

function errMessage(e: unknown, fallback: string) {
  if (e instanceof ApiError && e.message) return e.message;
  return fallback;
}

/**
 * Contacts section on the project screen (Team tab). Admin/manager
 * ONLY: for any other role this renders nothing and never fires the
 * contacts requests (the API is 403 for non-privileged roles — we
 * don't want a red error state for users who simply lack access).
 */
export function ProjectContactsSection({ projectId }: { projectId: string }) {
  const colors = useColors();
  const { user } = useAuth();
  const privileged = user?.role === "admin" || user?.role === "manager";

  const [contacts, setContacts] = useState<ProjectContact[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [typePickerFor, setTypePickerFor] = useState<ProjectContact | null>(
    null,
  );

  const reload = useCallback(async () => {
    try {
      const rows = await api.listProjectContacts(projectId);
      setContacts(
        rows
          .map(mapBackendProjectContact)
          .filter((c): c is ProjectContact => c !== null),
      );
      setLoadError(null);
    } catch (e) {
      setLoadError(errMessage(e, "Couldn't load contacts"));
    }
  }, [projectId]);

  useEffect(() => {
    // Role gate BEFORE the request — non-admin/manager never hits
    // the endpoint at all (requirement, and avoids guaranteed 403s).
    if (!privileged) return;
    void reload();
  }, [privileged, reload]);

  if (!privileged) return null;

  const detach = (c: ProjectContact) => {
    Alert.alert(
      "Remove contact",
      `Remove ${contactName(c)} from this project? The contact stays in your account.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            try {
              await api.detachContactFromProject(projectId, c.contactId);
              setContacts(
                (prev) =>
                  prev?.filter((x) => x.contactId !== c.contactId) ?? prev,
              );
            } catch (e) {
              Alert.alert(
                "Couldn't remove",
                errMessage(e, "Please try again."),
              );
            }
          },
        },
      ],
    );
  };

  const changeType = async (c: ProjectContact, type: ContactType) => {
    setTypePickerFor(null);
    if (type === c.contactType) return;
    const prevType = c.contactType;
    // Optimistic; server-first would flash — this is a single row PATCH
    // with rollback on failure.
    setContacts(
      (prev) =>
        prev?.map((x) =>
          x.contactId === c.contactId ? { ...x, contactType: type } : x,
        ) ?? prev,
    );
    try {
      await api.updateProjectContact(projectId, c.contactId, {
        contactType: type,
      });
    } catch (e) {
      setContacts(
        (prev) =>
          prev?.map((x) =>
            x.contactId === c.contactId
              ? { ...x, contactType: prevType }
              : x,
          ) ?? prev,
      );
      Alert.alert("Couldn't change type", errMessage(e, "Please try again."));
    }
  };

  return (
    <View style={{ gap: 10, marginTop: 18 }}>
      <Text
        style={{
          color: colors.mutedForeground,
          fontSize: 12,
          fontFamily: "Inter_500Medium",
          textTransform: "uppercase",
          letterSpacing: 1,
          marginBottom: 2,
        }}
      >
        Contacts{contacts ? ` (${contacts.length})` : ""}
      </Text>

      {loadError ? (
        <Text style={{ color: colors.destructive, fontSize: 13 }}>
          {loadError}
        </Text>
      ) : contacts === null ? (
        <ActivityIndicator size="small" color={colors.mutedForeground} />
      ) : contacts.length === 0 ? (
        <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>
          No contacts attached to this project yet.
        </Text>
      ) : (
        contacts.map((c) => (
          <View
            key={c.contactId}
            style={[
              styles.card,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <View style={styles.cardHeader}>
              <Text
                style={{
                  color: colors.foreground,
                  fontFamily: "Inter_600SemiBold",
                  fontSize: 14,
                  flex: 1,
                }}
                numberOfLines={1}
              >
                {contactName(c)}
              </Text>
              <Pressable
                onPress={() => setTypePickerFor(c)}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={`Change contact type, currently ${TYPE_LABELS[c.contactType]}`}
                style={[
                  styles.typePill,
                  { backgroundColor: colors.muted },
                ]}
              >
                <Text
                  style={{
                    color: colors.foreground,
                    fontSize: 11,
                    fontFamily: "Inter_500Medium",
                  }}
                >
                  {TYPE_LABELS[c.contactType]}
                </Text>
                <Feather
                  name="chevron-down"
                  size={12}
                  color={colors.mutedForeground}
                />
              </Pressable>
              <Pressable
                onPress={() => detach(c)}
                hitSlop={10}
                accessibilityLabel={`Remove ${contactName(c)} from project`}
              >
                <Feather name="x" size={18} color={colors.mutedForeground} />
              </Pressable>
            </View>
            {c.phone ? (
              <Pressable
                onPress={() => void Linking.openURL(`tel:${c.phone}`)}
                hitSlop={4}
                accessibilityRole="button"
                accessibilityLabel={`Call ${c.phone}`}
                style={styles.contactLine}
              >
                <Feather name="phone" size={13} color={colors.primary} />
                <Text style={{ color: colors.primary, fontSize: 13 }}>
                  {c.phone}
                </Text>
              </Pressable>
            ) : null}
            {c.email ? (
              <Pressable
                onPress={() => void Linking.openURL(`mailto:${c.email}`)}
                hitSlop={4}
                accessibilityRole="button"
                accessibilityLabel={`Email ${c.email}`}
                style={styles.contactLine}
              >
                <Feather name="mail" size={13} color={colors.primary} />
                <Text
                  style={{ color: colors.primary, fontSize: 13 }}
                  numberOfLines={1}
                >
                  {c.email}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ))
      )}

      <Button
        title="Add contact"
        variant="secondary"
        icon={<Feather name="user-plus" size={14} color={colors.foreground} />}
        onPress={() => setShowAdd(true)}
      />

      {/* Type picker for an attached row */}
      <Modal
        visible={typePickerFor !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setTypePickerFor(null)}
      >
        <Pressable
          style={styles.backdrop}
          onPress={() => setTypePickerFor(null)}
        >
          <Pressable
            style={[
              styles.pickerSheet,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
            onPress={() => {}}
          >
            {CONTACT_TYPES.map((t) => (
              <Pressable
                key={t}
                onPress={() =>
                  typePickerFor ? void changeType(typePickerFor, t) : null
                }
                style={styles.pickerRow}
              >
                <Text
                  style={{
                    color:
                      typePickerFor?.contactType === t
                        ? colors.primary
                        : colors.foreground,
                    fontFamily:
                      typePickerFor?.contactType === t
                        ? "Inter_600SemiBold"
                        : "Inter_400Regular",
                    fontSize: 14,
                  }}
                >
                  {TYPE_LABELS[t]}
                </Text>
                {typePickerFor?.contactType === t ? (
                  <Feather name="check" size={16} color={colors.primary} />
                ) : null}
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      <AddContactSheet
        visible={showAdd}
        projectId={projectId}
        attachedIds={new Set((contacts ?? []).map((c) => c.contactId))}
        onClose={() => setShowAdd(false)}
        onAttached={() => {
          setShowAdd(false);
          void reload();
        }}
      />
    </View>
  );
}

/**
 * Add-contact sheet: searches the account's existing contacts and
 * falls back to creating one inline. Attaching requires picking a
 * contact type (defaults to "owner").
 */
function AddContactSheet({
  visible,
  projectId,
  attachedIds,
  onClose,
  onAttached,
}: {
  visible: boolean;
  projectId: string;
  attachedIds: Set<string>;
  onClose: () => void;
  onAttached: () => void;
}) {
  const colors = useColors();
  const [all, setAll] = useState<BackendContact[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<BackendContact | null>(null);
  const [creating, setCreating] = useState(false);
  const [type, setType] = useState<ContactType>("owner");
  const [busy, setBusy] = useState(false);

  // Inline-create fields
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!visible) {
      // Reset per open so a reopened sheet starts clean.
      setQuery("");
      setSelected(null);
      setCreating(false);
      setType("owner");
      setBusy(false);
      setFirstName("");
      setLastName("");
      setEmail("");
      setPhone("");
      setAddress("");
      setNotes("");
      return;
    }
    setAll(null);
    setLoadError(null);
    api
      .listContacts()
      .then(setAll)
      .catch((e) => setLoadError(errMessage(e, "Couldn't load contacts")));
  }, [visible]);

  const filtered = useMemo(() => {
    if (!all) return [];
    const q = query.trim().toLowerCase();
    const pool = all.filter((c) => !attachedIds.has(String(c.id)));
    if (!q) return pool;
    return pool.filter((c) =>
      [c.firstName, c.lastName, c.email, c.phone]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [all, query, attachedIds]);

  const attach = async (contactId: number) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.attachContactToProject(projectId, {
        contactId,
        contactType: type,
      });
      onAttached();
    } catch (e) {
      Alert.alert("Couldn't attach", errMessage(e, "Please try again."));
      setBusy(false);
    }
  };

  const createAndAttach = async () => {
    if (busy) return;
    const fn = firstName.trim();
    if (!fn) {
      Alert.alert("First name required");
      return;
    }
    setBusy(true);
    let created: BackendContact;
    try {
      created = await api.createContact({
        firstName: fn,
        lastName: lastName.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        address: address.trim() || undefined,
        notes: notes.trim() || undefined,
      });
    } catch (e) {
      Alert.alert("Couldn't create contact", errMessage(e, "Please try again."));
      setBusy(false);
      return;
    }
    const cid = Number(created.id);
    if (!Number.isFinite(cid)) {
      // Contact exists but we can't attach without a numeric id —
      // surface loudly instead of silently succeeding halfway.
      Alert.alert(
        "Contact created",
        "But it couldn't be attached automatically — add it from the search list.",
      );
      setBusy(false);
      setCreating(false);
      setAll(null);
      api
        .listContacts()
        .then(setAll)
        .catch((e) => setLoadError(errMessage(e, "Couldn't load contacts")));
      return;
    }
    try {
      await api.attachContactToProject(projectId, {
        contactId: cid,
        contactType: type,
      });
      onAttached();
    } catch (e) {
      Alert.alert("Couldn't attach", errMessage(e, "Please try again."));
      setBusy(false);
    }
  };

  const typeChooser = (
    <View style={styles.typeRow}>
      {CONTACT_TYPES.map((t) => (
        <Pressable
          key={t}
          onPress={() => setType(t)}
          style={[
            styles.typeChip,
            {
              backgroundColor: type === t ? colors.primary : colors.muted,
            },
          ]}
        >
          <Text
            style={{
              color: type === t ? colors.primaryForeground : colors.foreground,
              fontSize: 12,
              fontFamily: "Inter_500Medium",
            }}
          >
            {TYPE_LABELS[t]}
          </Text>
        </Pressable>
      ))}
    </View>
  );

  const inputStyle = [
    styles.input,
    {
      backgroundColor: colors.muted,
      color: colors.foreground,
      borderColor: colors.border,
    },
  ];

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
    >
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <View style={styles.sheetHeader}>
          <Text
            style={{
              color: colors.foreground,
              fontFamily: "Inter_700Bold",
              fontSize: 17,
              flex: 1,
            }}
          >
            {creating ? "New contact" : "Add contact"}
          </Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close">
            <Feather name="x" size={22} color={colors.mutedForeground} />
          </Pressable>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, gap: 12 }}
          keyboardShouldPersistTaps="handled"
        >
          {creating ? (
            <>
              <TextInput
                style={inputStyle}
                placeholder="First name (required)"
                placeholderTextColor={colors.mutedForeground}
                value={firstName}
                onChangeText={setFirstName}
              />
              <TextInput
                style={inputStyle}
                placeholder="Last name"
                placeholderTextColor={colors.mutedForeground}
                value={lastName}
                onChangeText={setLastName}
              />
              <TextInput
                style={inputStyle}
                placeholder="Email"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="none"
                keyboardType="email-address"
                value={email}
                onChangeText={setEmail}
              />
              <TextInput
                style={inputStyle}
                placeholder="Phone"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="phone-pad"
                value={phone}
                onChangeText={setPhone}
              />
              <TextInput
                style={inputStyle}
                placeholder="Address"
                placeholderTextColor={colors.mutedForeground}
                value={address}
                onChangeText={setAddress}
              />
              <TextInput
                style={[...inputStyle, { minHeight: 70 }]}
                placeholder="Notes"
                placeholderTextColor={colors.mutedForeground}
                multiline
                value={notes}
                onChangeText={setNotes}
              />
              <Text style={styles.typeLabel(colors.mutedForeground)}>
                Contact type on this project
              </Text>
              {typeChooser}
              <Button
                title={busy ? "Saving…" : "Create & attach"}
                onPress={() => void createAndAttach()}
                disabled={busy || !firstName.trim()}
              />
              <Button
                title="Back to search"
                variant="secondary"
                onPress={() => setCreating(false)}
                disabled={busy}
              />
            </>
          ) : (
            <>
              <TextInput
                style={inputStyle}
                placeholder="Search contacts…"
                placeholderTextColor={colors.mutedForeground}
                value={query}
                onChangeText={(t) => {
                  setQuery(t);
                  setSelected(null);
                }}
                autoCapitalize="none"
              />
              {loadError ? (
                <Text style={{ color: colors.destructive, fontSize: 13 }}>
                  {loadError}
                </Text>
              ) : all === null ? (
                <ActivityIndicator
                  size="small"
                  color={colors.mutedForeground}
                />
              ) : filtered.length === 0 ? (
                <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>
                  {query.trim()
                    ? "No matching contacts."
                    : "No contacts in your account yet."}
                </Text>
              ) : (
                filtered.map((c) => {
                  const isSel = selected?.id === c.id;
                  return (
                    <View key={String(c.id)}>
                      <Pressable
                        onPress={() => setSelected(isSel ? null : c)}
                        style={[
                          styles.card,
                          {
                            backgroundColor: colors.card,
                            borderColor: isSel
                              ? colors.primary
                              : colors.border,
                          },
                        ]}
                      >
                        <Text
                          style={{
                            color: colors.foreground,
                            fontFamily: "Inter_600SemiBold",
                            fontSize: 14,
                          }}
                          numberOfLines={1}
                        >
                          {contactName(c)}
                        </Text>
                        {c.email || c.phone ? (
                          <Text
                            style={{
                              color: colors.mutedForeground,
                              fontSize: 12,
                            }}
                            numberOfLines={1}
                          >
                            {[c.phone, c.email].filter(Boolean).join(" · ")}
                          </Text>
                        ) : null}
                      </Pressable>
                      {isSel ? (
                        <View style={{ gap: 10, paddingTop: 10 }}>
                          <Text
                            style={styles.typeLabel(colors.mutedForeground)}
                          >
                            Contact type on this project
                          </Text>
                          {typeChooser}
                          <Button
                            title={busy ? "Attaching…" : "Attach to project"}
                            onPress={() => {
                              const cid = Number(c.id);
                              if (Number.isFinite(cid)) void attach(cid);
                            }}
                            disabled={busy}
                          />
                        </View>
                      ) : null}
                    </View>
                  );
                })
              )}
              <Button
                title="Create new contact"
                variant="secondary"
                icon={
                  <Feather name="plus" size={14} color={colors.foreground} />
                }
                onPress={() => setCreating(true)}
              />
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = {
  ...StyleSheet.create({
    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 14,
      padding: 12,
      gap: 6,
    },
    cardHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    typePill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 999,
    },
    contactLine: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.4)",
      justifyContent: "center",
      padding: 32,
    },
    pickerSheet: {
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      paddingVertical: 4,
    },
    pickerRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    typeRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },
    typeChip: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 999,
    },
    sheetHeader: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingTop: 18,
      paddingBottom: 8,
      gap: 12,
    },
    input: {
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
    },
  }),
  typeLabel: (color: string) =>
    ({
      color,
      fontSize: 12,
      fontFamily: "Inter_500Medium",
      textTransform: "uppercase",
      letterSpacing: 1,
    }) as const,
};
