import crypto from "node:crypto";

const PEER_ID_REGEX = /^[a-zA-Z0-9_.:+\-]{3,128}$/;

/**
 * Validates handshake peerId and session token without storing credentials.
 * - `dev` mode (strictly non-production): accepts non-empty local session tokens >= 6 chars.
 * - `hmac` mode: verifies `<expEpochSec>.<base64url(HMAC-SHA256(secret, peerId + ":" + expEpochSec))>`.
 */
export function authenticateHandshake({ peerId, token, config, nowEpochSec = Math.floor(Date.now() / 1000) }) {
  if (!peerId || !PEER_ID_REGEX.test(peerId)) {
    return { ok: false, code: 4400, reason: "INVALID_PEER_ID" };
  }
  if (!token || typeof token !== "string" || token.trim().length < 6) {
    return { ok: false, code: 4401, reason: "MISSING_AUTH_TOKEN" };
  }

  if (config.authMode === "dev") {
    return { ok: true, peerId };
  }

  if (config.authMode === "hmac") {
    const parts = token.split(".");
    if (parts.length !== 2) {
      return { ok: false, code: 4401, reason: "INVALID_TOKEN_FORMAT" };
    }
    const [expRaw, providedSig] = parts;
    const expSec = Number.parseInt(expRaw, 10);
    if (!Number.isFinite(expSec) || expSec < nowEpochSec) {
      return { ok: false, code: 4401, reason: "TOKEN_EXPIRED" };
    }

    const expectedSig = crypto
      .createHmac("sha256", config.authSecret)
      .update(`${peerId}:${expSec}`)
      .digest("base64url");

    const providedBuf = Buffer.from(providedSig);
    const expectedBuf = Buffer.from(expectedSig);
    if (
      providedBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(providedBuf, expectedBuf)
    ) {
      return { ok: false, code: 4403, reason: "INVALID_TOKEN_SIGNATURE" };
    }
    return { ok: true, peerId };
  }

  return { ok: false, code: 4500, reason: "UNSUPPORTED_AUTH_MODE" };
}

export function issueHmacToken(peerId, secret, ttlSeconds = 3600, nowEpochSec = Math.floor(Date.now() / 1000)) {
  const expSec = nowEpochSec + ttlSeconds;
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${peerId}:${expSec}`)
    .digest("base64url");
  return `${expSec}.${sig}`;
}
