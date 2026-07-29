import { Image, type ImageStyle } from "expo-image";
import { useEffect, useState } from "react";
import type { StyleProp } from "react-native";

import {
  getCachedThumbnailUriSync,
  getThumbnailUri,
} from "@/services/thumbnails";

/**
 * expo-image wrapper that NEVER decodes the full-resolution source:
 * renders nothing (the parent's placeholder background shows) until the
 * bounded ~400px thumbnail is ready, then renders that. Only on
 * generation failure does it fall back to the original source — a
 * deliberate correctness-over-memory tradeoff for individual bad files.
 *
 * `cacheKey` must be stable per image (media id / cover key): it keys
 * the disk cache AND is passed as expo-image's recyclingKey so
 * virtualized lists recycle instead of re-decoding on scroll.
 */
export function ThumbImage({
  cacheKey,
  uri,
  style,
  contentFit = "cover",
  transition = 120,
}: {
  cacheKey: string;
  uri: string;
  style: StyleProp<ImageStyle>;
  contentFit?: "cover" | "contain";
  transition?: number;
}) {
  const [thumbUri, setThumbUri] = useState<string | null>(() =>
    getCachedThumbnailUriSync(cacheKey, uri),
  );

  useEffect(() => {
    let alive = true;
    const memo = getCachedThumbnailUriSync(cacheKey, uri);
    if (memo) {
      setThumbUri(memo);
      return;
    }
    setThumbUri(null); // recycled tile: clear the previous photo's thumb
    void getThumbnailUri(cacheKey, uri).then((u) => {
      if (alive) setThumbUri(u);
    });
    return () => {
      alive = false;
    };
  }, [cacheKey, uri]);

  if (!thumbUri) return null;
  return (
    <Image
      source={{ uri: thumbUri }}
      recyclingKey={cacheKey}
      style={style}
      contentFit={contentFit}
      transition={transition}
    />
  );
}
