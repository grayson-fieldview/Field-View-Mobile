import { Feather } from "@expo/vector-icons";
import Constants from "expo-constants";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { Input } from "@/components/Input";
import { useColors } from "@/hooks/useColors";

const PLACES_API_KEY =
  (process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY as string | undefined) ?? "";

// Places API (New) does not auto-infer the calling app's bundle id
// the way the legacy SDK did. iOS- / Android-restricted keys 403 with
// API_KEY_IOS_APP_BLOCKED unless we explicitly send the bundle id /
// package as a header on every request. Fall back to the production
// bundle id if the runtime config is missing (e.g. some dev clients).
const FALLBACK_IOS_BUNDLE_ID = "com.fieldview.app";
const FALLBACK_ANDROID_PACKAGE = "com.fieldview.mobile";
function placesAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Goog-Api-Key": PLACES_API_KEY,
  };
  if (Platform.OS === "ios") {
    headers["X-Ios-Bundle-Identifier"] =
      Constants.expoConfig?.ios?.bundleIdentifier ?? FALLBACK_IOS_BUNDLE_ID;
  } else if (Platform.OS === "android") {
    headers["X-Android-Package"] =
      Constants.expoConfig?.android?.package ?? FALLBACK_ANDROID_PACKAGE;
  }
  return headers;
}

interface PlacePrediction {
  placeId: string;
  text: string;
  secondary?: string;
}

interface PlaceDetails {
  address: string;
  latitude?: number;
  longitude?: number;
}

export function AddressAutocomplete({
  value,
  onChangeText,
  onSelectPlace,
}: {
  value: string;
  onChangeText: (v: string) => void;
  /** Called when user taps a suggestion; gives full address + coords. */
  onSelectPlace?: (details: PlaceDetails) => void;
}) {
  const colors = useColors();
  const [predictions, setPredictions] = useState<PlacePrediction[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const sessionToken = useRef<string>(generateToken());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!PLACES_API_KEY) return;
    if (!value || value.length < 3) {
      setPredictions([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          "https://places.googleapis.com/v1/places:autocomplete",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...placesAuthHeaders(),
            },
            body: JSON.stringify({
              input: value,
              sessionToken: sessionToken.current,
            }),
          },
        );
        if (!res.ok) {
          setPredictions([]);
          return;
        }
        const data = (await res.json()) as {
          suggestions?: Array<{
            placePrediction?: {
              placeId: string;
              structuredFormat?: {
                mainText?: { text?: string };
                secondaryText?: { text?: string };
              };
              text?: { text?: string };
            };
          }>;
        };
        const next: PlacePrediction[] = (data.suggestions ?? [])
          .filter((s) => !!s.placePrediction)
          .map((s) => {
            const pp = s.placePrediction!;
            return {
              placeId: pp.placeId,
              text: pp.structuredFormat?.mainText?.text ?? pp.text?.text ?? "",
              secondary: pp.structuredFormat?.secondaryText?.text,
            };
          });
        setPredictions(next);
      } catch {
        setPredictions([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value]);

  const choose = async (p: PlacePrediction) => {
    setOpen(false);
    if (!PLACES_API_KEY) return;
    try {
      const res = await fetch(
        `https://places.googleapis.com/v1/places/${encodeURIComponent(
          p.placeId,
        )}?sessionToken=${sessionToken.current}`,
        {
          headers: {
            ...placesAuthHeaders(),
            "X-Goog-FieldMask": "formattedAddress,location",
          },
        },
      );
      sessionToken.current = generateToken();
      if (!res.ok) {
        const fallback = [p.text, p.secondary].filter(Boolean).join(", ");
        onChangeText(fallback);
        onSelectPlace?.({ address: fallback });
        return;
      }
      const data = (await res.json()) as {
        formattedAddress?: string;
        location?: { latitude?: number; longitude?: number };
      };
      const addr =
        data.formattedAddress ??
        [p.text, p.secondary].filter(Boolean).join(", ");
      onChangeText(addr);
      onSelectPlace?.({
        address: addr,
        latitude: data.location?.latitude,
        longitude: data.location?.longitude,
      });
    } catch {
      const fallback = [p.text, p.secondary].filter(Boolean).join(", ");
      onChangeText(fallback);
      onSelectPlace?.({ address: fallback });
    }
  };

  return (
    <View style={{ position: "relative" }}>
      <Input
        label="Address"
        placeholder="Job site address"
        value={value}
        onChangeText={(v) => {
          onChangeText(v);
          setOpen(true);
        }}
        autoCorrect={false}
      />
      {!PLACES_API_KEY ? (
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>
          Tip: add a Google Places API key to enable address suggestions.
        </Text>
      ) : null}
      {open && PLACES_API_KEY && (predictions.length > 0 || loading) ? (
        <View
          style={[
            styles.dropdown,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
            },
          ]}
        >
          {loading && predictions.length === 0 ? (
            <View style={styles.row}>
              <ActivityIndicator size="small" color={colors.mutedForeground} />
              <Text
                style={{
                  color: colors.mutedForeground,
                  fontFamily: "Inter_500Medium",
                  fontSize: 13,
                }}
              >
                Searching…
              </Text>
            </View>
          ) : null}
          {predictions.map((p) => (
            <Pressable
              key={p.placeId}
              onPress={() => choose(p)}
              style={({ pressed }) => [
                styles.row,
                {
                  backgroundColor: pressed ? colors.muted : "transparent",
                  borderTopColor: colors.border,
                },
              ]}
            >
              <Feather
                name="map-pin"
                size={14}
                color={colors.mutedForeground}
                style={{ marginTop: 2 }}
              />
              <View style={{ flex: 1 }}>
                <Text
                  style={[styles.main, { color: colors.foreground }]}
                  numberOfLines={1}
                >
                  {p.text}
                </Text>
                {p.secondary ? (
                  <Text
                    style={[styles.sub, { color: colors.mutedForeground }]}
                    numberOfLines={1}
                  >
                    {p.secondary}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function generateToken(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const styles = StyleSheet.create({
  hint: {
    marginTop: 4,
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  dropdown: {
    marginTop: 6,
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  main: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  sub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
});
