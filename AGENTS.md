# AGENTS.md

Shared guidance for AI coding agents (Claude Code, Codex, Antigravity, or any other tool
that reads this file) working on **Tizbor Sanat** — the backend API for a bookkeeping
assistant used by a scissor repair/sales workshop.

Treat this as real, production-adjacent financial software. It tracks money (profit
splits, loans, customer balances) for actual people — changes should be deliberate and
verified against a real database, not just "looks right on read-through."

## Simplicity first

- This is a small, single-maintainer project: ~3–4 users, a handful of transactions per
  day (see `DESIGN.md`). Resist adding abstractions, scaling patterns, or generality the
  project doesn't actually need yet.
- For a small, clearly-scoped fix, make the direct change — don't go on exploratory tours
  of unrelated files or routes.
- Before proposing multi-tenancy, offline support, a general permission system, caching,
  or horizontal scaling, read `DESIGN.md` §13 ("deliberately out of scope"). If one of
  those becomes genuinely needed later, that's new requirements gathering — ask the user
  rather than building toward it speculatively.

## Tech stack

- **Node.js** + **Express 5**
- **PostgreSQL** via `pg`; schema changes go through **node-pg-migrate**
- **JWT** (`jsonwebtoken`) for auth, **bcrypt** (cost 10) for password hashing
- **Zod** for request validation
- Package manager: **npm** (there's a `package-lock.json` — never introduce pnpm/yarn)
- No frontend lives in this repo — the React/PWA frontend is a separate project in its
  own repository.

## Commands

```bash
npm run dev                     # nodemon, dev server on $PORT (default 4000)
npm start                       # production server
npm run migrate:up              # apply pending migrations
npm run migrate:down            # roll back the most recent migration
npm run migrate:create <name>   # scaffold a new migration file
```

There is no lint/format tool configured yet — don't assume ESLint/Prettier exist or run
them. `npm test` is currently a placeholder (see Testing below for the actual policy).

## Project structure

```
src/
  index.js            Express app setup, global middleware, route mounting
  db.js               pg Pool + automatic retry wrapper (pool.query) + withTransaction()
  routes/             one file per resource: auth, partners, customers, transactions,
                       loans, partnerLedger, customerAccounts, invoices, reports
  middleware/         requireAuth, requireAdmin, authLimiter, accountLockout, validate,
                       idempotency
  schemas/            Zod schemas, exported together from schemas/index.js — one schema
                       per route input, named createX / updateX
  utils/password.js   hashPassword / verifyPassword (bcrypt)
migrations/            node-pg-migrate files — one file per schema change; never edit a
                       migration that's already been applied anywhere
scripts/               one-off operational scripts (e.g. scripts/set_password.js)
.github/workflows/ci.yml   CI: migrate up → down → up, syntax check every file, boot the
                       server and hit /health — runs on every push to main
DESIGN.md              system design decisions and the reasoning behind them — read this
                       before proposing any architectural change
README.md              setup instructions + the full API route table
```

## Core domain model — read before touching money-related code

- **There is no central cash fund.** Every balance is always "partner A owes partner B
  this amount," never an abstract pool. This is why `partner_ledger` replaced the old
  `loans` table: it covers both manual loans and profit-settlement transfers with the
  same shape (`from_partner_id`, `to_partner_id`, `type`, `is_settled`).
- `partner_ledger.type` is `'loan'` (manually entered) or `'profit_settlement'`
  (generated, not manually entered, by
  `POST /api/reports/monthly/:year/:month/settlements` — it computes the smallest set of
  direct transfers needed to equalize that month's profit split against who actually
  collected the cash).
- Once a `partner_ledger` row is settled (`is_settled = true`), it's a closed historical
  record: the API refuses to edit or delete it (`src/routes/partnerLedger.js`), and it
  disappears from the active list (`?is_settled=false`) while staying visible via
  `GET /api/partner-ledger/history`.
- `partners.is_active` must be respected everywhere profit is split or daily stats are
  computed (`role = 'partner' AND is_active = true`). A deactivated partner keeps their
  historical data but must stop being included in *future* splits — this was a real bug
  once (fixed), don't reintroduce it when touching `src/routes/reports.js`.
- Historical share percentages live in `partner_share_history`, looked up by date.
  Changing a partner's current `share_percent` must never alter how a past month's
  report was calculated.

## API conventions

- Every route except `POST /api/auth/login` requires `Authorization: Bearer <token>`
  (`requireAuth`, mounted globally in `index.js` ahead of every `/api/*` router except
  `/api/auth`).
- Write routes that only the bookkeeper may perform use `requireAdmin`. Partners are
  read-only everywhere in this API.
- Validate every request body with a Zod schema through the `validate` middleware — add
  new schemas to `src/schemas/index.js` rather than inlining ad-hoc checks in a route.
  Use `z.boolean()`, not `z.coerce.boolean()`, for real booleans (coercion turns the
  string `"false"` into `true` — this bit `partners.is_active` once already).
- Money-creating/mutating POST routes (transactions, loans, invoices, payments) use the
  `idempotent` middleware (`Idempotency-Key` header) — carry this forward for any new
  financial write endpoint.
- Any operation that touches more than one table and must succeed or fail together
  (creating a partner + its share-history row, issuing an invoice + assigning its
  number, generating a month's settlements) goes through `withTransaction` from
  `src/db.js`. Do not add a new multi-step financial write outside a transaction.
- `pool.query` already retries automatically on transient connection errors — use it
  directly for single-statement reads/writes; reach for `withTransaction` only when a
  write genuinely spans more than one statement.
- A delete that could be blocked by a foreign key (e.g. deleting a transaction an invoice
  references) should catch Postgres error code `23503` and return a friendly `409`, not
  let a raw `500` through.
- Error responses to clients stay generic (`{ error: "something went wrong" }`); real
  detail goes to `console.error` only. Never leak a stack trace or raw DB error to a
  client — this was a deliberate fix early in the project, don't regress it.

## Migrations

- One migration file per schema change, created with `npm run migrate:create <name>`.
  Never edit a migration that's already been applied anywhere, including only locally —
  write a new one instead.
- Every `CREATE TABLE` / `CREATE INDEX` should be `IF NOT EXISTS` so migrations are safe
  to re-run against a database that already has some of the schema.
- Write a real, working `down` migration, not a no-op — CI actually runs
  `migrate:down` then `migrate:up` again on every push specifically to catch a migration
  that doesn't reverse cleanly.
- Before calling a migration done, actually run it against a real Postgres database
  (ideally a throwaway one, not the shared dev database) — don't just read the SQL and
  assume it's correct.

## Testing

- No test framework is wired up yet; `npm test` is a placeholder.
- For ordinary CRUD-ish endpoints, careful manual verification (curl/node against a real
  dev database, then clean up whatever test data was created) is acceptable — that's how
  this backend has been built and verified so far.
- **For financial logic specifically — transaction totals, profit-share math,
  settlement-transfer generation, ledger balance calculations — write real automated
  tests, don't rely on manual spot-checks alone.** This is the one area of the project
  where more rigor than "looks right" is explicitly wanted.
  - Prefer Node's built-in `node:test` + `assert` (no new dependency needed) unless the
    user asks for something else.
  - Cover the edge cases that are easy to get wrong: rounding when a share percentage
    doesn't divide evenly, a partner with zero transactions in the period, the
    settlement-transfer greedy algorithm when amounts don't net exactly to zero, and
    idempotent re-generation of an already-generated month's settlements.
- Whether or not there's an automated test, actually run the feature against a live
  database before reporting it as done, then clean up any test rows created in the
  process. Don't report a financial feature as working based on code review alone.

## Git workflow

- Work directly on `main` — this repo does not use feature branches or pull requests.
- **Never commit or push without the user explicitly reviewing and confirming the
  change first.** Showing a diff and waiting for a go-ahead is the default; don't treat
  "implement X" as implicit permission to also commit X.
- **Do not add a `Co-Authored-By` line to commits for this project** — this was
  explicitly requested and differs from some other projects' convention.
- Stage specific files, not `git add -A` — review what's actually staged before
  committing, especially to avoid accidentally including `.env` or other secrets.
- Keep commits scoped to the task at hand; don't bundle unrelated changes into one commit.
- Never force-push, reset --hard, or skip hooks unless the user explicitly asks for it.

## Security — already in place, don't weaken it

- CORS restricted to `ALLOWED_ORIGINS`; Helmet; rate limiting on auth/password
  endpoints; per-account lockout after 5 failed logins (`accountLockout.js`), which is
  independent of the IP-based rate limiter.
- bcrypt (cost 10) is the deliberate, final choice for password hashing (after trying
  and reverting argon2id) — don't switch hashing algorithms without the user's explicit
  approval.
- All secrets (JWT secret, DB credentials) live only in `.env` (gitignored);
  `.env.example` documents the shape with no real values. Never hardcode or commit a
  real secret.
- Deactivated accounts (`is_active = false`) must be excluded from financial
  calculations, not just hidden in a UI — see the Core domain model section above.

## Avoid

- Introducing multi-tenancy, offline/background-sync support, a general
  permission-matrix system, caching layers, or horizontal-scaling patterns — all
  explicitly out of scope right now (`DESIGN.md` §13). Ask the user before building
  toward any of these, even as a "small step in that direction."
- Adding a new npm dependency without first checking whether an existing one already
  covers the need.
- Editing a migration file that has already been applied anywhere.
- A multi-step financial write outside a `withTransaction` wrapper.
- Loosening CORS, rate limiting, or lockout behavior "to make testing easier" and
  leaving it that way.
- Committing or pushing without the user's explicit go-ahead.
- Guessing at Iranian tax / سامانه مؤدیان invoicing rules — that's a regulatory question
  for the user to confirm with an accountant, not something to infer or hardcode (see
  `DESIGN.md` §9).
