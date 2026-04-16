import { useRouter } from "expo-router";
import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { useData } from "@/contexts/DataContext";
import { useColors } from "@/hooks/useColors";

export default function NewProjectScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { createProject } = useData();

  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = name.trim().length > 0;

  const onSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const p = await createProject({ name, client, address });
      router.back();
      // Small delay so the dismiss animation completes before push
      setTimeout(() => router.push(`/project/${p.id}`), 200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={[
        styles.container,
        { paddingBottom: insets.bottom + 40 },
      ]}
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
        Project details
      </Text>

      <View style={styles.form}>
        <Input
          label="Name"
          placeholder="e.g. Riverside Apartments"
          value={name}
          onChangeText={setName}
          autoFocus
        />
        <Input
          label="Client"
          placeholder="Client or company"
          value={client}
          onChangeText={setClient}
        />
        <Input
          label="Address"
          placeholder="Job site address"
          value={address}
          onChangeText={setAddress}
        />
        {error ? (
          <Text style={{ color: colors.destructive, fontFamily: "Inter_500Medium" }}>
            {error}
          </Text>
        ) : null}
        <Button
          title="Create project"
          onPress={onSave}
          loading={saving}
          disabled={!canSave}
          size="lg"
        />
      </View>
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 18 },
  subtitle: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1.5,
    textTransform: "uppercase",
  },
  form: { gap: 14 },
});
