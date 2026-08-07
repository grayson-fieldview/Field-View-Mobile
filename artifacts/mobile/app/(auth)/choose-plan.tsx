import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BrandHeader } from "@/components/auth/BrandHeader";
import {
  authScreenStyles as shared,
  BRAND_ORANGE,
} from "@/components/auth/authScreenStyles";
import { Button } from "@/components/Button";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { api, normalizeUser } from "@/services/api";
import {
  ALL_SEAT_PRODUCT_IDS,
  describeApplePurchaseError,
  markPlanSkippedThisSession,
  MIN_SEATS,
  restoreApplePurchases,
  seatProductId,
} from "@/services/appleIap";
import {
  describeGooglePurchaseError,
  selectGooglePlayOfferToken,
} from "@/services/googlePlay";

/**
 * Paywall — mirrors web /choose-plan. Prices come from StoreKit
 * (fetchProducts) and are NEVER hardcoded: Apple requires displaying
 * App Store pricing, which varies by storefront/currency.
 *
 * Purchase completion is handled by the app-wide
 * purchaseUpdatedListener in AuthContext (submit JWS → server 200 →
 * finishTransaction → applyUpdatedUser) — this screen only initiates
 * the flow and shows local pending state. Restore lives HERE (not
 * only Settings) because a lapsed-but-entitled user gated on this
 * screen can't reach Settings; Apple requires restore be reachable.
 *
 * No back chevron and no manual navigation: routing is AuthGate's job
 * (gate 4). "Skip this step" sets a per-session module flag.
 */
export default function ChoosePlanScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { applyUpdatedUser, refreshUser } = useAuth();

  // productId → localized display price, from StoreKit / Play.
  const [prices, setPrices] = useState<Record<string, string> | null>(null);
  // Android only: productId → offerToken selected at load time
  // (Google requires the token with requestPurchase; iOS ignores it).
  const [offerTokens, setOfferTokens] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [seats, setSeats] = useState(MIN_SEATS);
  const [purchasing, setPurchasing] = useState(false);
  const [restoring, setRestoring] = useState(false);

  // Highest consecutive seat count StoreKit actually returned —
  // unknown SKUs are silently omitted by fetchProducts, so the
  // stepper max is data-driven, not the constant.
  const availableSeatCounts = prices
    ? ALL_SEAT_PRODUCT_IDS.filter((id) => prices[id] != null).map((id) =>
        Number(id.slice(id.lastIndexOf(".") + 1)),
      )
    : [];
  const maxAvailable =
    availableSeatCounts.length > 0
      ? Math.max(...availableSeatCounts)
      : MIN_SEATS;

  const loadProducts = async () => {
    setLoadError(null);
    setPrices(null);
    try {
      const iap = await import("expo-iap");
      const products = await iap.fetchProducts({
        skus: ALL_SEAT_PRODUCT_IDS,
        type: "subs",
      });
      // `displayPrice` is flat on BOTH platforms in expo-iap 5 —
      // Android's raw subscriptionOfferDetails is normalized into
      // `subscriptionOffers` (see selection below), with the base-plan
      // price surfaced as the product-level displayPrice.
      const map: Record<string, string> = {};
      const tokens: Record<string, string> = {};
      for (const p of products ?? []) {
        map[p.id] = p.displayPrice;
        if (p.platform === "android") {
          // TEMP DIAGNOSTIC 2026-08-07 — remove once the offer shape
          // is confirmed on an Android device (offerToken selection
          // rule is provisional until then).
          console.log(
            `[choose-plan] ${p.id} subscriptionOffers:`,
            JSON.stringify(p.subscriptionOffers, null, 2),
          );
          const token = selectGooglePlayOfferToken(p.subscriptionOffers);
          if (token) tokens[p.id] = token;
        }
      }
      if (Object.keys(map).length === 0) {
        setLoadError(
          Platform.OS === "android"
            ? "Plans aren't available from Google Play right now. Try again in a moment."
            : "Plans aren't available from the App Store right now. Try again in a moment.",
        );
        return;
      }
      setOfferTokens(tokens);
      setPrices(map);
    } catch (e) {
      setLoadError(
        e instanceof Error && e.message
          ? e.message
          : "Couldn't load plans from the App Store.",
      );
    }
  };

  useEffect(() => {
    void loadProducts();
  }, []);

  const selectedProductId = seatProductId(seats);
  const selectedPrice = prices?.[selectedProductId] ?? null;

  const handleContinue = async () => {
    if (purchasing || !selectedPrice) return;
    setPurchasing(true);
    try {
      const iap = await import("expo-iap");
      // Result arrives via AuthContext's purchaseUpdatedListener /
      // purchaseErrorListener — the return value is only the dispatch.
      if (Platform.OS === "android") {
        // Google requires the offerToken captured at fetchProducts
        // time; without one the purchase dialog can't be shown.
        const offerToken = offerTokens[selectedProductId];
        if (!offerToken) {
          Alert.alert(
            "Purchase failed",
            "This plan's offer couldn't be loaded from Google Play. Pull to retry loading plans and try again.",
          );
          return;
        }
        await iap.requestPurchase({
          request: {
            google: {
              skus: [selectedProductId],
              subscriptionOffers: [{ sku: selectedProductId, offerToken }],
            },
          },
          type: "subs",
        });
      } else {
        await iap.requestPurchase({
          request: { apple: { sku: selectedProductId } },
          type: "subs",
        });
      }
    } catch (e) {
      // Synchronous store rejection (sheet never showed).
      Alert.alert(
        "Purchase failed",
        Platform.OS === "android"
          ? describeGooglePurchaseError(e)
          : describeApplePurchaseError(e),
      );
    } finally {
      // The App Store sheet has been handed control (or failed); the
      // app-wide listener owns everything after this point.
      setPurchasing(false);
    }
  };

  const handleRestore = async () => {
    if (restoring) return;
    setRestoring(true);
    try {
      // Shared with Settings → About → Restore Purchases; the helper
      // owns all three feedback alerts (restored / nothing / error).
      await restoreApplePurchases(applyUpdatedUser);
    } finally {
      setRestoring(false);
    }
  };

  const handleSkip = () => {
    // Per-session flag FIRST — immediate effect, so routing never
    // races the network call below.
    markPlanSkippedThisSession();
    void (async () => {
      try {
        // Persist the skip server-side (set-once). The response is the
        // full serialized user with accountPaywallSkippedAt stamped —
        // applying it re-runs AuthGate, which falls through to tabs.
        const updated = await api.skipPaywall();
        const me = normalizeUser(updated);
        if (me) {
          applyUpdatedUser(me);
          return;
        }
      } catch {
        // Swallow: the session flag still gets the user through this
        // launch; they'd just see the paywall again next launch.
      }
      // Server call failed (or 200 without a user body) — nudge
      // AuthGate to re-evaluate off the session flag, as before.
      void refreshUser();
    })();
  };

  const stepDisabled = purchasing || restoring;

  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: colors.muted }}
      contentContainerStyle={[
        shared.page,
        { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 },
      ]}
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
    >
      <View style={shared.content}>
        <BrandHeader />

        <Text style={[shared.title, { color: colors.foreground }]}>
          Choose your plan
        </Text>
        <Text style={[shared.subtitle, { color: colors.mutedForeground }]}>
          Pick how many team seats you need. Your free trial continues
          either way — you won't be charged until it ends.
        </Text>

        {prices === null && !loadError ? (
          <ActivityIndicator style={{ marginVertical: 32 }} />
        ) : loadError ? (
          <View style={{ gap: 12, marginVertical: 16 }}>
            <Text
              style={{
                color: colors.destructive,
                fontFamily: "Inter_500Medium",
                textAlign: "center",
              }}
            >
              {loadError}
            </Text>
            <Button title="Retry" variant="ghost" onPress={loadProducts} />
          </View>
        ) : (
          <View style={{ gap: 20, marginTop: 8 }}>
            {/* Seat stepper */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 24,
              }}
            >
              <Pressable
                onPress={() => setSeats((s) => Math.max(MIN_SEATS, s - 1))}
                disabled={stepDisabled || seats <= MIN_SEATS}
                accessibilityRole="button"
                accessibilityLabel="Fewer seats"
                hitSlop={8}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  borderWidth: 1,
                  borderColor: colors.border,
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: seats <= MIN_SEATS ? 0.4 : 1,
                  backgroundColor: colors.card,
                }}
              >
                <Text
                  style={{
                    fontSize: 22,
                    fontFamily: "Inter_600SemiBold",
                    color: colors.foreground,
                  }}
                >
                  −
                </Text>
              </Pressable>
              <View style={{ alignItems: "center", minWidth: 96 }}>
                <Text
                  style={{
                    fontSize: 40,
                    fontFamily: "Inter_700Bold",
                    color: colors.foreground,
                  }}
                >
                  {seats}
                </Text>
                <Text
                  style={{
                    fontSize: 13,
                    fontFamily: "Inter_500Medium",
                    color: colors.mutedForeground,
                  }}
                >
                  team seats
                </Text>
              </View>
              <Pressable
                onPress={() => setSeats((s) => Math.min(maxAvailable, s + 1))}
                disabled={stepDisabled || seats >= maxAvailable}
                accessibilityRole="button"
                accessibilityLabel="More seats"
                hitSlop={8}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  borderWidth: 1,
                  borderColor: colors.border,
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: seats >= maxAvailable ? 0.4 : 1,
                  backgroundColor: colors.card,
                }}
              >
                <Text
                  style={{
                    fontSize: 22,
                    fontFamily: "Inter_600SemiBold",
                    color: colors.foreground,
                  }}
                >
                  +
                </Text>
              </Pressable>
            </View>

            {/* App Store price for the selected seat count */}
            <Text
              style={{
                textAlign: "center",
                fontSize: 17,
                fontFamily: "Inter_600SemiBold",
                color: colors.foreground,
              }}
            >
              {selectedPrice
                ? `${selectedPrice} / month`
                : "Price unavailable for this plan"}
            </Text>

            <Button
              title="Continue"
              onPress={handleContinue}
              loading={purchasing}
              disabled={!selectedPrice || stepDisabled}
              size="lg"
              style={{ backgroundColor: BRAND_ORANGE }}
            />
          </View>
        )}

        {/* Skip + Restore live OUTSIDE the loading/error/content
            conditional and render in EVERY state: if product loading
            fails, the user must still be able to enter the app (App
            Store Guideline 2.1a — no stranding) and a
            lapsed-but-entitled user must still be able to restore. */}
        <View style={{ gap: 20, marginTop: 20 }}>
          <Text
            onPress={stepDisabled ? undefined : handleSkip}
            accessibilityRole="button"
            style={{
              textAlign: "center",
              fontSize: 14,
              fontFamily: "Inter_500Medium",
              color: colors.mutedForeground,
            }}
          >
            Skip this step
          </Text>

          {/* iOS only: restoreApplePurchases submits StoreKit JWS to
              the Apple endpoint — on Android it would post Play tokens
              there and fail confusingly. Play "restore" arrives via the
              purchaseUpdatedListener replaying unacknowledged
              purchases; a user-initiated Google restore flow needs its
              own helper + gate before this renders on Android. */}
          {Platform.OS === "ios" ? (
            <Text
              onPress={stepDisabled ? undefined : () => void handleRestore()}
              accessibilityRole="button"
              style={{
                textAlign: "center",
                fontSize: 14,
                fontFamily: "Inter_500Medium",
                textDecorationLine: "underline",
                color: colors.mutedForeground,
              }}
            >
              {restoring ? "Restoring…" : "Restore Purchases"}
            </Text>
          ) : null}
        </View>
      </View>
    </KeyboardAwareScrollViewCompat>
  );
}
