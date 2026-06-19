---
name: Clerk invite-only access
description: How this app enforces invite-only access on top of Clerk auth.
---

This app uses Replit-managed Clerk. Clerk's `requireAuth` only enforces *that a
user is signed in*, not *who* is allowed in (Clerk allows open self sign-up by
default).

**Invite-only is enforced in code via an `ALLOWED_EMAILS` env var** (shared
environment), read by `artifacts/api-server/src/middlewares/requireAuth.ts`:
- Comma/space separated. Each entry is a full email (`jane@x.com`) or a whole
  domain prefixed with `@` (`@board24.com`).
- When unset/empty → allowlist DISABLED (fail-open): any signed-in user gets in;
  a startup WARN is logged.
- When set → signed-in users whose primary email isn't on the list get **403**.
- Primary email is fetched via `clerkClient.users.getUser(userId)` and cached
  in-memory 5 min to avoid a Clerk API call per request.

**Why:** The user wanted an invite-only tool to cap LLM cost; auth alone still
lets any stranger sign up and run expensive extraction. The env-var allowlist
lets them lock it down without code changes and without knowing the emails up
front.

**How to apply / activate:** set `ALLOWED_EMAILS` (shared env) then restart the
api-server workflow. Env vars load at boot, so the in-process allowlist + cache
are fixed per run — changes require a restart.

**Frontend gate:** signed-in but non-allowlisted users get a friendly
access-denied screen (not a broken dashboard). `AccessGate` in `App.tsx` probes
`useGetGlobalStats`; on `error.status === 403` it renders `access-denied-page.tsx`
(with Clerk sign-out). This is UX only — server `requireAuth` is the real
enforcement. Non-403 errors fall through to the app so transient API failures
don't lock anyone out.
