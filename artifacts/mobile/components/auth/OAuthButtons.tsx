import * as AppleAuthentication from "expo-apple-authentication";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/useColors";
import { isAppleSignInAvailable } from "@/services/socialAuth";

import { GoogleGMark } from "./GoogleGMark";
import type { OAuthProvider } from "./useOAuthSignIn";

/**
 * The Apple + Google sign-in buttons shared by the auth screens.
 *
 * Owns `appleAvailable` and its availability effect: the Apple button
 * is correctly hidden where isAppleSignInAvailable() returns false
 * (simulators, web preview) and renders on real iOS devices.
 *
 * `anyInFlight` is supplied by the screen — each screen composes its
 * own (login includes its email/password `loading`). Do not derive it
 * here.
 */
export function OAuthButtons({
  appleButtonType,
  googleLabel,
  oauthLoading,
  anyInFlight,
  onPress,
}: {
  appleButtonType: AppleAuthentication.AppleAuthenticationButtonType;
  googleLabel: string;
  oauthLoading: OAuthProvider | null;
  anyInFlight: boolean;
  onPress: (provider: OAuthProvider) => void;
}) {
  const colors = useColors();
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => {
    let mounted = true;
    void isAppleSignInAvailable().then((ok) => {
      if (mounted) setAppleAvailable(ok);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <>
      {appleAvailable ? (
        oauthLoading === "apple" ? (
          // AppleAuthenticationButton has no loading state; while the
          // Apple flow is in flight we swap in a same-size black
          // placeholder with a spinner so the layout doesn't jump.
          <View style={[styles.oauthButton, styles.applePlaceholder]}>
            <ActivityIndicator color="#FFFFFF" />
          </View>
        ) : (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={appleButtonType}
            buttonStyle={
              AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
            }
            cornerRadius={10}
            style={[styles.oauthButton, anyInFlight && { opacity: 0.5 }]}
            onPress={() => {
              if (!anyInFlight) onPress("apple");
            }}
          />
        )
      ) : null}

      <Pressable
        onPress={() => onPress("google")}
        disabled={anyInFlight}
        accessibilityRole="button"
        accessibilityLabel={googleLabel}
        style={({ pressed }) => [
          styles.oauthButton,
          styles.googleButton,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            opacity: anyInFlight && oauthLoading !== "google" ? 0.5 : 1,
          },
          pressed && { opacity: 0.7 },
        ]}
      >
        {oauthLoading === "google" ? (
          <ActivityIndicator color={colors.foreground} />
        ) : (
          <>
            <GoogleGMark />
            <Text style={[styles.googleText, { color: colors.foreground }]}>
              {googleLabel}
            </Text>
          </>
        )}
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  oauthButton: {
    height: 48,
    borderRadius: 10,
    marginBottom: 10,
  },
  applePlaceholder: {
    backgroundColor: "#000000",
    alignItems: "center",
    justifyContent: "center",
  },
  googleButton: {
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    marginBottom: 0,
  },
  googleText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
});
