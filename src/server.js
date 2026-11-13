import http from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { authenticateHandshake } from "./auth.js";
import { buildIceServers, loadConfig } from "./config.js";

const PROTOCOL_VERSION = 1;
const MAX_SUBSCRIPTION_BATCH = 200;

export function createSignalingServer(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  const startedAtMs = Date.now();

  /** @type {Map<string, { socket: WebSocket, connectedAtMs: number, lastSeenMs: number, isAlive: boolean, pushToken: string | null }>} */
  const peers = new Map();
  /** @type {Map<string, Set<string>>} targetPeerId -> Set<watcherPeerId> */
  const presenceWatchers = new Map();

  const httpServer = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && reqUrl.pathname === "/health") {
      sendHttpJson(res, 200, {
        status: "ok",
        service: "pulserelay-signaling",
        environment: config.nodeEnv,
        authMode: config.authMode,
        activePeers: peers.size,
        messageStorage: "disabled",
        uptimeSeconds: Math.floor((Date.now() - startedAtMs) / 1000)
      });
      return;
    }

    if (req.method === "GET" && reqUrl.pathname === "/ice-config") {
      const peerId = reqUrl.searchParams.get("peerId") || "anonymous";
      sendHttpJson(res, 200, {
        iceServers: buildIceServers(config, peerId)
      });
      return;
    }

    sendHttpJson(res, 404, { error: "NOT_FOUND" });
  });

  const wss = new WebSocketServer({
    server: httpServer,
    path: config.wsPath,
    maxPayload: config.maxPayloadBytes
  });

  wss.on("connection", (socket, request) => {
    const reqUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const peerId =
      reqUrl.searchParams.get("peerId") ||
      headerString(request.headers["x-pulserelay-peer-id"]);
    const token =
      extractBearerToken(request.headers.authorization) ||
      reqUrl.searchParams.get("token");

    const authResult = authenticateHandshake({ peerId, token, config });
    if (!authResult.ok) {
      sendJson(socket, {
        type: "error",
        code: authResult.reason,
        timestampEpochMs: Date.now()
      });
      socket.close(authResult.code, authResult.reason);
      return;
    }

    const existing = peers.get(peerId);
    if (existing && existing.socket !== socket && existing.socket.readyState === WebSocket.OPEN) {
      sendJson(existing.socket, {
        type: "session.replaced",
        reason: "NEW_CONNECTION_OPENED",
        timestampEpochMs: Date.now()
      });
      existing.socket.close(4000, "SESSION_REPLACED");
    }

    const nowMs = Date.now();
    peers.set(peerId, {
      socket,
      connectedAtMs: nowMs,
      lastSeenMs: nowMs,
      isAlive: true,
      pushToken: null
    });
    console.log(`[PEER CONNECTED] ${peerId} (active peers: ${peers.size})`);

    sendJson(socket, {
      type: "welcome",
      peerId,
      protocolVersion: PROTOCOL_VERSION,
      authMode: config.authMode,
      iceServers: buildIceServers(config, peerId, nowMs),
      timestampEpochMs: nowMs
    });

    notifyPresenceWatchers(peerId, "ONLINE", nowMs);

    socket.on("pong", () => {
      const entry = peers.get(peerId);
      if (entry && entry.socket === socket) {
        entry.isAlive = true;
        entry.lastSeenMs = Date.now();
      }
    });

    socket.on("message", (rawData) => {
      const entry = peers.get(peerId);
      if (entry && entry.socket === socket) {
        entry.isAlive = true;
        entry.lastSeenMs = Date.now();
      }

      let frame;
      try {
        frame = JSON.parse(rawData.toString("utf8"));
      } catch {
        sendJson(socket, {
          type: "error",
          code: "INVALID_JSON",
          timestampEpochMs: Date.now()
        });
        return;
      }

      if (!frame || typeof frame.type !== "string") {
        sendJson(socket, {
          type: "error",
          code: "MISSING_FRAME_TYPE",
          timestampEpochMs: Date.now()
        });
        return;
      }

      handleFrame(peerId, socket, frame);
    });

    socket.on("close", () => {
      const current = peers.get(peerId);
      if (current && current.socket === socket) {
        peers.delete(peerId);
        console.log(`[PEER DISCONNECTED] ${peerId} (remaining: ${peers.size})`);
        removeWatcherEverywhere(peerId);
        notifyPresenceWatchers(peerId, "OFFLINE", Date.now());
      }
    });

    socket.on("error", () => {
      // Handled safely by close/heartbeat cleanup without crashing server.
    });
  });

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const [peerId, entry] of peers.entries()) {
      if (!entry.isAlive || now - entry.lastSeenMs > config.heartbeatTimeoutMs) {
        entry.socket.terminate();
        peers.delete(peerId);
        removeWatcherEverywhere(peerId);
        notifyPresenceWatchers(peerId, "OFFLINE", now);
        continue;
      }
      entry.isAlive = false;
      if (entry.socket.readyState === WebSocket.OPEN) {
        entry.socket.ping();
      }
    }
  }, config.heartbeatIntervalMs);
  heartbeatTimer.unref();

  function handleFrame(senderPeerId, socket, frame) {
    const nowMs = Date.now();

    switch (frame.type) {
      case "ping": {
        sendJson(socket, {
          type: "pong",
          timestampEpochMs: nowMs
        });
        return;
      }

      case "presence.subscribe": {
        const targetIds = sanitizePeerList(frame.peerIds);
        for (const targetId of targetIds) {
          if (!presenceWatchers.has(targetId)) {
            presenceWatchers.set(targetId, new Set());
          }
          presenceWatchers.get(targetId).add(senderPeerId);
        }
        sendJson(socket, {
          type: "presence.snapshot",
          peers: targetIds.map((id) => buildPresenceEntry(id, nowMs)),
          timestampEpochMs: nowMs
        });
        return;
      }

      case "presence.query": {
        const targetIds = sanitizePeerList(frame.peerIds);
        sendJson(socket, {
          type: "presence.snapshot",
          peers: targetIds.map((id) => buildPresenceEntry(id, nowMs)),
          timestampEpochMs: nowMs
        });
        return;
      }

      case "push.register": {
        if (typeof frame.token !== "string" || frame.token.trim().length === 0) {
          sendJson(socket, { type: "error", code: "INVALID_PUSH_TOKEN", timestampEpochMs: nowMs });
          return;
        }
        const entry = peers.get(senderPeerId);
        if (entry) {
          entry.pushToken = frame.token.trim();
        }
        sendJson(socket, {
          type: "push.registered",
          timestampEpochMs: nowMs
        });
        return;
      }

      case "signal": {
        const { messageId, fromPeerId, toPeerId, kind, payloadJson } = frame;
        console.log(`[SIGNAL IN] from=${senderPeerId} (claimed=${fromPeerId}) to=${toPeerId} kind=${kind}`);
        if (
          typeof messageId !== "string" ||
          typeof toPeerId !== "string" ||
          typeof kind !== "string" ||
          typeof payloadJson !== "string"
        ) {
          console.warn(`[SIGNAL REJECTED] INVALID_SIGNAL_ENVELOPE from=${senderPeerId}`);
          sendJson(socket, {
            type: "error",
            code: "INVALID_SIGNAL_ENVELOPE",
            timestampEpochMs: nowMs
          });
          return;
        }

        if (fromPeerId && fromPeerId !== senderPeerId) {
          console.warn(`[SIGNAL REJECTED] SENDER_SPOOF_REJECTED senderPeerId=${senderPeerId} vs claimed=${fromPeerId}`);
          sendJson(socket, {
            type: "error",
            code: "SENDER_SPOOF_REJECTED",
            messageId,
            timestampEpochMs: nowMs
          });
          return;
        }

        const recipient = peers.get(toPeerId);
        if (!recipient || recipient.socket.readyState !== WebSocket.OPEN) {
          console.warn(`[SIGNAL UNDELIVERED] PEER_OFFLINE toPeerId=${toPeerId} (registered peers: ${[...peers.keys()].join(", ")})`);
          // Intentionally never stores chat/signaling content on the server.
          sendJson(socket, {
            type: "signal.undelivered",
            messageId,
            toPeerId,
            reason: "PEER_OFFLINE",
            timestampEpochMs: nowMs
          });
          return;
        }

        console.log(`[SIGNAL RELAYED] kind=${kind} from=${senderPeerId} to=${toPeerId}`);
        sendJson(recipient.socket, {
          type: "signal",
          messageId,
          fromPeerId: senderPeerId,
          toPeerId,
          kind,
          payloadJson,
          timestampEpochMs: frame.timestampEpochMs || nowMs
        });

        sendJson(socket, {
          type: "signal.ack",
          messageId,
          toPeerId,
          deliveredToPeer: true,
          timestampEpochMs: nowMs
        });
        return;
      }

      default: {
        sendJson(socket, {
          type: "error",
          code: "UNSUPPORTED_FRAME_TYPE",
          timestampEpochMs: nowMs
        });
      }
    }
  }

  function buildPresenceEntry(peerId, nowMs) {
    const entry = peers.get(peerId);
    const isOnline = Boolean(entry && entry.socket.readyState === WebSocket.OPEN);
    return {
      peerId,
      status: isOnline ? "ONLINE" : "OFFLINE",
      lastSeenEpochMs: isOnline ? nowMs : null
    };
  }

  function notifyPresenceWatchers(targetPeerId, status, timestampEpochMs) {
    const watchers = presenceWatchers.get(targetPeerId);
    if (!watchers || watchers.size === 0) return;

    for (const watcherPeerId of watchers) {
      if (watcherPeerId === targetPeerId) continue;
      const watcherEntry = peers.get(watcherPeerId);
      if (watcherEntry && watcherEntry.socket.readyState === WebSocket.OPEN) {
        sendJson(watcherEntry.socket, {
          type: "presence.update",
          peerId: targetPeerId,
          status,
          timestampEpochMs
        });
      }
    }
  }

  function removeWatcherEverywhere(watcherPeerId) {
    for (const watcherSet of presenceWatchers.values()) {
      watcherSet.delete(watcherPeerId);
    }
  }

  function sanitizePeerList(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item) => typeof item === "string" && item.trim().length > 0)
      .slice(0, MAX_SUBSCRIPTION_BATCH);
  }

  return {
    config,
    httpServer,
    wss,
    start: () =>
      new Promise((resolve) => {
        httpServer.listen(config.port, config.host, () => {
          const addr = httpServer.address();
          resolve({
            host: config.host,
            port: typeof addr === "object" && addr ? addr.port : config.port
          });
        });
      }),
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeatTimer);
        for (const entry of peers.values()) {
          entry.socket.terminate();
        }
        peers.clear();
        presenceWatchers.clear();
        wss.close(() => {
          httpServer.close(() => resolve());
        });
      }),
    getActivePeerCount: () => peers.size
  };
}

function extractBearerToken(authHeader) {
  if (typeof authHeader !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1].trim() : null;
}

function headerString(value) {
  return typeof value === "string" ? value.trim() : null;
}

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function sendHttpJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

// Run standalone if invoked directly via `node src/server.js`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const instance = createSignalingServer();
  instance.start().then(({ host, port }) => {
    console.log(
      `[PulseRelay Signaling] listening on ${host}:${port}${instance.config.wsPath} ` +
        `(env=${instance.config.nodeEnv}, auth=${instance.config.authMode}, storage=disabled)`
    );
  });
}
