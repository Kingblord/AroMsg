const express = require("express");
const dotenv = require("dotenv");
const axios = require("axios");

dotenv.config();

const app = express();

app.use(express.json());

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:3001";

// ========================
// WEBHOOK ENDPOINT
// ========================

app.post("/webhook", async (req, res) => {
  try {
    // ========================
    // AUTHENTICATION
    // ========================
    const authHeader = req.headers.authorization;

    if (!authHeader || authHeader !== `Bearer ${INTERNAL_API_KEY}`) {
      console.log("❌ Unauthorized webhook attempt");
      return res.status(401).json({
        success: false,
        error: "Unauthorized"
      });
    }

    const {
      userId,
      from,
      text,
      platform,
      messageId,
      timestamp
    } = req.body;

    console.log("📨 WEBHOOK RECEIVED:");
    console.log(JSON.stringify(req.body, null, 2));

    if (!userId || !from || !text) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields"
      });
    }

    // ========================
    // AI RESPONSE (Fake for now)
    // ========================
    const aiReply = `Echo: ${text}\n\nThis is a test reply from the backend! 👋`;

    console.log("🤖 AI Reply:", aiReply);

    // ========================
    // SEND REPLY BACK TO WHATSAPP via Gateway
    // ========================
    try {
      await axios.post(`${GATEWAY_URL}/send-message`, {
        userId,
        to: from,
        text: aiReply
      }, {
        headers: {
          Authorization: `Bearer ${INTERNAL_API_KEY}`
        },
        timeout: 10000
      });

      console.log(`✅ Reply sent successfully to ${from}`);
    } catch (sendError) {
      console.error("❌ Failed to send reply to gateway:", sendError.message);
    }

    // ========================
    // RESPOND TO GATEWAY
    // ========================
    res.json({
      success: true,
      aiReply
    });

  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
});

// ========================
// HEALTH CHECK
// ========================

app.get("/health", (_, res) => {
  res.send("Webhook server is running ✅");
});

// ========================
// START SERVER
// ========================

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Test Webhook Server running on port ${PORT}`);
  console.log(`📡 Gateway URL: ${GATEWAY_URL}`);
});
