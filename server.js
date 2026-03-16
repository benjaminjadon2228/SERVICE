import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 5173;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

app.post("/api/tts", async (req, res) => {
  const apiKey = process.env.MURF_API_KEY;
  const voice = process.env.MURF_VOICE_ID;

  if (!apiKey || !voice) {
    res.status(500).json({
      error: "Server is missing MURF_API_KEY or MURF_VOICE_ID env vars.",
    });
    return;
  }

  const text = String(req.body?.text || "").trim();
  if (!text) {
    res.status(400).json({ error: "Text is required." });
    return;
  }

  try {
    const upstream = await fetch("https://api.murf.ai/v1/speech/generate", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        voiceId: voice,
        text,
        format: "mp3",
      }),
    });

    if (!upstream.ok) {
      const errorText = await upstream.text();
      res.status(upstream.status).json({
        error: "Murf request failed.",
        details: errorText.slice(0, 800),
      });
      return;
    }

    res.setHeader("Content-Type", "audio/mpeg");
    upstream.body.pipe(res);
  } catch (err) {
    res.status(500).json({ error: "Unexpected server error." });
  }
});

app.listen(port, () => {
  console.log(`Service bot server running on http://localhost:${port}`);
});
