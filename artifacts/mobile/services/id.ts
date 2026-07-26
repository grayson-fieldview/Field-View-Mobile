export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/**
 * Id for NEW annotation strokes: `fv-` + UUIDv4.
 *
 * The id doubles as the stroke's width-unit provenance marker (see
 * services/annotations.ts): bare base-36 ids (the legacy newId format
 * above) mark 1000-virtual-canvas-unit widths; everything else — web
 * UUIDs, web `s-` fallbacks, and these `fv-` ids — marks raw px.
 * Do NOT reuse newId() for strokes: minting a base-36 stroke id would
 * classify its px width as 1000-units and render it as a hairline.
 *
 * No imports on purpose — this module is also loaded by plain `node
 * --test`, so it must not touch React Native or Expo modules. UUID
 * source, in order: Web Crypto (web + Node), the Expo native module's
 * global (iOS/Android app runtime), then a Math.random RFC-4122-shaped
 * fallback (format is what matters for classification; stroke ids are
 * list keys, not security tokens).
 */
export function newStrokeId(): string {
  return `fv-${uuidv4()}`;
}

function uuidv4(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto;
  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  const nativeUuidv4 = (globalThis as { expo?: { uuidv4?: () => string } })
    .expo?.uuidv4;
  if (typeof nativeUuidv4 === "function") return nativeUuidv4();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
