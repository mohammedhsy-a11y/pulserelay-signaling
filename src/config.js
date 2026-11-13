import crypto from "node:crypto";

const DEFAULT_DEV_STUN = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
  "stun:stun2.l.google.com:19302",
  "stun:stun3.l.google.com:19302",
  "stun:stun4.l.google.com:19302",
  "stun:stun.cloudflare.com:3478"
];

export function loadConfig(env = process.env) {
  const nodeEnv = (env.NODE_ENV || "development").toLowerCase();
  const isProduction = nodeEnv === "production";
  const authMode = (env.AUTH_MODE || (isProduction ? "hmac" : "dev")).toLowerCase();
  const authSecret = env.SIGNALING_AUTH_SECRET || "";

  if (isProduction && authMode === "dev" && env.ALLOW_DEV_AUTH !== "true") {
    // In cloud deployments without token issuers, ALLOW_DEV_AUTH=true or default allows direct signaling
    console.warn("WARN: AUTH_MODE=dev running in production environment. Ensure network is protected.");
  }
  if (authMode === "hmac" && authSecret.length < 32) {
    throw new Error("SIGNALING_AUTH_SECRET (>= 32 chars) is required when AUTH_MODE=hmac.");
  }

  const stunUrls = parseCsvList(env.STUN_URLS, DEFAULT_DEV_STUN);
  const turnUrls = parseCsvList(env.TURN_URLS, []);

  return {
    nodeEnv,
    isProduction,
    host: env.HOST || "0.0.0.0",
    port: parsePositiveInt(env.PORT, 8080),
    wsPath: env.WS_PATH || "/ws",
    authMode,
    authSecret,
    heartbeatIntervalMs: parsePositiveInt(env.HEARTBEAT_INTERVAL_MS, 25_000),
    heartbeatTimeoutMs: parsePositiveInt(env.HEARTBEAT_TIMEOUT_MS, 60_000),
    maxPayloadBytes: parsePositiveInt(env.MAX_PAYLOAD_BYTES, 64 * 1024),
    stunUrls,
    turnUrls,
    turnSharedSecret: env.TURN_SHARED_SECRET || "",
    turnCredentialTtlSeconds: parsePositiveInt(env.TURN_CREDENTIAL_TTL_SECONDS, 3600)
  };
}

/**
 * Generates ephemeral ICE server configuration (STUN + optional time-bound Coturn HMAC credentials).
 * Zero long-lived credentials are exposed to clients.
 */
export function buildIceServers(config, peerId = "anonymous", nowEpochMs = Date.now()) {
  const servers = [];
  if (config.stunUrls.length > 0) {
    servers.push({ urls: config.stunUrls });
  }
  if (config.turnUrls.length > 0) {
    if (config.turnSharedSecret) {
      const expiresAt = Math.floor(nowEpochMs / 1000) + config.turnCredentialTtlSeconds;
      const username = `${expiresAt}:${peerId}`;
      const credential = crypto
        .createHmac("sha1", config.turnSharedSecret)
        .update(username)
        .digest("base64");
      servers.push({
        urls: config.turnUrls,
        username,
        credential
      });
    } else {
      servers.push({ urls: config.turnUrls });
    }
  }
  return servers;
}

function parseCsvList(raw, fallback) {
  if (!raw || raw.trim().length === 0) return fallback;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parsePositiveInt(raw, fallback) {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
