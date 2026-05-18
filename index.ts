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

const PORT = Number(process.env.PORT) || 3001;
const BACKEND_URL = process.env.BACKEND_URL;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

if (!BACKEND_URL || !INTERNAL_API_KEY) {
  console.error("❌ Missing BACKEND_URL or INTERNAL_API_KEY in .env");
  process.exit(1);
}

// ========================
// SESSION STORAGE
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
const processedMessages = new Set<string>();

// ========================
// HELPERS
// ========================

function normalizeJid(jid: string) {
  if (!jid) return jid;
  if (jid.endsWith("@s.whatsapp.net")) return jid;
  if (jid.endsWith("@lid")) return `${jid.replace("@lid", "")}@s.whatsapp.net`;
  if (!jid.includes("@")) return `${jid}@s.whatsapp.net`;
  return jid;
}

// ========================
// IMPROVED SEND MESSAGE WITH DETAILED LOGS
// ========================

async function sendMessage(session: any, jid: string, text: string, source: string = "unknown") {
  console.log(`🔄 [${new Date().toISOString()}] ${source} → Attempting to send to ${jid}`);
  console.log(`📝 Message: \( {text.substring(0, 100)} \){text.length > 100 ? '...' : ''}`);

  try {
    const result = await session.sock.sendMessage(jid, { 
      text 
    }, {
      linkPreview: false,
    });

    console.log(`✅ [${new Date().toISOString()}] ${source} → Message SENT SUCCESSFULLY to ${jid}`);
    console.log(`📨 Message ID: ${result?.key?.id || 'N/A'}`);
    return result;
  } catch (err: any) {
    console.error(`❌ [${new Date().toISOString()}] ${source} → Send FAILED to ${jid}`);
    console.error(`Error: ${err.message || err}`);
    throw err;
  }
}

// ========================
// CREATE SESSION
// ========================

async function createSession(userId: string) {
  try {
    const authPath = path.join(SESSIONS_DIR, userId);
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      auth: state,
      version,
      logger: P({ level: "silent" }),
      printQRInTerminal: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 5000,
    });

    sessions[userId] = { sock, connected: false, reconnecting: false };

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        sessions[userId].qr = await QRCode.toDataURL(qr);
        console.log(`📱 [${new Date().toISOString()}] QR Generated for ${userId}`);
      }

      if (connection === "open") {
        sessions[userId].connected = true;
        sessions[userId].reconnecting = false;
        sessions[userId].phoneNumber = sock.user?.id?.split(":")[0] || "";
        console.log(`✅ [${new Date().toISOString()}] Connected successfully: ${userId}`);
      }

      if (connection === "close") {
        sessions[userId].connected = false;
        console.log(`❌ [${new Date().toISOString()}] Disconnected: ${userId}`);
      }
    });

    // Incoming Messages → Backend
    sock.ev.on("messages.upsert", async ({ messages }) => {
      try {
        const msg = messages[0];
        if (!msg?.message || msg.key.fromMe || msg.broadcast || msg.messageStubType) return;

        const from = msg.key.remoteJid;
        if (!from || from === "status@broadcast" || from.endsWith("@g.us")) return;

        const text = msg.message.conversation || 
                    msg.message.extendedTextMessage?.text ||
                    msg.message.imageMessage?.caption ||
                    msg.message.videoMessage?.caption;

        if (!text?.trim()) return;

        const normalizedFrom = normalizeJid(from);
        console.log(`📨 [${new Date().toISOString()}] Received from ${normalizedFrom}: ${text}`);

        setImmediate(() => {
          axios.post(`${BACKEND_URL}/webhook`, {
            userId, 
            from: normalizedFrom, 
            text, 
            platform: "whatsapp",
            messageId: msg.key.id,
            timestamp: Date.now()
          }, {
            headers: { Authorization: `Bearer ${INTERNAL_API_KEY}` },
            timeout: 15000
          }).catch(err => console.error("❌ Backend webhook failed:", err?.message));
        });
      } catch (err) {
        console.error("❌ Message processing error:", err);
      }
    });
  } catch (err) {
    console.error(`❌ Session failed for ${userId}:`, err);
  }
}

// ========================
// ROUTES WITH DETAILED LOGGING
// ========================

app.post("/send-message", async (req, res) => {
  console.log(`🔄 [${new Date().toISOString()}] /send-message endpoint HIT from external call`);
  try {
    const { userId, to, text } = req.body;
    if (!userId || !to || !text) {
      console.log(`⚠️ Missing fields in /send-message`);
      return res.status(400).json({ error: "Missing fields" });
    }

    const session = sessions[userId];
    if (!session?.connected) {
      console.log(`⚠️ Session ${userId} not connected`);
      return res.status(400).json({ error: "Session not connected" });
    }

    await sendMessage(session, normalizeJid(to), text, "External /send-message");
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Send failed" });
  }
});

app.post("/send-reply", async (req, res) => {
  console.log(`🔄 [${new Date().toISOString()}] /send-reply endpoint HIT from Backend`);
  try {
    const { userId, to, text } = req.body;
    if (!userId || !to || !text) {
      console.log(`⚠️ Missing fields in /send-reply`);
      return res.status(400).json({ error: "Missing fields" });
    }

    const session = sessions[userId];
    if (!session?.connected) {
      console.log(`⚠️ Session ${userId} not connected when trying to send reply`);
      return res.status(400).json({ error: "Session not connected" });
    }

    await sendMessage(session, normalizeJid(to), text, "Backend /send-reply");
    res.json({ success: true });
  } catch (err: any) {
    console.error(`❌ [${new Date().toISOString()}] Send reply failed:`, err.message);
    res.status(500).json({ error: err?.message || "Send failed" });
  }
});

// Other routes...
app.post("/connect", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  if (!sessions[userId]) await createSession(userId);
  res.json({ success: true });
});

app.get("/qr/:userId", (req, res) => {
  const session = sessions[req.params.userId];
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({ qr: session.qr, connected: session.connected });
});

app.get("/status/:userId", (req, res) => {
  const session = sessions[req.params.userId];
  res.json({ connected: !!session?.connected, phoneNumber: session?.phoneNumber || null });
});

app.post("/disconnect", async (req, res) => {
  const { userId } = req.body;
  if (sessions[userId]) {
    try { await sessions[userId].sock.logout(); } catch {}
    delete sessions[userId];
  }
  res.json({ success: true });
});

app.get("/health", (_, res) => res.json({ status: "ok" }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Gateway running on port ${PORT}`);
});
