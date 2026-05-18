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
  Browsers,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";

import { Boom } from "@hapi/boom";
import P from "pino";
import QRCode from "qrcode";
import NodeCache from "@cacheable/node-cache";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT) || 3001;
const BACKEND_URL = process.env.BACKEND_URL;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

if (!BACKEND_URL || !INTERNAL_API_KEY) {
  console.error("❌ Missing BACKEND_URL or INTERNAL_API_KEY in .env");
  process.exit(1);
}

// ========================
// CONFIG & SESSION STORAGE
// ========================

const SESSIONS_DIR = path.join(process.cwd(), "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });

interface SessionData {
  sock: any;
  qr?: string;
  connected: boolean;
  reconnecting: boolean;
  phoneNumber?: string;
}

const sessions: Record<string, SessionData> = {};
const msgRetryCounterCache = new NodeCache({ stdTTL: 60 * 60 * 24 }); // 24h
const processedMessages = new Set<string>();

// Rate limiting per user to prevent spam (AI responses)
const responseCooldown = new Map<string, number>(); // JID -> last response timestamp
const COOLDOWN_MS = 3000; // Minimum 3 seconds between auto-replies

// ========================
// HELPERS
// ========================

function normalizeJid(jid: string): string {
  if (!jid) return jid;
  let clean = jid.trim().split("@")[0].split(":")[0];
  if (jid.endsWith("@lid")) clean = clean.replace("@lid", "");
  return `${clean}@s.whatsapp.net`;
}

function getPhoneNumber(jid: string): string {
  if (!jid) return "";
  return jid.split("@")[0].split(":")[0].replace(/\D/g, "");
}

function isPersonalChat(jid: string): boolean {
  return jid.endsWith("@s.whatsapp.net") && !jid.includes("-");
}

// ========================
// SEND MESSAGE (Improved)
// ========================

async function sendMessage(
  session: any,
  jid: string,
  text: string,
  source: string = "Unknown"
) {
  const timestamp = new Date().toISOString();
  const phone = getPhoneNumber(jid);

  console.log(`🔄 [${timestamp}] ${source} → Sending to ${phone}`);

  try {
    const result = await session.sock.sendMessage(
      jid,
      { text },
      { linkPreview: false }
    );

    console.log(`✅ [${timestamp}] ${source} → Sent to ${phone}`);
    return result;
  } catch (err: any) {
    console.error(`❌ [${timestamp}] ${source} → Failed to ${phone}:`, err.message || err);
    throw err;
  }
}

// ========================
// CREATE SESSION (Best Practices)
// ========================

async function createSession(userId: string) {
  try {
    const authPath = path.join(SESSIONS_DIR, userId);
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: P({ level: "silent" }), // Change to "trace" for debugging
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, P({ level: "silent" })),
      },
      browser: Browsers.ubuntu("Sales Bot"),
      markOnlineOnConnect: false, // Less detectable
      msgRetryCounterCache,
      generateHighQualityLinkPreview: true,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 5000,
    });

    sessions[userId] = { sock, connected: false, reconnecting: false };

    // Save credentials
    sock.ev.on("creds.update", saveCreds);

    // Use process() for efficient batch handling (recommended)
    sock.ev.process(async (events) => {
      // Connection updates
      if (events["connection.update"]) {
        const update = events["connection.update"];
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
          try {
            sessions[userId].qr = await QRCode.toDataURL(qr);
            console.log(`📱 QR Generated for ${userId}`);
          } catch (e) {
            console.error("QR generation failed", e);
          }
        }

        if (connection === "open") {
          sessions[userId].connected = true;
          sessions[userId].reconnecting = false;
          sessions[userId].phoneNumber = sock.user?.id?.split(":")[0] || "";
          console.log(`✅ Connected: \( {userId} ( \){sessions[userId].phoneNumber})`);
        }

        if (connection === "close") {
          sessions[userId].connected = false;
          console.log(`❌ Disconnected: ${userId}`);

          const shouldReconnect =
            (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;

          if (shouldReconnect && !sessions[userId]?.reconnecting) {
            sessions[userId].reconnecting = true;
            console.log(`🔄 Reconnecting ${userId} in 8s...`);
            setTimeout(() => createSession(userId), 8000);
          }
        }
      }

      // Messages
      if (events["messages.upsert"]) {
        const upsert = events["messages.upsert"];
        if (upsert.type !== "notify") return;

        for (const msg of upsert.messages) {
          if (
            msg.key.fromMe ||
            msg.broadcast ||
            msg.messageStubType ||
            !msg.message
          )
            continue;

          const from = msg.key.remoteJid!;
          if (!from || from === "status@broadcast" || from.endsWith("@g.us")) continue;

          // Extract text
          const text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            "";

          if (!text?.trim()) continue;

          const messageId = msg.key.id!;
          if (processedMessages.has(messageId)) continue;
          processedMessages.add(messageId);
          setTimeout(() => processedMessages.delete(messageId), 120000);

          const normalizedFrom = normalizeJid(from);
          const phone = getPhoneNumber(normalizedFrom);

          console.log(`📨 Received from ${phone}: ${text.substring(0, 100)}`);

          // AI Sales Bot Logic - Only respond to personal chats, with cooldown
          if (isPersonalChat(normalizedFrom)) {
            const now = Date.now();
            const lastResponse = responseCooldown.get(normalizedFrom) || 0;

            if (now - lastResponse > COOLDOWN_MS) {
              responseCooldown.set(normalizedFrom, now);

              // Forward to backend for AI processing
              setImmediate(() => {
                axios
                  .post(
                    `${BACKEND_URL}/webhook`,
                    {
                      userId,
                      from: normalizedFrom,
                      text,
                      platform: "whatsapp",
                      messageId,
                      timestamp: Date.now(),
                    },
                    {
                      headers: { Authorization: `Bearer ${INTERNAL_API_KEY}` },
                      timeout: 15000,
                    }
                  )
                  .catch((err) =>
                    console.error("❌ Backend webhook failed:", err?.message)
                  );
              });
            } else {
              console.log(`⏳ Cooldown active for ${phone}, skipping AI response`);
            }
          }
        }
      }
    });
  } catch (err) {
    console.error(`❌ Session creation failed for ${userId}:`, err);
  }
}

// ========================
// ROUTES
// ========================

app.post("/connect", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  if (!sessions[userId]) {
    await createSession(userId);
  }
  res.json({ success: true });
});

app.get("/qr/:userId", (req, res) => {
  const session = sessions[req.params.userId];
  if (!session) return res.status(404).json({ error: "Session not found" });

  res.json({
    qr: session.qr,
    connected: session.connected,
    phoneNumber: session.phoneNumber,
  });
});

app.get("/status/:userId", (req, res) => {
  const session = sessions[req.params.userId];
  res.json({
    connected: !!session?.connected,
    phoneNumber: session?.phoneNumber || null,
  });
});

app.post("/send-message", async (req, res) => {
  try {
    const { userId, to, text } = req.body;
    if (!userId || !to || !text) return res.status(400).json({ error: "Missing fields" });

    const session = sessions[userId];
    if (!session?.connected) return res.status(400).json({ error: "Session not connected" });

    await sendMessage(session, normalizeJid(to), text, "External API");
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Send failed" });
  }
});

app.post("/send-reply", async (req, res) => {
  try {
    const { userId, to, text } = req.body;
    if (!userId || !to || !text) return res.status(400).json({ error: "Missing fields" });

    const session = sessions[userId];
    if (!session?.connected) return res.status(400).json({ error: "Session not connected" });

    await sendMessage(session, normalizeJid(to), text, "AI Backend");
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Send failed" });
  }
});

app.post("/disconnect", async (req, res) => {
  const { userId } = req.body;
  if (sessions[userId]) {
    try {
      await sessions[userId].sock.logout();
    } catch {}
    delete sessions[userId];
  }
  res.json({ success: true });
});

app.get("/health", (_, res) => res.json({ status: "ok" }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 WhatsApp AI Sales Bot Gateway running on port ${PORT}`);
});
