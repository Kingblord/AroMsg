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

const SESSIONS_DIR = path.join(process.cwd(), "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });

const sessions: any = {};

// ========================
// SIMPLE SEND FUNCTION
// ========================

async function sendWhatsAppMessage(userId: string, to: string, text: string, source: string) {
  const session = sessions[userId];
  if (!session?.sock) {
    console.log(`❌ No active session for ${userId}`);
    return false;
  }

  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
  console.log(`🔄 [${new Date().toISOString()}] ${source} → Trying to send to ${jid}`);

  try {
    const result = await session.sock.sendMessage(jid, { text });
    console.log(`✅ [${new Date().toISOString()}] ${source} → Baileys accepted the message`);
    console.log(`📨 Message Key:`, result?.key?.id);
    return true;
  } catch (err: any) {
    console.error(`❌ Send failed:`, err.message || err);
    return false;
  }
}

// ========================
// CREATE SESSION
// ========================

async function createSession(userId: string) {
  const authPath = path.join(SESSIONS_DIR, userId);
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
  });

  sessions[userId] = { sock, connected: false };

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, qr } = update;
    if (qr) console.log(`📱 QR for ${userId}`);
    if (connection === "open") {
      sessions[userId].connected = true;
      console.log(`✅ Connected: ${userId}`);
    }
  });

  // Simple message handler
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (msg.key.fromMe || !msg.message) return;

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (!text) return;

    const from = msg.key.remoteJid!;
    console.log(`📨 Received: ${text} from ${from}`);

    // Forward to backend
    axios.post(`${BACKEND_URL}/webhook`, {
      userId, from, text, platform: "whatsapp"
    }, { headers: { Authorization: `Bearer ${INTERNAL_API_KEY}` } })
    .catch(() => {});
  });
}

// ========================
// ROUTES
// ========================

app.post("/send-reply", async (req, res) => {
  console.log(`🔄 /send-reply called from backend`);
  const { userId, to, text } = req.body;
  const success = await sendWhatsAppMessage(userId, to, text, "Backend");
  res.json({ success });
});

app.post("/send-message", async (req, res) => {
  const { userId, to, text } = req.body;
  const success = await sendWhatsAppMessage(userId, to, text, "External");
  res.json({ success });
});

app.post("/connect", async (req, res) => {
  const { userId } = req.body;
  if (!sessions[userId]) await createSession(userId);
  res.json({ success: true });
});

app.get("/health", (_, res) => res.json({ status: "ok" }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Gateway on ${PORT}`);
});
