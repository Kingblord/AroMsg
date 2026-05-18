const express = require("express");
const dotenv = require("dotenv");

dotenv.config();

const app = express();

app.use(express.json());

const INTERNAL_API_KEY =
  process.env.INTERNAL_API_KEY;

// ========================
// WEBHOOK
// ========================

app.post(
  "/webhook",
  async (req, res) => {

    try {

      // ========================
      // AUTH CHECK
      // ========================

      const authHeader =
        req.headers.authorization;

      if (
        !authHeader ||
        authHeader !==
          `Bearer ${INTERNAL_API_KEY}`
      ) {

        console.log(
          "❌ Unauthorized request"
        );

        return res.status(401)
          .json({
            success: false,
            error: "Unauthorized"
          });
      }

      console.log(
        "📨 WEBHOOK RECEIVED:"
      );

      console.log(
        JSON.stringify(
          req.body,
          null,
          2
        )
      );

      const {
        userId,
        from,
        text,
        platform,
        messageId,
        timestamp
      } = req.body;

      // ========================
      // FAKE AI
      // ========================

      const aiReply =
        `Echo: ${text}`;

      console.log(
        "🤖 AI RESPONSE:",
        aiReply
      );

      // ========================
      // SUCCESS
      // ========================

      res.json({
        success: true,
        aiReply
      });

    } catch (err) {

      console.error(
        "❌ Webhook error:",
        err
      );

      res.status(500).json({
        success: false,
        error: "Server error"
      });
    }
  }
);

// ========================
// HEALTH
// ========================

app.get(
  "/health",
  (_, res) => {

    res.send(
      "Webhook online"
    );
  }
);

// ========================
// START
// ========================

const PORT =
  Number(process.env.PORT) || 3000;

app.listen(
  PORT,
  () => {

    console.log(
      `🚀 Test webhook running on ${PORT}`
    );
  }
);
