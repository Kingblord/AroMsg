const express = require("express");

const app = express();

app.use(express.json());

app.post("/webhook", async (req, res) => {

  console.log("📨 WEBHOOK RECEIVED:");
  console.log(JSON.stringify(req.body, null, 2));

  const {
    userId,
    from,
    text
  } = req.body;

  // Fake AI reply

  const aiReply =
    `Echo: ${text}`;

  console.log(
    "🤖 AI RESPONSE:",
    aiReply
  );

  res.json({
    success: true,
    aiReply
  });
});

app.get("/", (_, res) => {
  res.send("Webhook online");
});

app.listen(3000, () => {
  console.log(
    "🚀 Test webhook running"
  );
});