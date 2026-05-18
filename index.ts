import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import path from "path";
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

const PORT =
  Number(process.env.PORT) || 3001;

const BACKEND_URL =
  process.env.BACKEND_URL;

const INTERNAL_API_KEY =
  process.env.INTERNAL_API_KEY;

// ========================
// SESSION STORAGE
// ========================

const SESSIONS_DIR =
  path.join(
    process.cwd(),
    "sessions"
  );

mkdirSync(SESSIONS_DIR, {
  recursive: true,
});

// ========================
// TYPES
// ========================

interface SessionData {
  sock: any;
  qr?: string;
  connected: boolean;
  reconnecting: boolean;
  phoneNumber?: string;
}

// ========================
// MEMORY STORE
// ========================

const sessions:
  Record<string, SessionData> = {};

const processedMessages =
  new Set<string>();

// ========================
// HELPERS
// ========================

function normalizeJid(
  jid: string
) {

  if (!jid) return jid;

  if (
    jid.endsWith("@s.whatsapp.net")
  ) {
    return jid;
  }

  if (
    jid.endsWith("@lid")
  ) {
    return `${
      jid.replace("@lid", "")
    }@s.whatsapp.net`;
  }

  if (!jid.includes("@")) {
    return `${jid}@s.whatsapp.net`;
  }

  return jid;
}

// ========================
// CREATE SESSION
// ========================

async function createSession(
  userId: string
) {

  try {

    const authPath =
      path.join(
        SESSIONS_DIR,
        userId
      );

    const {
      state,
      saveCreds
    } =
      await useMultiFileAuthState(
        authPath
      );

    const { version } =
      await fetchLatestBaileysVersion();

    const sock =
      makeWASocket({

        auth: state,
        version,

        logger: P({
          level: "silent"
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

    // SAVE AUTH

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

        // QR

        if (qr) {

          const qrImage =
            await QRCode.toDataURL(qr);

          sessions[userId].qr =
            qrImage;

          console.log(
            `📱 QR: ${userId}`
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

          console.log(
            `❌ Disconnected: ${userId}`
          );

          const shouldReconnect =
            (lastDisconnect?.error as any)
              ?.output?.statusCode !==
            DisconnectReason.loggedOut;

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

            try {
              sock.ws.close();
            } catch {}

            delete sessions[userId];

            setTimeout(
              async () => {

                try {
                  await createSession(
                    userId
                  );
                } catch (err) {

                  console.error(
                    "Reconnect failed",
                    err
                  );
                }

              },
              5000
            );
          }
        }
      }
    );

    // ========================
    // INCOMING MESSAGES
    // ========================

    sock.ev.on(
      "messages.upsert",
      async ({ messages }) => {

        try {

          const msg =
            messages[0];

          if (!msg?.message)
            return;

          if (msg.key.fromMe)
            return;

          if (msg.broadcast)
            return;

          if (msg.messageStubType)
            return;

          const from =
            msg.key.remoteJid;

          if (!from)
            return;

          if (
            from ===
            "status@broadcast"
          ) {
            return;
          }

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
            msg.message
              .imageMessage
              ?.caption ||
            msg.message
              .videoMessage
              ?.caption;

          if (!text?.trim()) {
            return;
          }

          const messageId =
            msg.key.id || "";

          // DEDUPE

          if (
            processedMessages.has(
              messageId
            )
          ) {
            return;
          }

          processedMessages.add(
            messageId
          );

          setTimeout(() => {

            processedMessages.delete(
              messageId
            );

          }, 1000 * 60);

          const normalizedFrom =
            normalizeJid(from);

          console.log(
            `📨 ${normalizedFrom}: ${text}`
          );

          // TIMESTAMP

          const rawTs =
            msg.messageTimestamp;

          const timestamp =
            rawTs !== null &&
            rawTs !== undefined &&
            typeof rawTs === "object" &&
            "toNumber" in rawTs
              ? (
                  rawTs as {
                    toNumber:
                      () => number
                  }
                ).toNumber() * 1000
              : Number(rawTs) * 1000;

          // ========================
          // WEBHOOK TO BACKEND
          // ========================

          setImmediate(() => {

            axios.post(

              `${BACKEND_URL}/`,

              {
                userId,
                from:
                  normalizedFrom,
                text,
                platform:
                  "whatsapp",
                messageId,
                timestamp,
              },

              {
                headers: {
                  Authorization:
                    `Bearer ${INTERNAL_API_KEY}`
                },

                timeout: 15000,
              }

            ).catch(
              (err: any) => {

                console.error(
                  "❌ Backend webhook failed:",
                  err?.message || err
                );
              }
            );

          });

        } catch (err) {

          console.error(
            "❌ Message error:",
            err
          );
        }
      }
    );

  } catch (err) {

    console.error(
      `❌ Session failed: ${userId}`,
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

    const { userId } =
      req.body;

    if (!userId) {

      return res.status(400)
        .json({
          error:
            "userId required"
        });
    }

    if (!sessions[userId]) {

      await createSession(
        userId
      );
    }

    res.json({
      success: true
    });
  }
);

// ========================
// QR
// ========================

app.get(
  "/qr/:userId",
  (req, res) => {

    const session =
      sessions[
        req.params.userId
      ];

    if (!session) {

      return res.status(404)
        .json({
          error:
            "Session not found"
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

    const session =
      sessions[
        req.params.userId
      ];

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
              "Missing fields"
          });
      }

      const session =
        sessions[userId];

      if (
        !session?.connected
      ) {

        return res.status(404)
          .json({
            error:
              "Session not connected"
          });
      }

      const jid =
        normalizeJid(to);

      await session.sock.sendMessage(
        jid,
        { text }
      );

      console.log(
        `📤 Sent to ${jid}`
      );

      res.json({
        success: true
      });

    } catch (err: any) {

      console.error(
        "❌ Send failed:",
        err
      );

      res.status(500)
        .json({
          error:
            err?.message ||
            "Send failed"
        });
    }
  }
);

// ========================
// SEND REPLY FROM BACKEND
// ========================

app.post(
  "/send-reply",
  async (req, res) => {
    try {
      const { userId, to, text } = req.body;

      if (!userId || !to || !text) {
        return res.status(400).json({ error: "Missing fields" });
      }

      const session = sessions[userId];

      if (!session?.connected) {
        return res.status(400).json({ 
          error: "Session not connected" 
        });
      }

      const jid = normalizeJid(to);

      await session.sock.sendMessage(jid, { text });

      console.log(`📤 Reply sent to ${jid}: ${text.substring(0, 50)}...`);

      res.json({ success: true });
   } catch (err) {
  const errorMessage = err instanceof Error 
    ? err.message 
    : String(err);

  console.error("❌ Webhook error:", errorMessage);
  
  res.status(500).json({ 
    success: false, 
    error: "Internal server error" 
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

      } catch {}

      delete sessions[userId];
    }

    res.json({
      success: true
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
      status: "ok"
    });
  }
);

// ========================
// SHUTDOWN
// ========================

process.on(
  "SIGTERM",
  async () => {

    console.log(
      "SIGTERM received"
    );

    for (
      const userId in sessions
    ) {

      try {

        await sessions[userId]
          .sock?.logout();

      } catch {}
    }

    process.exit(0);
  }
);

// ========================
// START
// ========================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `🚀 Gateway on ${PORT}`
    );
  }
);
