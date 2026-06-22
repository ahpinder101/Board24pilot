import { Router } from "express";
import { openai } from "../lib/openai.js";

const router = Router();

const SUPPORTED_LANGUAGES = new Set([
  "Polish",
  "Spanish",
  "French",
  "German",
  "Chinese",
]);

router.post("/translate", async (req, res) => {
  const { text, targetLanguage } = req.body as { text?: unknown; targetLanguage?: unknown };

  if (typeof text !== "string" || text.trim().length === 0) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  if (typeof targetLanguage !== "string" || !SUPPORTED_LANGUAGES.has(targetLanguage)) {
    res.status(400).json({ error: `Unsupported language: ${targetLanguage}` });
    return;
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 4096,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `You are a professional technical translator. Translate the following engineering manual answer into ${targetLanguage}. Preserve all technical terms, part numbers, measurements, and formatting exactly. Only output the translated text — no commentary, no explanations.`,
        },
        {
          role: "user",
          content: text,
        },
      ],
    });

    const translatedText = response.choices[0]?.message?.content?.trim() ?? "";
    res.json({ translatedText });
  } catch (err) {
    req.log.error({ err }, "Translation failed");
    res.status(500).json({ error: "Translation failed" });
  }
});

export default router;
