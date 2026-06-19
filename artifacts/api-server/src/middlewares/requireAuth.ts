import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";

/**
 * Rejects requests that don't carry a valid Clerk session with a 401.
 * Relies on clerkMiddleware() having run earlier in the chain (see app.ts).
 * Attaches the resolved Clerk user id to req.userId for downstream handlers.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const auth = getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  (req as Request & { userId?: string }).userId = auth.userId;
  next();
}
