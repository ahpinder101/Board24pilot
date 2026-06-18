import { Router } from "express";
import { db } from "@workspace/db";
import { feedbackTable } from "@workspace/db";

const router = Router();

router.post("/feedback", async (req, res) => {
  const { sessionId, question, answer, rating, reason, correction } = req.body as {
    sessionId?: unknown;
    question?: unknown;
    answer?: unknown;
    rating?: unknown;
    reason?: unknown;
    correction?: unknown;
  };

  if (typeof sessionId !== "string" || typeof question !== "string" || typeof answer !== "string") {
    res.status(400).json({ error: "sessionId, question, and answer are required" });
    return;
  }

  if (rating !== "positive" && rating !== "negative") {
    res.status(400).json({ error: "rating must be 'positive' or 'negative'" });
    return;
  }

  await db.insert(feedbackTable).values({
    sessionId,
    question: question.slice(0, 2000),
    answer: answer.slice(0, 8000),
    rating,
    reason: typeof reason === "string" ? reason.slice(0, 500) : null,
    correction: typeof correction === "string" && correction.trim().length > 0 ? correction.trim().slice(0, 4000) : null,
  });

  res.json({ ok: true });
});

export default router;
