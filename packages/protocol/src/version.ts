/** Wire protocol name + major version. Every HTTP response carries `x-liveforge-protocol: liveforge-protocol/1`. */
export const PROTOCOL_NAME = "liveforge-protocol";
export const PROTOCOL_VERSION = 1 as const;
export const PROTOCOL_ID = `${PROTOCOL_NAME}/${PROTOCOL_VERSION}` as const;
/** Package semver of @liveforge/protocol (additive changes bump minor; breaking changes bump PROTOCOL_VERSION). */
export const PROTOCOL_PACKAGE_VERSION = "0.1.0";
/** Header names used by the HTTP API. */
export const HEADERS = {
  protocol: "x-liveforge-protocol",
  /** Publishable SDK key or admin key. `Authorization: Bearer <key>` is accepted too. */
  key: "x-liveforge-key",
  /** Admin routes: which game to act on when the admin key covers several games. */
  game: "x-liveforge-game",
} as const;
