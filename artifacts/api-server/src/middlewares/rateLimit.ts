import type { RequestHandler } from "express";
import rateLimit from "express-rate-limit";

// Guards the expensive AI extraction endpoints against cost-exhaustion abuse.
// Each request to these routes can kick off a long-running, full-document LLM job,
// so we cap how often any single client can trigger them.
export const expensiveOpLimiter: RequestHandler = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20, // max expensive-op triggers per IP per window
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error:
      "Too many extraction requests. These run expensive AI jobs — please wait a few minutes before trying again.",
  },
});
