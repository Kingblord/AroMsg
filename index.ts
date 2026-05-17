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
    console.warn("⚠️  Firebase env vars missing — session persistence disabled");
  } else {
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey } as admin.ServiceAccount),
      projectId,
    });
    console.log("🔥 Firebase Admin initialised");
  }
}

const db = admin.apps.length ? admin.firestore() : null;

// ========================
// UTILITIES
// ========================

/** Normalize JID to always be @s.whatsapp.net format */
function normalizeJid(jid: string): string {
  if (!jid) return jid;
  if (jid.endsWith("@s.whatsapp.net")) return jid;
  if (jid.endsWith("@lid")) return `${jid.replace("@lid", "")}@s.whatsapp.net`;
  if (!jid.includes("@")) return `${jid}@s.whatsapp.net`;
  return jid;
}

// ========================
// PERSISTENCE
// ========================

/** Save session auth state to Firestore for persistence across restarts */
async function saveSessionState(userId: string, authPath: string): Promise<void> {
  if (!db) return;
  try {
    const fs = await import("fs").then(m => m.promises);
    const state = await fs.readdir(authPath).then(() => true).catch(() => false);
    if (state) {
      await db.collection("gateway_sessions").doc(userId).set(
        { updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    }
  } catch (err) {
    console.error(`[session] Save state failed for ${userId}:`, err);
  }
}

// ========================
// EXPRESS SETUP
// ========================

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT) || 3001;
const BACKEND_URL = process.env.BACKEND_URL;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

if (!BACKEND_URL) console.warn("⚠️ BACKEND_URL missing");
if (!INTERNAL_API_KEY) console.warn("⚠️ INTERNAL_API_KEY missing");

mkdirSync("sessions", { recursive: true });

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

const sessions: Record<string, SessionData> = {};

// ========================
// WHATSAPP SESSION CREATION
// ========================

async function createSession(userId: string) {
  const authPath = `sessions/${userId}`;

  try {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    const sock = makeWASocket({
      version,
      logger: P({ level: "silent" }),
      printQRInTerminal: false,
      auth: state,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: false,
    });

    // ─── Connection Status ───────────────────────────────────────────────

    sock.ev.on("connection.update", async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrString = await QRCode.toDataURL(qr);
        sessions[userId].qr = qrString;
        console.log(`[${userId}] New QR code generated`);
      }

      // CONNECTED
      if (connection === "open") {
        sessions[userId].connected = true;
        sessions[userId].reconnecting = false;
        sessions[userId].phoneNumber = sock.user?.id?.split(":")[0] || "";
        sessions[userId].qr = undefined;
        console.log(`✅ Connected: ${userId}`);
        await saveSessionState(userId, authPath);
      }

      // DISCONNECTED
      if (connection === "close") {
        sessions[userId].connected = false;
        const shouldReconnect =
          (lastDisconnect?.error as any)?.output?.statusCode !==
          DisconnectReason.loggedOut;

        console.log(`❌ Disconnected: ${userId}`);

        if (!shouldReconnect) {
          // Logged out — clean up
          delete sessions[userId];
          console.log(`🗑️  Session deleted: ${userId}`);
        } else if (!sessions[userId]?.reconnecting) {
          sessions[userId].reconnecting = true;
          console.log(`🔄 Reconnecting in 5s: ${userId}`);
          setTimeout(() => createSession(userId), 5000);
        }
      }
    });

    // ─── Incoming Messages ───────────────────────────────────────────────

    sock.ev.on("messages.upsert", async (m: any) => {
      if (m.type !== "notify") return;

      for (const msg of m.messages) {
        // Filter out system messages
        if (msg.messageStubType || msg.fromMe || msg.broadcast) continue;
        if (msg.key.remoteJid?.includes("status@broadcast")) continue;
        if (msg.key.remoteJid?.includes("g.us")) continue; // Ignore groups

        const jid = msg.key.remoteJid;
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";

        if (!jid || !text) continue;

        console.log(`📨 ${jid}: ${text.substring(0, 50)}`);

        // POST to backend webhook — fire and forget
        if (BACKEND_URL && INTERNAL_API_KEY) {
          setImmediate(() => {
            axios
              .post(
                `${BACKEND_URL}/api/internal/receive-message`,
                {
                  userId,
                  from: jid,
                  text,
                  platform: "whatsapp",
                  messageId: msg.key.id || `in_${Date.now()}`,
                  timestamp: (msg.messageTimestamp as any)?.toNumber?.() * 1000 || Date.now(),
                },
                {
                  headers: { Authorization: `Bearer ${INTERNAL_API_KEY}` },
                  timeout: 60000,
                }
              )
              .catch((err: any) => {
                console.error(`[webhook] POST failed: ${err?.message || err}`);
              });
          });
        }
      }
    });

    // ─── Credentials Update ───────────────────────────────────────────────

    sock.ev.on("creds.update", saveCreds);

    sessions[userId] = { sock, connected: false };
    console.log(`[${userId}] Session created`);
  } catch (err) {
    console.error(`[${userId}] Failed to create session:`, err);
    setTimeout(() => createSession(userId), 5000);
  }
}

// ========================
// API ENDPOINTS
// ========================

// GET /connect/:userId — Create a new WhatsApp session
app.get("/connect/:userId", async (req, res) => {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ error: "userId required" });

  if (sessions[userId]?.connected) {
    return res.json({
      connected: true,
      phoneNumber: sessions[userId].phoneNumber,
    });
  }

  if (!sessions[userId]) {
    await createSession(userId);
  }

  // Return immediately with QR code
  res.json({
    connected: false,
    qr: sessions[userId]?.qr,
  });
});

// GET /status/:userId — Check session status
app.get("/status/:userId", (req, res) => {
  const { userId } = req.params;
  const session = sessions[userId];

  if (!session) {
    return res.json({ connected: false });
  }

  res.json({
    connected: session.connected,
    phoneNumber: session.phoneNumber,
    qr: session.qr,
  });
});

// POST /send-message — Deliver a message via WhatsApp
app.post("/send-message", async (req, res) => {
  const { userId, to, text } = req.body;

  if (!userId || !to || !text) {
    return res.status(400).json({ error: "userId, to, text required" });
  }

  const session = sessions[userId];
  if (!session?.connected || !session.sock) {
    return res.status(503).json({ error: "Session not connected" });
  }

  try {
    const jid = normalizeJid(to);
    await session.sock.sendMessage(jid, { text });
    console.log(`📤 Message sent to ${jid}`);
    res.json({ success: true });
  } catch (err: any) {
    console.error(`[send-message] Failed:`, err?.message || err);
    res.status(500).json({ error: err?.message || "Send failed" });
  }
});

// POST /logout/:userId — Disconnect a session
app.post("/logout/:userId", async (req, res) => {
  const { userId } = req.params;
  const session = sessions[userId];

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  try {
    if (session.sock?.ws) session.sock.ws.close();
    if (session.sock?.end) session.sock.end(new Error("logout"));
    delete sessions[userId];
    console.log(`🚪 Logged out: ${userId}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Logout failed" });
  }
});

// ========================
// GRACEFUL SHUTDOWN
// ========================

process.on("SIGTERM", async () => {
  console.log("🛑 SIGTERM received — shutting down gracefully");
  for (const [userId, session] of Object.entries(sessions)) {
    try {
      if (session.sock?.ws) session.sock.ws.close();
      if (session.sock?.end) session.sock.end(new Error("shutdown"));
      console.log(`Closed session: ${userId}`);
    } catch (err) {
      console.error(`Error closing ${userId}:`, err);
    }
  }
  process.exit(0);
});

// ========================
// START SERVER
// ========================

app.listen(PORT, () => {
  console.log(`🚀 Gateway listening on port ${PORT}`);
});
