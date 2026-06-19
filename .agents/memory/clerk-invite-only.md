---
name: Clerk invite-only access
description: How to lock this app to invited users only — code adds auth but not the allowlist.
---

This app uses Replit-managed Clerk. The code (requireAuth on all API routes except
/healthz; full-app gating on the client) only enforces *that a user is signed in*,
NOT *who is allowed to sign in*.

**Rule:** By default Clerk allows open self sign-up, so adding Clerk alone does NOT
make the app invite-only. To restrict to a small invited group, the builder must
configure restrictions in the **Auth pane** (workspace toolbar): disable public
sign-up and/or add an allowlist of permitted emails/domains. There is no external
Clerk dashboard and this cannot be done from code.

**Why:** The user's goal was an invite-only tool to cap LLM cost; auth middleware
without sign-up restriction still lets any stranger create an account and run
expensive extraction.
