import type { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { logger } from "../lib/logger.js";

/**
 * Invite-only allowlist.
 *
 * ALLOWED_EMAILS is a comma/space separated list. Each entry is either:
 *   - a full email address (e.g. "jane@example.com"), or
 *   - a whole domain prefixed with "@" (e.g. "@board24.com") to allow anyone
 *     with that email domain.
 *
 * When ALLOWED_EMAILS is empty/unset, the allowlist is DISABLED and any
 * signed-in Clerk user may access the API (a warning is logged at startup).
 * Set ALLOWED_EMAILS to lock the app down to specific people.
 */
const rawAllow = process.env.ALLOWED_EMAILS ?? "";
const allowedEmails = new Set<string>();
const allowedDomains = new Set<string>();
for (const entry of rawAllow.split(/[,\s]+/)) {
  const value = entry.trim().toLowerCase();
  if (!value) continue;
  if (value.startsWith("@")) allowedDomains.add(value.slice(1));
  else allowedEmails.add(value);
}
const allowlistEnabled = allowedEmails.size > 0 || allowedDomains.size > 0;

if (!allowlistEnabled) {
  logger.warn(
    "ALLOWED_EMAILS is not set — any signed-in Clerk user can access the API. Set ALLOWED_EMAILS to enforce invite-only access.",
  );
} else {
  logger.info(
    { emails: allowedEmails.size, domains: allowedDomains.size },
    "Invite-only allowlist active",
  );
}

// Cache the resolved primary email per Clerk user id so we don't call the
// Clerk API on every request. The allowlist itself is fixed per process
// (env vars load at boot), so a short TTL is plenty.
const EMAIL_TTL_MS = 5 * 60 * 1000;
const emailCache = new Map<string, { email: string | null; expires: number }>();

async function getUserEmail(userId: string): Promise<string | null> {
  const cached = emailCache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.email;

  const user = await clerkClient.users.getUser(userId);
  const primary =
    user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId) ??
    user.emailAddresses[0];
  const email = primary?.emailAddress?.toLowerCase() ?? null;

  emailCache.set(userId, { email, expires: Date.now() + EMAIL_TTL_MS });
  return email;
}

function isEmailAllowed(email: string | null): boolean {
  if (!email) return false;
  if (allowedEmails.has(email)) return true;
  const domain = email.split("@")[1];
  return domain ? allowedDomains.has(domain) : false;
}

/**
 * Rejects requests that don't carry a valid Clerk session with a 401, and —
 * when the allowlist is enabled — rejects signed-in users whose email is not
 * on the allowlist with a 403. Relies on clerkMiddleware() having run earlier
 * in the chain (see app.ts).
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  (req as Request & { userId?: string }).userId = auth.userId;

  if (!allowlistEnabled) {
    next();
    return;
  }

  try {
    const email = await getUserEmail(auth.userId);
    if (!isEmailAllowed(email)) {
      req.log.warn(
        { userId: auth.userId, email },
        "Access denied — email not on ALLOWED_EMAILS allowlist",
      );
      res.status(403).json({
        error:
          "Access denied. Your account is not authorized to use this app.",
      });
      return;
    }
    next();
  } catch (err) {
    req.log.error({ err }, "Failed to verify allowlist membership");
    res.status(500).json({ error: "Failed to verify access" });
  }
}
