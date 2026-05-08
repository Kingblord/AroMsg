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

const PORT = process.env.PORT || 3001;
const AI_BACKEND_URL = process.env.AI_BACKEND_URL;

if (!AI_BACKEND_URL) {
  console.warn("⚠️ AI_BACKEND_URL is not set");
}

// Ensure sessions directory exists
mkdirSync("sessions", { recursive: true });

// In-memory session store
interface SessionData {
  sock: any;
  qr?: string;
  connected: boolean;
  phoneNumber?: string;
}

const sessions: Record<string, SessionData> = {};

// ========================
// CREATE / RESTORE SESSION
// ========================
async function createSession(userId: string) {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(`sessions/${userId}`);

    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      auth: state,
      version,
      logger: P({ level: "silent" }),
      printQRInTerminal: false,
      // Better reconnection settings
      reconnectInterval: 5000,
      keepAliveIntervalMs: 30000,
    });

    sessions[userId] = { sock, connected: false };

    // Save credentials
    sock.ev.on("creds.update", saveCreds);

    // Connection events
    sock.ev.on("connection.update", async (update) => {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        const qrImage = await QRCode.toDataURL(qr);
        sessions[userId].qr = qrImage;
        console.log(`📱 QR generated for user: ${userId}`);
      }

      if (connection === "open") {
        sessions[userId].connected = true;
        sessions[userId].phoneNumber = sock.user?.id?.split(":")[0] || "";
        console.log(`✅ Connected: ${userId} | ${sessions[userId].phoneNumber}`);
      }

      if (connection === "close") {
        sessions[userId].connected = false;
        const shouldReconnect =
          (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;

        console.log(`❌ Disconnected: ${userId}`);

        if (shouldReconnect) {
          console.log(`🔄 Reconnecting ${userId}...`);
          setTimeout(() => createSession(userId), 2000);
        }
      }
    });

    // Message handler
    sock.ev.on("messages.upsert", async ({ messages }) => {
      const msg = messages[0];
      if (!msg.message || !msg.key.remoteJid) return;

      const from = msg.key.remoteJid;
      if (from.endsWith("@g.us")) return; // Ignore groups

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption;

      if (!text) return;

      console.log(`📨 Message from ${from}: ${text}`);

      try {
        await axios.post(`${AI_BACKEND_URL}/webhook`, {
          userId,
          from,
          text,
          platform: "whatsapp",
          messageId: msg.key.id,
          timestamp: msg.messageTimestamp,
        });
      } catch (err) {
        console.error("❌ Failed to forward to backend:", err);
      }
    });
  } catch (err) {
    console.error(`Failed to create session for ${userId}:`, err);
  }
}

// ========================
// ROUTES
// ========================

// Connect / Restore session
app.post("/connect", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  if (!sessions[userId]) {
    await createSession(userId);
  }

  res.json({ success: true });
});

// Get QR Code
app.get("/qr/:userId", (req, res) => {
  const { userId } = req.params;
  const session = sessions[userId];

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  res.json({
    qr: session.qr,
    connected: session.connected,
  });
});

// Get status
app.get("/status/:userId", (req, res) => {
  const { userId } = req.params;
  const session = sessions[userId];

  res.json({
    connected: session?.connected || false,
    phoneNumber: session?.phoneNumber || null,
  });
});

// Send message
app.post("/send-message", async (req, res) => {
  try {
    const { userId, to, text } = req.body;

    if (!userId || !to || !text) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const session = sessions[userId];
    if (!session?.sock) {
      return res.status(404).json({ error: "Session not found" });
    }

    await session.sock.sendMessage(to, { text });

    res.json({ success: true });
  } catch (err: any) {
    console.error("Send message error:", err);
    res.status(500).json({ error: err.message || "Send failed" });
  }
});

// Disconnect
app.post("/disconnect", async (req, res) => {
  const { userId } = req.body;
  const session = sessions[userId];

  if (session) {
    try {
      await session.sock.logout();
    } catch (e) {
      console.error("Logout error:", e);
    }
    delete sessions[userId];
  }

  res.json({ success: true });
});

// Health check
app.get("/health", (_, res) => res.json({ status: "ok" }));

// Start server
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp Gateway running on port ${PORT}`);
});
