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

function normalizeJid(jid: string): string {
  if (!jid) return jid;
  
  // Clean up any extra spaces or hidden characters
  let cleanJid = jid.trim();

  // If it's an LID identifier, map it properly
  if (cleanJid.endsWith("@lid")) {
    cleanJid = `${cleanJid.replace("@lid", "")}@s.whatsapp.net`;
  }
  
  // If it's a malformed whatsapp suffix (like @s.whatsapp missing .net)
  if (cleanJid.endsWith("@s.whatsapp")) {
    cleanJid = `${cleanJid}.net`;
  }

  // If it's a group JID, let it pass through unaltered
  if (cleanJid.endsWith("@g.us")) {
    return cleanJid;
  }

  // If there's no domain suffix at all, add the default one
  if (!cleanJid.includes("@")) {
    return `${cleanJid}@s.whatsapp.net`;
  }

  return cleanJid;
}


// ========================
// ENHANCED SEND MESSAGE
// ========================

async function sendMessage(session: any, jid: string, text: string, source: string = "Unknown") {
  const timestamp = new Date().toISOString();
  console.log(`🔄 [${timestamp}] ${source} → START sending to ${jid}`);
  console.log(`📝 [${timestamp}] Message: \( {text.substring(0, 100)} \){text.length > 100 ? '...' : ''}`);

  try {
    const result = await session.sock.sendMessage(jid, { 
      text 
    }, {
      linkPreview: false,
      ephemeralExpiration: undefined,
    });

    console.log(`✅ [${timestamp}] ${source} → MESSAGE SENT SUCCESSFULLY to ${jid}`);
    console.log(`📨 [${timestamp}] Message ID: ${result?.key?.id || 'N/A'}`);
    return result;
  } catch (err: any) {
    console.error(`❌ [${timestamp}] ${source} → SEND FAILED to ${jid}`);
    console.error(`Error: ${err.message || err}`);
    throw err;
  }
}

// ========================
// CREATE SESSION (Kept Original Logic)
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
      defaultQueryTimeoutMs: undefined,
    });

    sessions[userId] = { sock, connected: false, reconnecting: false };

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        sessions[userId].qr = await QRCode.toDataURL(qr);
        console.log(`📱 QR Generated: ${userId}`);
      }

      if (connection === "open") {
        sessions[userId].connected = true;
        sessions[userId].reconnecting = false;
        sessions[userId].phoneNumber = sock.user?.id?.split(":")[0] || "";
        console.log(`✅ Connected: ${userId}`);
      }

      if (connection === "close") {
        sessions[userId].connected = false;
        console.log(`❌ Disconnected: ${userId}`);

        const shouldReconnect = (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect && !sessions[userId]?.reconnecting) {
          sessions[userId].reconnecting = true;
          delete sessions[userId];
          setTimeout(() => createSession(userId), 8000);
        }
      }
    });

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

        const messageId = msg.key.id || "";
        if (processedMessages.has(messageId)) return;
        processedMessages.add(messageId);
        setTimeout(() => processedMessages.delete(messageId), 60000);

        const normalizedFrom = normalizeJid(from);
        console.log(`📨 [${new Date().toISOString()}] Received from ${normalizedFrom}: ${text}`);

        setImmediate(() => {
          axios.post(`${BACKEND_URL}/webhook`, {
            userId, 
            from: normalizedFrom, 
            text, 
            platform: "whatsapp",
            messageId, 
            timestamp: Date.now()
          }, {
            headers: { Authorization: `Bearer ${INTERNAL_API_KEY}` },
            timeout: 15000
          }).catch(err => console.error("❌ Backend webhook failed:", err?.message));
        });
      } catch (err) {
        console.error("❌ Message error:", err);
      }
    });
  } catch (err) {
    console.error(`❌ Session failed: ${userId}`, err);
  }
}

// ========================
// ROUTES
// ========================

app.post("/connect", async (req, res) => {
  console.log(`🔄 [${new Date().toISOString()}] POST /connect called`);
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  if (!sessions[userId]) await createSession(userId);
  res.json({ success: true });
});

app.get("/qr/:userId", (req, res) => {
  console.log(`🔄 [\( {new Date().toISOString()}] GET /qr/ \){req.params.userId}`);
  const session = sessions[req.params.userId];
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({ qr: session.qr, connected: session.connected });
});

app.get("/status/:userId", (req, res) => {
  console.log(`🔄 [\( {new Date().toISOString()}] GET /status/ \){req.params.userId}`);
  const session = sessions[req.params.userId];
  res.json({ 
    connected: !!session?.connected, 
    phoneNumber: session?.phoneNumber || null 
  });
});

app.post("/send-message", async (req, res) => {
  console.log(`🔄 [${new Date().toISOString()}] POST /send-message received`);
  try {
    const { userId, to, text } = req.body;
    if (!userId || !to || !text) return res.status(400).json({ error: "Missing fields" });

    const session = sessions[userId];
    if (!session?.connected) return res.status(400).json({ error: "Session not connected" });

    await sendMessage(session, normalizeJid(to), text, "External /send-message");
    res.json({ success: true });
  } catch (err: any) {
    console.error("❌ /send-message failed:", err);
    res.status(500).json({ error: err?.message || "Send failed" });
  }
});

app.post("/send-reply", async (req, res) => {
  console.log(`🔄 [${new Date().toISOString()}] POST /send-reply received FROM BACKEND`);
  try {
    const { userId, to, text } = req.body;
    if (!userId || !to || !text) return res.status(400).json({ error: "Missing fields" });

    const session = sessions[userId];
    if (!session?.connected) return res.status(400).json({ error: "Session not connected" });

    await sendMessage(session, normalizeJid(to), text, "Backend /send-reply");
    res.json({ success: true });
  } catch (err: any) {
    console.error("❌ /send-reply failed:", err);
    res.status(500).json({ error: err?.message || "Send failed" });
  }
});

app.post("/disconnect", async (req, res) => {
  console.log(`🔄 [${new Date().toISOString()}] POST /disconnect called`);
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
