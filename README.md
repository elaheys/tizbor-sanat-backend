# Tizbor Sanat — Backend

Backend API for **Tizbor Sanat**, the bookkeeping assistant for a scissor repair/sales workshop. Built with Node.js, Express, and PostgreSQL, it handles transactions (sale, purchase, repair, exchange), inter-partner loans and profit settlements, customer accounts (installment/pre-sale), invoices, and monthly profit-sharing reports between partners.

> This repo is the backend (API) only. The frontend (React + PWA) is a separate project in its own repository.

## Tech Stack

- **Node.js** + **Express 5**
- **PostgreSQL** (via `pg`)
- **JWT** for authentication
- **bcrypt** for password hashing
- **Zod** for input validation
- **node-pg-migrate** for database migrations

## Features

- Record and list transactions (sale / purchase / repair / exchange) attributed to a partner
- A single partner-to-partner ledger (`partner_ledger`) covering both manual loans and profit-settlement transfers — there is no central cash fund, so every balance is always "partner A owes partner B this amount"; once settled, an entry disappears from the active list and survives only in `/api/partner-ledger/history`
- Monthly profit/loss report and each partner's share, with historical share tracking (changing a partner's share percentage never rewrites past months' reports), plus an endpoint to turn that month's cash-vs-share imbalance into the smallest possible set of real transfers
- Deactivating a partner (`is_active: false`) removes them from future profit splits and daily stats without deleting their history
- Detailed reporting: transaction totals by type, customers with an open balance, and per-partner/workshop-wide daily stats
- Customer accounts (installment pre-sales) with payment history and remaining balance
- Invoices with a server-generated, unique invoice number
- Two roles: **admin/bookkeeper** (full access) and **partner** (read-only)
- Self-service password change, plus admin-driven password reset for any account

### Security measures in place

- Password hashing with bcrypt (unique random salt per password)
- JWT-based authentication with role-based access control (`requireAuth` / `requireAdmin`)
- CORS restricted to the origins listed in `ALLOWED_ORIGINS`
- Rate limiting on login and password-change endpoints (per-IP, plus a separate per-account lockout after 5 failed attempts)
- Full input validation on every write endpoint via Zod
- Idempotency-key support on sensitive financial operations (creating a transaction, loan, or payment) so a duplicate request never gets recorded twice
- Automatic retry with exponential backoff on transient database connection errors
- Multi-step writes (creating a partner + their share-history row, issuing an invoice + assigning its number, generating a month's profit settlements) run inside a database transaction, so a crash or error partway through can never leave half the write committed
- Security headers via Helmet
- Generic error messages returned to clients (real error detail is logged server-side only)
- Global handlers for unexpected errors (`uncaughtException` / `unhandledRejection`)

## Prerequisites

- Node.js (LTS)
- A running PostgreSQL instance (local or remote)

## Setup

```bash
# install dependencies
npm install

# copy the env template and fill it in
cp .env.example .env
```

Fill in `.env` with real values (see the table below).

```bash
# run database migrations (creates the schema)
npm run migrate:up

# start the dev server (auto-restarts on file changes)
npm run dev
```

The server starts on `http://localhost:4000` (or whatever `PORT` you set). Health check:

```bash
curl http://localhost:4000/health
```

### Creating the first user (admin/bookkeeper)

There's no public signup endpoint on purpose — only the admin account should be able to create users. For the very first account, set a username/password directly with the script:

```bash
node scripts/set_password.js <partner_id> <username> <password>
```

## Environment Variables (`.env`)

| Variable | Description |
|---|---|
| `PORT` | Port the Express server listens on (default `4000`) |
| `DB_HOST` | PostgreSQL host |
| `DB_PORT` | PostgreSQL port (default `5432`) |
| `DB_NAME` | Database name |
| `DB_USER` | Database user |
| `DB_PASSWORD` | Database password |
| `JWT_SECRET` | Long random string used to sign tokens — **never hardcode or commit this** |
| `JWT_EXPIRES_IN` | Token lifetime (default `24h`) |
| `ALLOWED_ORIGINS` | Comma-separated list of origins allowed by CORS (the frontend's URL(s)) |
| `DATABASE_URL` | Used only by the `node-pg-migrate` CLI; must point at the same database as the `DB_*` vars above |

⚠️ `.env` must never be committed (it's already in `.gitignore`). Each environment (dev, production) needs its own file with its own values — in particular, `JWT_SECRET` must be a fresh, different value on the production server, never copied from a developer's machine.

## npm Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Run the server in development mode (nodemon) |
| `npm start` | Run the server in production mode |
| `npm run migrate:up` | Apply pending migrations |
| `npm run migrate:down` | Roll back the last migration |
| `npm run migrate:create <name>` | Create a new migration file |

## Project Structure

```
src/
  index.js              Entry point: Express setup, global middleware, route mounting
  db.js                 PostgreSQL connection + automatic retry wrapper
  routes/                One file per resource group (auth, partners, customers, transactions, loans, partnerLedger, customer-accounts, invoices, reports)
  middleware/            requireAuth, requireAdmin, authLimiter, accountLockout, validate, idempotency
  schemas/                Zod schemas validating each route's input
  utils/password.js      hashPassword / verifyPassword helpers
migrations/              node-pg-migrate files (database change history)
scripts/                 One-off helper scripts (password setup, etc.)
.github/workflows/ci.yml CI: installs deps, applies/rolls back/re-applies migrations against a real Postgres service container, syntax-checks every file, boots the server and checks /health
```

## API Overview

Every route except `POST /api/auth/login` requires an `Authorization: Bearer <token>` header. Write operations (POST/PATCH) require the `admin` role unless noted otherwise.

| Route | Description |
|---|---|
| `POST /api/auth/login` | Log in, receive a token |
| `PATCH /api/auth/password` | Change your own password (requires current password) |
| `GET /api/partners` | List partners (visible to everyone) |
| `POST /api/partners` | Add a new partner/admin account (admin only) |
| `PATCH /api/partners/:id` | Edit name/role/share/active status (admin only) |
| `PATCH /api/partners/:id/password` | Admin resets another user's password |
| `GET /api/customers` | List/search customers |
| `POST /api/customers` | Add a customer (admin only) |
| `GET /api/customers/:id` | Customer profile + pre-sale accounts |
| `PATCH /api/customers/:id` | Edit name/phone (admin only) |
| `DELETE /api/customers/:id` | Delete a customer — blocked (409) if they have any account, transaction, or invoice on record (admin only) |
| `GET /api/transactions` | List transactions (filter by `partner_id`, `type`, `from`, `to`) |
| `POST /api/transactions` | Record a new transaction (admin only) |
| `PATCH /api/transactions/:id` | Fix a mistake in a transaction (admin only) |
| `DELETE /api/transactions/:id` | Delete a transaction — blocked (409) if an invoice references it (admin only) |
| `GET /api/loans?partner_id=` | List inter-partner loans (`partner_ledger` rows of type `loan`) |
| `POST /api/loans` | Record a new loan (admin only) |
| `PATCH /api/loans/:id/settle` | Mark a loan as settled (admin only) |
| `GET /api/partner-ledger?is_settled=&type=&partner_id=` | List ledger entries (loans + profit settlements) — pass `is_settled=false` for the active/open view |
| `GET /api/partner-ledger/history?from=&to=` | Settled entries within a date range |
| `PATCH /api/partner-ledger/:id` | Fix a mistake in an entry that isn't settled yet (admin only) |
| `DELETE /api/partner-ledger/:id` | Delete an unsettled entry (admin only) — settled entries are closed records and cannot be edited or deleted |
| `PATCH /api/partner-ledger/:id/settle` | Mark any ledger entry as settled (admin only) |
| `POST /api/customer-accounts` | Open an installment/pre-sale account (admin only) |
| `GET /api/customer-accounts/:id` | Account details + remaining balance |
| `POST /api/customer-accounts/:id/payments` | Record an installment payment (admin only) |
| `GET /api/reports/monthly?year=&month=` | Profit/loss report, each partner's share, and the needed profit-settlement transfers for a given month |
| `PATCH /api/reports/monthly/:partnerId/settle` | Mark a partner's monthly snapshot as done |
| `POST /api/reports/monthly/:year/:month/settlements` | Generate (idempotently) the `partner_ledger` transfers needed to equalize that month's profit split (admin only) |
| `GET /api/reports/transactions-summary?year=&month=` (or `from=&to=`) | Transaction count + total amount per type |
| `GET /api/reports/customers-open-balance` | Customers with a remaining balance on a pre-sale/installment account |
| `GET /api/reports/daily?date=YYYY-MM-DD` | Per-partner and workshop-wide revenue/expense for one day |
| `GET /api/invoices` | List invoices (filter by `customer_id`, `partner_id`, `from`, `to`) |
| `GET /api/invoices/:id` | Invoice details |
| `POST /api/invoices` | Issue a new invoice with a server-generated, unique invoice number (admin only) |

## License

ISC
