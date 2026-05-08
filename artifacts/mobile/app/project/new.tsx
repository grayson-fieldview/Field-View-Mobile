import { useRouter } from "expo-router";
import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { MapView, Marker } from "@/components/MapBackend";
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
  const [coords, setCoords] = useState<
    { latitude: number; longitude: number } | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = name.trim().length > 0;

  const onSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const p = await createProject({
        name,
        client,
        address,
        latitude: coords?.latitude,
        longitude: coords?.longitude,
      });
      router.back();
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
        <AddressAutocomplete
          value={address}
          onChangeText={(v) => {
            setAddress(v);
            if (coords) setCoords(null);
          }}
          onSelectPlace={(d) => {
            if (d.latitude != null && d.longitude != null) {
              setCoords({ latitude: d.latitude, longitude: d.longitude });
            }
          }}
        />
        {coords ? (
          <View
            style={[
              styles.mapContainer,
              { borderColor: colors.border },
            ]}
          >
            <MapView
              style={styles.map}
              region={{
                latitude: coords.latitude,
                longitude: coords.longitude,
                latitudeDelta: 0.005,
                longitudeDelta: 0.005,
              }}
              scrollEnabled={false}
              zoomEnabled={false}
              pitchEnabled={false}
              rotateEnabled={false}
            >
              <Marker
                coordinate={{
                  latitude: coords.latitude,
                  longitude: coords.longitude,
                }}
              />
            </MapView>
          </View>
        ) : null}
        {error ? (
          <Text style={{ color: colors.destructive, fontFamily: "Inter_500Medium" }}>
            {error}
          </Text>
        ) : null}
        <Button
          title="Create project"
          onPress={onSave}
          loading={saving}
          disabled={!canSave || saving}
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
  mapContainer: {
    height: 200,
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
    marginTop: -2,
  },
  map: {
    flex: 1,
  },
});
