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
    console.warn("⚠️  Firebase env vars missing — messages will NOT be persisted to Firestore");
  } else {
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey } as admin.ServiceAccount),
      projectId,
    });
    console.log("🔥 Firebase Admin initialised");
  }
}

const db = admin.apps.length ? admin.firestore() : null;

/** Persist a message to Firestore — fire-and-forget, never throws */
async function persistMessage(
  userId: string,
  contactJid: string,
  text: string,
  role: "user" | "assistant",
  messageId: string,
  timestamp: number,
  platform: string = "whatsapp",
) {
  if (!db) return;
  try {
    await db
      .collection("businesses")
      .doc(userId)
      .collection("whatsapp_messages")
      .add({
        contactJid,
        from:      role === "user" ? contactJid : userId,
        to:        role === "user" ? userId      : contactJid,
        text,
        role,
        platform,
        messageId,
        timestamp,
        direction: role === "user" ? "incoming" : "outgoing",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
  } catch (err: any) {
    console.error("❌ Firestore persist error:", err?.message || err);
  }
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

          if (
            shouldReconnect &&
            !sessions[userId]
              ?.reconnecting
          ) {

            sessions[userId]
              .reconnecting = true;

            console.log(
              `🔄 Reconnecting ${userId}`
            );

            setTimeout(() => {
              createSession(userId);
            }, 3000);
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

          // IGNORE OWN MESSAGES
          if (msg.key.fromMe) return;

          const from =
            msg.key.remoteJid;

          if (!from) return;

          // IGNORE GROUPS
          if (
            from.endsWith("@g.us")
          ) {
            return;
          }

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

          // Normalise JID — convert @lid (Linked Device ID) to @s.whatsapp.net
          // Baileys cannot send to @lid JIDs, only to @s.whatsapp.net
          const normalizedFrom = from.endsWith('@s.whatsapp.net')
            ? from
            : from.endsWith('@lid')
              ? `${from.replace('@lid', '')}@s.whatsapp.net`
              : `${from}@s.whatsapp.net`;

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
          // SEND DIRECTLY TO BACKEND
          // Fire-and-forget: do NOT await inside the event handler.
          // Awaiting here blocks Baileys' internal event loop and causes
          // the socket to disconnect while waiting for the AI response.
          // ========================

          const bareJid = normalizedFrom.replace("@s.whatsapp.net", "");

          const processMessage = async () => {
            // 1. Persist incoming customer message immediately to Firestore
            await persistMessage(
              userId,
              bareJid,
              text,
              "user",
              msg.key.id || `in_${Date.now()}`,
              timestamp,
            );

            try {
              const backendResponse = await axios.post(
                `${BACKEND_URL}/api/internal/receive-message`,
                {
                  userId,
                  from: normalizedFrom,
                  text,
                  platform: "whatsapp",
                  messageId: msg.key.id,
                  timestamp,
                },
                {
                  headers: {
                    Authorization: `Bearer ${INTERNAL_API_KEY}`,
                  },
                  timeout: 55000, // 55s — just under Vercel's 60s limit
                }
              );

              if (backendResponse.data?.aiResponse) {
                const { to, text: responseText } = backendResponse.data.aiResponse;

                // Ensure we always send to @s.whatsapp.net
                const jid = to.endsWith('@s.whatsapp.net')
                  ? to
                  : to.endsWith('@lid')
                    ? `${to.replace('@lid', '')}@s.whatsapp.net`
                    : `${to}@s.whatsapp.net`;

                console.log(`📤 Sending AI response to ${jid}`);

                // Safe session reference — socket may have reconnected during AI generation
                const activeSession = sessions[userId];
                if (activeSession?.connected && activeSession.sock) {
                  await activeSession.sock.sendMessage(jid, { text: responseText });
                  console.log(`✅ AI response sent to ${jid}`);

                  // 2. Persist the AI reply to Firestore (backend also saves it, but
                  //    gateway write ensures it lands even if the backend save fails)
                  await persistMessage(
                    userId,
                    bareJid,
                    responseText,
                    "assistant",
                    `ai_gw_${Date.now()}`,
                    Date.now(),
                  );
                } else {
                  console.warn(`⚠️ Session ${userId} not connected — skipping send`);
                }
              }
            } catch (backendErr: any) {
              console.error("❌ Backend error:", backendErr?.message || backendErr);
            }
          };

          // Kick off async — return immediately so Baileys event loop stays alive
          setImmediate(() => { processMessage(); });

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

      // NORMALIZE NUMBER
      const jid =
        to.includes("@s.whatsapp.net")
          ? to
          : `${to}@s.whatsapp.net`;

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
// START SERVER
// ========================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Gateway running on ${PORT}`);
});
