# Tizbor Sanat — System Design

This document records the architectural decisions for Tizbor Sanat (backend + the
not-yet-built React/PWA frontend) and the reasoning behind them. It exists so that one
person — currently the sole maintainer, with no team planned — can pick this project back
up in a year and remember *why* it's built this way, not just *what* the code does.

Last reviewed: 2026-11-17.

## 1. What this system is

A bookkeeping assistant for one scissor repair/sales workshop with 3–4 partners and one
bookkeeper/admin account. It tracks transactions, inter-partner loans, profit-sharing
settlements, customer installment accounts, and invoices. There is no central cash fund:
every balance is always "partner A owes partner B this amount," never an abstract pool.

## 2. Scale — and why it keeps the design simple

- A handful of transactions per day, 3–4 users total today.
- The number of *partners or admin accounts* may grow over time, but a second
  workshop/branch is explicitly **not** planned — this stays single-tenant.
- This rules out: horizontal scaling, read replicas, caching layers, multi-tenancy,
  queue-based architectures. A single small VPS running Node + PostgreSQL is enough for
  the foreseeable future, and over-engineering past that would only make the one-person
  maintenance burden worse.

## 3. Access model

- Partners and the admin access the system from anywhere over the internet (not
  restricted to the workshop's local network), including from phones.
- Consequence: HTTPS is mandatory (not optional), and the existing hardening — CORS
  restricted to `ALLOWED_ORIGINS`, rate limiting, per-account lockout, JWT auth — is the
  right level of defense for an internet-facing app. None of it can be relaxed on the
  assumption of a trusted local network.
- JWT lifetime of 24h was confirmed as sufficient; no refresh-token flow is needed.

## 4. Frontend

- React + PWA, always-online. **No offline-first / background-sync requirement** — the
  user confirmed the app only needs to work while connected. This means:
  - No IndexedDB-based local queue, no conflict-resolution logic, no service-worker
    request replay. A normal "call the API, show a spinner, handle errors" SPA is enough.
  - Keep this in mind if a future request asks for offline support — that would be a
    genuinely new requirement needing its own design pass, not a small addition.
- Lives in its own repository, deployed separately from this backend.

## 5. Infrastructure & deployment

**Not yet decided / not yet purchased** — hosting provider, VPS, and domain are all
still open as of this writing. What *is* decided:

- An Iranian VPS (ParsPack or OnlineServer were the candidates mentioned) + Nginx + a
  free Let's Encrypt certificate, running the whole stack (Node app + PostgreSQL) on one
  box. At this scale, splitting the database onto a separate managed service would add
  operational surface (another thing to secure, back up, and pay for) without a
  corresponding benefit.
- **CI** is already in place (`.github/workflows/ci.yml`): every push to `main` applies
  all migrations to a fresh Postgres, rolls the last one back and re-applies it, syntax
  checks every file, and boots the server to hit `/health`.
- **CD is wanted**: once the VPS exists, extend the GitHub Actions workflow so a merge to
  `main` automatically deploys (SSH in, pull, run `npm run migrate:up`, restart the
  process manager). Not built yet because there's no server to deploy to — this is the
  next concrete infrastructure task once the VPS is purchased.
- Process manager on the VPS: pm2 or systemd (nodemon, used in dev, is not a production
  process manager — it doesn't restart on crash reliably or manage logs).

## 6. Backups

Decision: **automated backups, stored off the VPS itself.** A cron job on the VPS running
`pg_dump` on a schedule (daily is enough at this data volume), with the dump then copied
somewhere other than that VPS's own disk — e.g. object storage (S3-compatible, Arvan
Cloud, or similar), or a second small VPS. The reasoning: a backup that lives only on the
same disk as the database protects against nothing if that VPS itself fails or is
compromised. This needs to be set up at the same time as the VPS itself, not as an
afterthought.

Not yet decided: exact retention period (how many daily dumps to keep) and the specific
off-site target — revisit once the VPS provider is chosen, since some offer built-in
snapshot/backup products that might cover this without extra wiring.

## 7. Backup data = source of truth for everything else

Worth stating explicitly: profit splits, loan balances, and settlements are all
*derived* from `transactions` and `partner_ledger` — nothing else needs its own backup
strategy. `monthly_balances` is a cache/snapshot, not a second source of truth (see
`src/routes/reports.js`), so losing and regenerating it from transactions would be lossy
only in the sense of recomputing — the underlying financial truth survives as long as
`transactions` and `partner_ledger` do.

## 8. Roles & permissions

Current: two hardcoded roles, `admin` (full read/write) and `partner` (read-only),
enforced by a `CHECK (role IN ('admin', 'partner'))` constraint and the `requireAdmin`
middleware.

The user flagged that a future role is plausible — specifically a "limited bookkeeper"
(financial write access without seeing something else) or a role for managing something
across partners. Decision for now: **do not build a general permission-matrix system
pre-emptively.** With only two roles ever actually requested, a flexible
permissions-table design would be speculative complexity with no current user. The
practical extension path when (if) a third role is actually needed:

1. Add the new value to the `partners.role` CHECK constraint via a migration.
2. Add an explicit middleware for that role (mirroring `requireAdmin`), rather than
   overloading the existing `admin`/`partner` checks with special cases.
3. Only reach for a real permissions table (role → allowed actions, many-to-many) if a
   *third distinct* access pattern shows up — two data points don't justify an
   abstraction, three start to.

## 9. Invoicing & Iranian tax compliance (سامانه مؤدیان)

This is the least settled part of the design, because it depends on facts the user
needs to confirm:

- **Unknown**: whether the workshop is formally registered and subject to سامانه مؤدیان
  (the electronic tax invoice system). The user needs to check this.
- **Current state**: no invoices have been registered anywhere yet; `POST /api/invoices`
  generates a simple server-side sequential number (`INV-00001`, derived from the row's
  own database id) with no tax-system awareness at all.
- **Decision for now**: build only internal numbering/format compatibility, not a live
  integration. Real سامانه مؤدیان integration needs: a registered economic code, API
  credentials from the tax gateway, and — critically — an API call *per invoice* that
  returns an official unique tax identifier (شناسه یکتای مالیاتی) and often a QR code.
  That call can fail or time out, which means it needs the same kind of
  retry-with-backoff and idempotency handling already used elsewhere in this codebase
  (`src/db.js`'s retry wrapper, `src/middleware/idempotency.js`) — this is not a detail
  to bolt on later, it shapes the integration from day one once it's built.
- **What "format-compatible now" means concretely**: when registration status is
  confirmed, add nullable columns to `invoices` to hold the official reference once it
  exists (e.g. `mardiyan_reference_id`, `mardiyan_registered_at`, `economic_code`) rather
  than repurposing `invoice_number` for it. The internal `INV-00001` number keeps working
  as today's human-facing reference regardless of whether/when official registration is
  added.
- **Action item for the user, not for this backend**: confirm registration status and
  whether an accountant/tax consultant needs to be involved before any further invoicing
  work — the exact numbering/format rules (e.g. whether official numbers reset per fiscal
  year) are a regulatory question, not a technical one, and shouldn't be guessed at in
  code.

## 10. Monitoring / alerting

Decision: **not needed now.** No uptime-monitoring service (e.g. UptimeRobot) is being
set up today. If the VPS goes down, the user will notice through normal use rather than
needing a page/SMS. Revisit this once the system is actually depended on day-to-day — at
that point, a free-tier uptime checker hitting `GET /health` is a cheap addition, not a
redesign.

## 11. Notifications (SMS/email)

Not needed now — no customer payment reminders, no partner settlement notifications.
If this becomes wanted later, it is a genuinely separate piece of infrastructure (an
Iranian SMS gateway integration, e.g. Kavenegar or Melipayamak) and should get its own
design pass rather than being squeezed into the current scope.

## 12. Open items (tracked here, not yet decided)

- [ ] Choose VPS provider + purchase + domain registration
- [ ] Set up the CD half of the pipeline (deploy-on-merge) once the VPS exists
- [ ] Set up the off-site automated backup job on the VPS
- [ ] Confirm سامانه مؤدیان registration status with an accountant; revisit invoicing
      design only after that's known
- [ ] Replace the test passwords currently on the dev database before any real deployment

## 13. What's deliberately out of scope

Worth stating so a future "should we add X" question doesn't get re-litigated from
scratch — these were explicitly ruled out by the actual usage pattern, not overlooked:

- Multi-tenancy / multi-workshop support
- Offline-first frontend / background sync
- A general role-permission matrix
- Horizontal scaling, caching, read replicas
- SMS/email notifications
- Uptime monitoring/alerting

If any of these change (a second workshop does get added, offline becomes a real need,
etc.), treat it as new requirements gathering, not a tweak to the current design.
