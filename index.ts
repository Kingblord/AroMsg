import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import { mkdirSync } from "fs";

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";

import P from "pino";
import QRCode from "qrcode";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT) || 3001;
const BACKEND_URL = process.env.BACKEND_URL;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

if (!BACKEND_URL) {
  console.warn("⚠️  BACKEND_URL is not set — messages will not reach the backend.");
}
if (!INTERNAL_API_KEY) {
  console.warn("⚠️  INTERNAL_API_KEY is not set — backend requests will be rejected.");
}

mkdirSync("sessions", { recursive: true });

// ─── Session Store ────────────────────────────────────────────────────────────

interface SessionData {
  sock: ReturnType<typeof makeWASocket>;
  qr?: string;
  connected: boolean;
  phoneNumber?: string;
  reconnecting: boolean;
}

const sessions: Record<string, SessionData> = {};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalise a recipient to a full WhatsApp JID. */
function toJid(phoneOrJid: string): string {
  return phoneOrJid.includes("@s.whatsapp.net")
    ? phoneOrJid
    : `${phoneOrJid}@s.whatsapp.net`;
}

/**
 * Convert a protobuf Long (or anything else) to a plain JS number.
 * Baileys' messageTimestamp field can be a protobuf Long object.
 */
function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (
    value !== null &&
    typeof value === "object" &&
    "toNumber" in (value as object)
  ) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value) || Date.now();
}

// ─── Create / Restore Session ─────────────────────────────────────────────────

async function createSession(userId: string): Promise<void> {
  // Tear down any stale socket before creating a new one
  const existing = sessions[userId];
  if (existing?.sock) {
    try {
      existing.sock.ev.removeAllListeners();
      existing.sock.end(undefined);
    } catch {
      // ignore cleanup errors
    }
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(`sessions/${userId}`);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      auth: state,
      version,
      logger: P({ level: "silent" }),
      printQRInTerminal: false,
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 30_000,
      retryRequestDelayMs: 5_000,
    });

    sessions[userId] = {
      sock,
      connected: false,
      reconnecting: false,
    };

    // ── Persist credentials ───────────────────────────────────────────────
    sock.ev.on("creds.update", saveCreds);

    // ── Connection state ──────────────────────────────────────────────────
    sock.ev.on("connection.update", async (update) => {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        const qrImage = await QRCode.toDataURL(qr);
        sessions[userId].qr = qrImage;
        console.log(`[gateway] QR ready for ${userId}`);
      }

      if (connection === "open") {
        sessions[userId].connected = true;
        sessions[userId].reconnecting = false;
        sessions[userId].phoneNumber = sock.user?.id?.split(":")[0] ?? "";
        sessions[userId].qr = undefined; // QR no longer needed
        console.log(`[gateway] Connected: ${userId} (${sessions[userId].phoneNumber})`);
      }

      if (connection === "close") {
        sessions[userId].connected = false;

        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })
          ?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        console.log(
          `[gateway] Disconnected: ${userId} — code ${statusCode ?? "unknown"}`,
        );

        if (!loggedOut && !sessions[userId]?.reconnecting) {
          sessions[userId].reconnecting = true;
          console.log(`[gateway] Scheduling reconnect for ${userId} in 5 s`);
          setTimeout(() => createSession(userId), 5_000);
        }

        if (loggedOut) {
          // Clean up persisted session data so QR is re-requested on next connect
          delete sessions[userId];
          console.log(`[gateway] Session ${userId} logged out — cleared`);
        }
      }
    });

    // ── Incoming messages ─────────────────────────────────────────────────
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      // Only process new messages, not history syncs
      if (type !== "notify") return;

      for (const msg of messages) {
        // Skip messages without body or sent by us
        if (!msg?.message || msg.key.fromMe) continue;

        const from = msg.key.remoteJid;
        if (!from) continue;

        // Skip group messages
        if (from.endsWith("@g.us") || from.endsWith("@broadcast")) continue;

        // Extract text from all common message types
        const text =
          msg.message.conversation ??
          msg.message.extendedTextMessage?.text ??
          msg.message.imageMessage?.caption ??
          msg.message.videoMessage?.caption ??
          msg.message.buttonsResponseMessage?.selectedDisplayText ??
          msg.message.listResponseMessage?.title ??
          null;

        if (!text?.trim()) continue;

        const timestamp = toNumber(msg.messageTimestamp);

        console.log(`[gateway] Inbound ${from}: "${text.slice(0, 60)}"`);

        // ── Forward to backend ────────────────────────────────────────────
        try {
          const response = await axios.post(
            `${BACKEND_URL}/api/internal/receive-message`,
            {
              userId,
              from,           // full JID e.g. 2348012345678@s.whatsapp.net
              text: text.trim(),
              platform: "whatsapp",
              messageId: msg.key.id ?? `${Date.now()}`,
              timestamp,
            },
            {
              headers: {
                Authorization: `Bearer ${INTERNAL_API_KEY}`,
                "Content-Type": "application/json",
              },
              timeout: 30_000,
            },
          );

          // ── Send AI reply back via WhatsApp ───────────────────────────
          const aiResponse = response.data?.aiResponse as
            | { to: string; text: string }
            | undefined;

          if (aiResponse?.to && aiResponse?.text) {
            const session = sessions[userId];
            if (session?.connected) {
              const jid = toJid(aiResponse.to);
              await session.sock.sendMessage(jid, { text: aiResponse.text });
              console.log(
                `[gateway] AI reply sent to ${jid}: "${aiResponse.text.slice(0, 60)}"`,
              );
            } else {
              console.warn(
                `[gateway] Session ${userId} disconnected — could not send reply to ${aiResponse.to}`,
              );
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[gateway] Backend error for ${userId}:`, msg);
        }
      }
    });
  } catch (err) {
    console.error(`[gateway] Failed to create session for ${userId}:`, err);
    // Allow a retry
    if (sessions[userId]) {
      sessions[userId].reconnecting = false;
    }
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/** POST /connect — start or restore a WhatsApp session */
app.post("/connect", async (req, res) => {
  const { userId } = req.body as { userId?: string };

  if (!userId) {
    return res.status(400).json({ error: "userId is required" });
  }

  const existing = sessions[userId];

  // Already connected — nothing to do
  if (existing?.connected) {
    return res.json({ success: true, alreadyConnected: true });
  }

  // Session exists but is disconnected — recreate
  if (!existing || !existing.connected) {
    await createSession(userId);
  }

  return res.json({ success: true });
});

/** GET /qr/:userId — get the current QR code for pairing */
app.get("/qr/:userId", (req, res) => {
  const session = sessions[req.params.userId];

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  return res.json({
    qr: session.qr ?? null,
    connected: session.connected,
  });
});

/** GET /status/:userId — check connection status */
app.get("/status/:userId", (req, res) => {
  const session = sessions[req.params.userId];

  return res.json({
    connected: session?.connected ?? false,
    phoneNumber: session?.phoneNumber ?? null,
  });
});

/** POST /send-message — send an outbound message from the dashboard */
app.post("/send-message", async (req, res) => {
  const { userId, to, text } = req.body as {
    userId?: string;
    to?: string;
    text?: string;
  };

  if (!userId || !to || !text) {
    return res.status(400).json({ error: "userId, to, and text are required" });
  }

  const session = sessions[userId];

  if (!session?.connected) {
    return res.status(404).json({ error: "Session not found or not connected" });
  }

  try {
    const jid = toJid(to);
    await session.sock.sendMessage(jid, { text });
    return res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Send failed";
    console.error(`[gateway] Send failed for ${userId}:`, message);
    return res.status(500).json({ error: message });
  }
});

/** POST /disconnect — log out and destroy a session */
app.post("/disconnect", async (req, res) => {
  const { userId } = req.body as { userId?: string };
  const session = sessions[userId ?? ""];

  if (session) {
    try {
      await session.sock.logout();
    } catch {
      // Baileys throws if already disconnected — safe to ignore
    }
    delete sessions[userId!];
  }

  return res.json({ success: true });
});

/** GET /health — liveness probe */
app.get("/health", (_req, res) => {
  return res.json({
    status: "ok",
    activeSessions: Object.keys(sessions).length,
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[gateway] Running on port ${PORT}`);
});
