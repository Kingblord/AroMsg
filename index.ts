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
const AI_BACKEND_URL = process.env.AI_BACKEND_URL; // e.g. https://yourapp.vercel.app

if (!AI_BACKEND_URL) {
  console.warn("[gateway] WARNING: AI_BACKEND_URL is not set — webhooks will not be forwarded");
}

// Ensure sessions directory exists
mkdirSync("sessions", { recursive: true });

// In-memory session store
interface SessionData {
  sock: any;
  qr?: string;
  connected: boolean;
  phoneNumber?: string;
  reconnecting?: boolean;
}

const sessions: Record<string, SessionData> = {};

// ========================
// FORWARD MESSAGE TO BACKEND WEBHOOK
// ========================
async function forwardToBackend(payload: {
  userId: string;
  from: string;
  text: string;
  messageId?: string;
  timestamp?: number;
  platform: string;
}) {
  if (!AI_BACKEND_URL) {
    console.warn("[gateway] AI_BACKEND_URL not set, skipping webhook forward");
    return;
  }

  const webhookUrl = `${AI_BACKEND_URL}/api/whatsapp/webhook`;

  try {
    await axios.post(
      webhookUrl,
      { ...payload },
      {
        timeout: 15000,
        headers: { "Content-Type": "application/json" },
      }
    );
    console.log(`[gateway] Forwarded message from ${payload.from} to backend`);
  } catch (err: any) {
    console.error(
      `[gateway] Failed to forward webhook to ${webhookUrl}:`,
      err?.response?.data || err?.message || err
    );
  }
}

// ========================
// CREATE / RESTORE SESSION
// ========================
async function createSession(userId: string) {
  // Prevent duplicate session creation
  if (sessions[userId]?.reconnecting) return;

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

    sessions[userId] = { sock, connected: false };

    // Persist credentials
    sock.ev.on("creds.update", saveCreds);

    // Connection lifecycle
    sock.ev.on("connection.update", async (update) => {
      const { connection, qr, lastDisconnect } = update;

      // New QR code available — convert to data URL
      if (qr) {
        // Always overwrite with the freshest QR — Baileys emits a new one
        // every ~20s and after a failed scan attempt. Never serve stale QR.
        const qrImage = await QRCode.toDataURL(qr);
        sessions[userId].qr = qrImage;
        console.log(`[gateway] QR refreshed for user: ${userId}`);
      }

      if (connection === "open") {
        sessions[userId].connected = true;
        sessions[userId].reconnecting = false;
        sessions[userId].phoneNumber =
          sock.user?.id?.split(":")[0] ||
          sock.user?.id ||
          "";
        console.log(
          `[gateway] Connected: ${userId} | ${sessions[userId].phoneNumber}`
        );
      }

      if (connection === "close") {
        sessions[userId].connected = false;

        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(
          `[gateway] Disconnected: ${userId} | code: ${statusCode} | reconnect: ${shouldReconnect}`
        );

        if (shouldReconnect) {
          sessions[userId].reconnecting = true;
          console.log(`[gateway] Reconnecting ${userId} in 3s…`);
          setTimeout(() => createSession(userId), 3_000);
        } else {
          // Logged out — clean up session data but keep entry so status returns correctly
          sessions[userId].qr = undefined;
          sessions[userId].reconnecting = false;
        }
      }
    });

    // Incoming message handler
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      // Only handle new messages, not history syncs
      if (type !== "notify") return;

      const msg = messages[0];
      if (!msg?.message || !msg.key.remoteJid) return;

      // Ignore group messages
      if (msg.key.remoteJid.endsWith("@g.us")) return;

      // Ignore messages sent by us (fromMe)
      if (msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";

      if (!text.trim()) return;

      console.log(`[gateway] Incoming message from ${from}: ${text}`);

      // Forward to Next.js backend webhook
      await forwardToBackend({
        userId,
        from,
        text,
        messageId: msg.key.id ?? undefined,
        timestamp: Number(msg.messageTimestamp) * 1000, // ms
        platform: "whatsapp",
      });
    });
  } catch (err) {
    console.error(`[gateway] Failed to create session for ${userId}:`, err);
    if (sessions[userId]) {
      sessions[userId].reconnecting = false;
    }
  }
}

// ========================
// ROUTES
// ========================

// POST /connect — create or restore session
app.post("/connect", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  if (!sessions[userId]) {
    // Fresh session
    await createSession(userId);
  } else if (sessions[userId].connected) {
    // Already connected — nothing to do
    return res.json({ success: true, message: "Already connected", connected: true });
  } else {
    // Session exists but not connected — clear stale QR and force a fresh session
    // (a scanned-but-failed QR is single-use; Baileys will emit a new one)
    sessions[userId].qr = undefined;
    sessions[userId].reconnecting = false;
    // Close existing socket cleanly before reinitialising
    try { sessions[userId].sock?.end(undefined); } catch { /* ignore */ }
    delete sessions[userId];
    await createSession(userId);
  }

  res.json({ success: true, message: "Session initialised" });
});

// GET /qr/:userId — return QR code image as data URL
// Waits up to 15s for QR to be generated (handles the async race)
app.get("/qr/:userId", async (req, res) => {
  const { userId } = req.params;
  const session = sessions[userId];

  if (!session) {
    return res.status(404).json({ error: "Session not found. Call /connect first." });
  }

  // Already connected — no QR needed
  if (session.connected) {
    return res.json({ qr: null, connected: true, phoneNumber: session.phoneNumber || null });
  }

  // QR already ready — return immediately
  if (session.qr) {
    return res.json({ qr: session.qr, connected: false, phoneNumber: null });
  }

  // QR not ready yet — wait up to 15s for it to appear (Baileys fires it async)
  const maxWaitMs = 15_000;
  const intervalMs = 250;
  let waited = 0;

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      waited += intervalMs;
      if (sessions[userId]?.qr || sessions[userId]?.connected || waited >= maxWaitMs) {
        clearInterval(check);
        resolve();
      }
    }, intervalMs);
  });

  const updated = sessions[userId];
  res.json({
    qr: updated?.qr || null,
    connected: updated?.connected || false,
    phoneNumber: updated?.phoneNumber || null,
  });
});

// GET /status/:userId — check connection state
app.get("/status/:userId", (req, res) => {
  const { userId } = req.params;
  const session = sessions[userId];

  if (!session) {
    return res.json({ connected: false, status: "no_session", phoneNumber: null });
  }

  res.json({
    connected: session.connected,
    // Return both field names so clients checking either shape get correct data
    status: session.connected ? "connected" : "disconnected",
    phoneNumber: session.phoneNumber || null,
    phone: session.phoneNumber || null,
  });
});

// POST /send-message — send a WhatsApp message from the connected session
app.post("/send-message", async (req, res) => {
  try {
    // Accept both `text` and `message` field names for compatibility
    const { userId, to, text, message } = req.body;
    const body = text || message;

    if (!userId || !to || !body) {
      return res.status(400).json({ error: "Missing required fields: userId, to, text" });
    }

    const session = sessions[userId];
    if (!session?.sock) {
      return res.status(404).json({ error: "Session not found" });
    }
    if (!session.connected) {
      return res.status(400).json({ error: "Session not connected. Scan QR first." });
    }

    // Normalise JID — add @s.whatsapp.net if raw number
    const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;

    await session.sock.sendMessage(jid, { text: body });
    res.json({ success: true, to: jid });
  } catch (err: any) {
    console.error("[gateway] Send message error:", err);
    res.status(500).json({ error: err.message || "Send failed" });
  }
});

// POST /disconnect — log out and remove session
app.post("/disconnect", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  const session = sessions[userId];
  if (session) {
    try {
      await session.sock.logout();
    } catch {
      // Already disconnected
    }
    delete sessions[userId];
  }

  res.json({ success: true });
});

// GET /health — uptime check
app.get("/health", (_, res) =>
  res.json({
    status: "ok",
    sessions: Object.keys(sessions).length,
    backendUrl: AI_BACKEND_URL || "NOT SET",
    authenticated: false,
  })
);

app.listen(PORT, () => {
  console.log(`[gateway] WhatsApp Gateway running on port ${PORT}`);
  console.log(`[gateway] Forwarding webhooks to: ${AI_BACKEND_URL}/api/whatsapp/webhook`);
});
