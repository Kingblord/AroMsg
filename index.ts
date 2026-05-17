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
import admin from "firebase-admin";

dotenv.config();

// ========================
// FIREBASE ADMIN INIT
// ========================

if (!admin.apps.length) {
  const projectId   = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey  = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    console.warn("⚠️  Firebase env vars missing");
  } else {
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey } as admin.ServiceAccount),
      projectId,
    });
    console.log("🔥 Firebase Admin initialised");
  }
}

// ========================
// UTILITIES
// ========================

/** Normalize JID to always be @s.whatsapp.net format */
function normalizeJid(jid: string): string {
  if (!jid) return jid;
  
  // Already valid
  if (jid.endsWith("@s.whatsapp.net")) {
    return jid;
  }
  
  // LID → WhatsApp JID
  if (jid.endsWith("@lid")) {
    return `${jid.replace("@lid", "")}@s.whatsapp.net`;
  }
  
  // Raw number
  if (!jid.includes("@")) {
    return `${jid}@s.whatsapp.net`;
  }
  
  return jid;
}

const app = express();

app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT) || 3001;

const BACKEND_URL =
  process.env.BACKEND_URL;

const INTERNAL_API_KEY =
  process.env.INTERNAL_API_KEY;

if (!BACKEND_URL) {
  console.warn(
    "⚠️ BACKEND_URL missing"
  );
}

mkdirSync("sessions", {
  recursive: true,
});

// ========================
// SESSION STORE
// ========================

interface SessionData {
  sock: any;
  qr?: string;
  connected: boolean;
  phoneNumber?: string;
  reconnecting?: boolean;
}

const sessions:
  Record<string, SessionData> = {};

// ========================
// MESSAGE DEDUPLICATION
// ========================

const processedMessages = new Set<string>();

function markProcessed(msgId: string) {
  processedMessages.add(msgId);
  setTimeout(() => {
    processedMessages.delete(msgId);
  }, 1000 * 60); // 60 second window
}

function isProcessed(msgId: string): boolean {
  return processedMessages.has(msgId);
}

// ========================
// CREATE SESSION
// ========================

async function createSession(
  userId: string
) {

  try {

    const { state, saveCreds } =
      await useMultiFileAuthState(
        `sessions/${userId}`
      );

    const { version } =
      await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      auth: state,
      version,
      logger: P({
        level: "silent",
      }),
      printQRInTerminal: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 5000,
    });

    sessions[userId] = {
      sock,
      connected: false,
      reconnecting: false,
    };

    // ========================
    // SAVE CREDS
    // ========================

    sock.ev.on(
      "creds.update",
      saveCreds
    );

    // ========================
    // CONNECTION EVENTS
    // ========================

    sock.ev.on(
      "connection.update",
      async (update) => {

        const {
          connection,
          qr,
          lastDisconnect,
        } = update;

        // QR GENERATED
        if (qr) {

          const qrImage =
            await QRCode.toDataURL(qr);

          sessions[userId].qr =
            qrImage;

          console.log(
            `📱 QR generated: ${userId}`
          );
        }

        // CONNECTED
        if (connection === "open") {

          sessions[userId].connected =
            true;

          sessions[userId].reconnecting =
            false;

          sessions[userId].phoneNumber =
            sock.user?.id
              ?.split(":")[0] || "";

          console.log(
            `✅ Connected: ${userId}`
          );
        }

        // DISCONNECTED
        if (connection === "close") {

          sessions[userId].connected =
            false;

          const shouldReconnect =
            (lastDisconnect?.error as any)
              ?.output?.statusCode !==
            DisconnectReason.loggedOut;

          console.log(
            `❌ Disconnected: ${userId}`
          );

          if (!shouldReconnect) {
            // Logged out — delete session
            delete sessions[userId];
          } else if (
            !sessions[userId]?.reconnecting
          ) {
            // Need to reconnect with proper cleanup

            sessions[userId].reconnecting = true;

            console.log(
              `🔄 Reconnecting ${userId}`
            );

            // CLEAN OLD SOCKET
            try {
              await sock.ws?.close?.();
            } catch {}

            try {
              sock.end?.();
            } catch {}

            // REMOVE OLD SESSION
            delete sessions[userId];

            setTimeout(async () => {
              try {
                await createSession(userId);
              } catch (err) {
                console.error(
                  `Reconnect failed ${userId}`,
                  err
                );
              }
            }, 5000);
          }
        }
      }
    );

    // ========================
    // MESSAGE EVENTS
    // ========================

    sock.ev.on(
      "messages.upsert",
      async ({ messages }) => {

        try {

          const msg = messages[0];

          if (!msg?.message) return;

          // FILTER: own messages
          if (msg.key.fromMe) return;

          // FILTER: broadcast messages
          if (msg.broadcast) return;

          // FILTER: protocol/stub messages
          if (msg.messageStubType) return;

          // FILTER: status broadcasts
          if (msg.key.remoteJid === "status@broadcast") return;

          // FILTER: groups
          if (msg.key.remoteJid?.endsWith("@g.us")) return;

          // CHECK FOR DUPLICATES
          if (isProcessed(msg.key.id)) {
            console.log(`[dedup] Skipping duplicate: ${msg.key.id}`);
            return;
          }

          const from =
            msg.key.remoteJid;

          if (!from) return;

          const text =
            msg.message.conversation ||
            msg.message
              .extendedTextMessage
              ?.text ||
            msg.message.imageMessage
              ?.caption ||
            msg.message.videoMessage
              ?.caption;

          if (!text?.trim()) {
            return;
          }

          // Mark as processed
          markProcessed(msg.key.id);

          // Normalize JID
          const normalizedFrom = normalizeJid(from);

          console.log(
            `📨 ${normalizedFrom}: ${text}`
          );

          // Convert protobuf Long timestamp to plain number
          const rawTs = msg.messageTimestamp;
          const timestamp =
            rawTs !== null && rawTs !== undefined && typeof rawTs === 'object' && 'toNumber' in rawTs
              ? (rawTs as { toNumber: () => number }).toNumber() * 1000
              : Number(rawTs) * 1000;

          // ========================
          // NOTIFY BACKEND
          // ========================
          // Fire-and-forget — backend saves incoming message and runs AI.
          // Backend then calls gateway /send-message to deliver the reply.

          setImmediate(() => {
            axios.post(
              `${BACKEND_URL}/api/internal/receive-message`,
              {
                userId,
                from:      normalizedFrom,
                text,
                platform:  "whatsapp",
                messageId: msg.key.id || `in_${Date.now()}`,
                timestamp,
              },
              {
                headers: { Authorization: `Bearer ${INTERNAL_API_KEY}` },
                timeout: 60000,
              }
            ).catch((err: any) => {
              console.error("❌ Backend notify failed:", err?.message || err);
            });
          });

        } catch (err) {

          console.error(
            "❌ Message processing error:",
            err
          );
        }
      }
    );

  } catch (err) {

    console.error(
      `❌ Session creation failed: ${userId}`,
      err
    );
  }
}

// ========================
// CONNECT
// ========================

app.post(
  "/connect",
  async (req, res) => {

    const { userId } = req.body;

    if (!userId) {

      return res.status(400)
        .json({
          error:
            "userId required",
        });
    }

    if (!sessions[userId]) {

      await createSession(
        userId
      );
    }

    res.json({
      success: true,
    });
  }
);

// ========================
// QR
// ========================

app.get(
  "/qr/:userId",
  (req, res) => {

    const { userId } =
      req.params;

    const session =
      sessions[userId];

    if (!session) {

      return res.status(404)
        .json({
          error:
            "Session not found",
        });
    }

    res.json({
      qr: session.qr,
      connected:
        session.connected,
    });
  }
);

// ========================
// STATUS
// ========================

app.get(
  "/status/:userId",
  (req, res) => {

    const { userId } =
      req.params;

    const session =
      sessions[userId];

    res.json({
      connected:
        session?.connected ||
        false,
      phoneNumber:
        session?.phoneNumber ||
        null,
    });
  }
);

// ========================
// SEND MESSAGE
// ========================

app.post(
  "/send-message",
  async (req, res) => {

    try {

      const {
        userId,
        to,
        text,
      } = req.body;

      if (
        !userId ||
        !to ||
        !text
      ) {

        return res.status(400)
          .json({
            error:
              "Missing fields",
          });
      }

      const session =
        sessions[userId];

      if (!session?.sock) {

        return res.status(404)
          .json({
            error:
              "Session not found",
          });
      }

      // NORMALIZE JID
      const jid = normalizeJid(to);

      await session.sock.sendMessage(
        jid,
        {
          text,
        }
      );

      res.json({
        success: true,
      });

    } catch (err: any) {

      console.error(
        "❌ Send failed:",
        err
      );

      res.status(500).json({
        error:
          err.message ||
          "Send failed",
      });
    }
  }
);

// ========================
// DISCONNECT
// ========================

app.post(
  "/disconnect",
  async (req, res) => {

    const { userId } =
      req.body;

    const session =
      sessions[userId];

    if (session) {

      try {

        await session.sock.logout();

      } catch (e) {

        console.error(
          "Logout error:",
          e
        );
      }

      delete sessions[userId];
    }

    res.json({
      success: true,
    });
  }
);

// ========================
// HEALTH
// ========================

app.get(
  "/health",
  (_, res) => {

    res.json({
      status: "ok",
    });
  }
);

// ========================
// GRACEFUL SHUTDOWN
// ========================

process.on("SIGTERM", async () => {
  console.log("SIGTERM received — shutting down gracefully");

  for (const userId in sessions) {
    try {
      await sessions[userId].sock?.logout();
      console.log(`✅ Logged out ${userId}`);
    } catch (err) {
      console.error(`❌ Logout error for ${userId}:`, err);
    }
  }

  process.exit(0);
});

// ========================
// START SERVER
// ========================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Gateway running on ${PORT}`);
});
