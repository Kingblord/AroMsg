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

          console.log(
            `📨 ${from}: ${text}`
          );

          // Convert protobuf Long timestamp to plain number
          const rawTs = msg.messageTimestamp;
          const timestamp =
            rawTs !== null && rawTs !== undefined && typeof rawTs === 'object' && 'toNumber' in rawTs
              ? (rawTs as { toNumber: () => number }).toNumber() * 1000
              : Number(rawTs) * 1000;

          // ========================
          // SEND DIRECTLY TO BACKEND
          // ========================

          try {
            const backendResponse = await axios.post(
              `${BACKEND_URL}/api/internal/receive-message`,
              {
                userId,
                from,
                text,
                platform: "whatsapp",
                messageId: msg.key.id,
                timestamp,
              },
              {
                headers: {
                  Authorization:
                    `Bearer ${INTERNAL_API_KEY}`,
                },
              }
            );

            // Check if backend returned an AI response to send back
            if (backendResponse.data?.aiResponse) {
              const { to, text: responseText } = backendResponse.data.aiResponse;
              console.log(`📤 Sending AI response to ${to}`);

              // Normalize the recipient JID
              const jid = to.includes('@s.whatsapp.net')
                ? to
                : `${to}@s.whatsapp.net`;

              // Safe session reference — socket may have reconnected
              const activeSession = sessions[userId];
              if (activeSession?.connected && activeSession.sock) {
                await activeSession.sock.sendMessage(jid, { text: responseText });
                console.log(`✅ AI response sent to ${to}`);
              } else {
                console.warn(`⚠️ Session ${userId} not connected — skipping send`);
              }
            }
          } catch (backendErr) {
            console.error("❌ Backend error:", backendErr);
          }

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
