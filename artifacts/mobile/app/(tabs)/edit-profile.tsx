import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FieldLabel } from "@/components/auth/FieldLabel";
import { authScreenStyles as shared } from "@/components/auth/authScreenStyles";
import { Button } from "@/components/Button";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { api } from "@/services/api";

/**
 * Edit Profile — first/last/phone via PATCH /api/auth/me
 * (api.updateMe), response applied with applyUpdatedUser. Hidden
 * (href: null) route in the (tabs) group, pushed from the Profile tab.
 *
 * Scaffolding + error-display pattern mirror the onboarding screens
 * (KeyboardAwareScrollViewCompat, shared input styles, inline error).
 *
 * Phone isn't carried on AuthUser (toAuthUser drops it), so it's
 * prefetched from GET /api/auth/user via the BackendUser index
 * signature. Until that fetch resolves the field starts empty; a
 * fetch failure just means no prefill — the user can still type.
 *
 * tcpaAccepted is OMITTED here on purpose: it's a consent record set
 * once during signup/onboarding. Re-sending it on unrelated profile
 * edits could overwrite the original consent timestamp server-side.
 */
export default function EditProfileScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, applyUpdatedUser } = useAuth();

  const [firstName, setFirstName] = useState(user?.firstName ?? "");
  const [lastName, setLastName] = useState(user?.lastName ?? "");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill phone from the server; AuthUser doesn't carry it.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const raw = await api.me();
        if (!alive || !raw) return;
        const serverPhone = raw["phone"];
        if (typeof serverPhone === "string" && serverPhone) {
          // Don't clobber anything the user already typed.
          setPhone((cur) => (cur === "" ? serverPhone : cur));
        }
      } catch {
        // Prefill is best-effort only.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const firstOk = firstName.trim().length > 0;
  const lastOk = lastName.trim().length > 0;
  // Same bounds as onboarding screen 1.
  const phoneOk = phone.trim().length >= 10 && phone.trim().length <= 20;
  const canSave = firstOk && lastOk && phoneOk && !saving;

  const onSave = async () => {
    setError(null);
    setSaving(true);
    try {
      const updated = await api.updateMe({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim(),
      });
      applyUpdatedUser(updated);
      router.back();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Couldn't save. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={[
        shared.page,
        {
          paddingTop: insets.top + 8,
          paddingBottom: insets.bottom + 100,
        },
      ]}
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
    >
      {/* Header: back chevron + title (tabs have headerShown: false). */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backBtn}
        >
          <Feather name="chevron-left" size={28} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>
          Edit Profile
        </Text>
        <View style={styles.backBtn} />
      </View>

      <FieldLabel style={{ marginTop: 16 }}>First Name</FieldLabel>
      <View
        style={[
          shared.input,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        <TextInput
          value={firstName}
          onChangeText={setFirstName}
          placeholder="First name"
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="words"
          autoComplete="given-name"
          style={[shared.inputText, { color: colors.foreground }]}
        />
      </View>

      <FieldLabel style={{ marginTop: 14 }}>Last Name</FieldLabel>
      <View
        style={[
          shared.input,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        <TextInput
          value={lastName}
          onChangeText={setLastName}
          placeholder="Last name"
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="words"
          autoComplete="family-name"
          style={[shared.inputText, { color: colors.foreground }]}
        />
      </View>

      <FieldLabel style={{ marginTop: 14 }}>Phone</FieldLabel>
      <View
        style={[
          shared.input,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        <TextInput
          value={phone}
          onChangeText={setPhone}
          placeholder="(555) 555-1234"
          placeholderTextColor={colors.mutedForeground}
          keyboardType="phone-pad"
          autoComplete="tel"
          style={[shared.inputText, { color: colors.foreground }]}
        />
      </View>

      {error ? (
        <Text style={[styles.error, { color: colors.destructive }]}>
          {error}
        </Text>
      ) : null}

      <View style={{ marginTop: 20 }}>
        <Button
          title={saving ? "Saving…" : "Save"}
          onPress={onSave}
          disabled={!canSave}
          loading={saving}
        />
      </View>
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: -8,
  },
  backBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
  },
  error: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    marginTop: 12,
    textAlign: "center",
  },
});
