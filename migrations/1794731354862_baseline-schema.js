/* eslint-disable camelcase */

// This is the BASELINE migration: it captures the schema exactly as it already exists
// in the dev database today (that schema was built by hand over several ad-hoc scripts —
// scripts/migrate_add_auth.js, scripts/migrate_add_roles.js — before this project adopted
// a real migration tool). Every statement uses IF NOT EXISTS, so running this against the
// existing dev database is a safe no-op; running it against a brand-new, empty database
// (a fresh dev machine, or the production VPS) builds the whole schema from scratch.
//
// From here on, every schema change gets its OWN migration file (npm run migrate:create),
// never an edit to this one.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS partners (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      share_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      username TEXT UNIQUE,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'partner' CHECK (role IN ('admin', 'partner'))
    );

    CREATE TABLE IF NOT EXISTS partner_share_history (
      id SERIAL PRIMARY KEY,
      partner_id INTEGER NOT NULL REFERENCES partners(id),
      share_percent NUMERIC(5,2) NOT NULL,
      effective_from DATE NOT NULL DEFAULT CURRENT_DATE
    );

    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT
    );

    CREATE TABLE IF NOT EXISTS customer_accounts (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      total_amount NUMERIC(12,0) NOT NULL,
      description TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS customer_payments (
      id SERIAL PRIMARY KEY,
      customer_account_id INTEGER NOT NULL REFERENCES customer_accounts(id),
      amount NUMERIC(12,0) NOT NULL,
      paid_at DATE NOT NULL DEFAULT CURRENT_DATE
    );

    CREATE TABLE IF NOT EXISTS loans (
      id SERIAL PRIMARY KEY,
      from_partner_id INTEGER NOT NULL REFERENCES partners(id),
      to_partner_id INTEGER NOT NULL REFERENCES partners(id),
      amount NUMERIC(12,0) NOT NULL,
      loan_date DATE NOT NULL DEFAULT CURRENT_DATE,
      is_settled BOOLEAN NOT NULL DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS monthly_balances (
      id SERIAL PRIMARY KEY,
      partner_id INTEGER NOT NULL REFERENCES partners(id),
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      opening_balance NUMERIC(12,0) NOT NULL DEFAULT 0,
      profit_share NUMERIC(12,0) NOT NULL DEFAULT 0,
      closing_balance NUMERIC(12,0) NOT NULL DEFAULT 0,
      is_settled BOOLEAN NOT NULL DEFAULT false,
      UNIQUE (partner_id, year, month)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      scissor_type TEXT NOT NULL,
      customer_id INTEGER REFERENCES customers(id),
      partner_id INTEGER NOT NULL REFERENCES partners(id),
      amount NUMERIC(12,0) NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);
};

// drops everything, in reverse dependency order (children before the parents they
// reference) — provided for completeness, but running this deletes all data.
exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS transactions;
    DROP TABLE IF EXISTS monthly_balances;
    DROP TABLE IF EXISTS loans;
    DROP TABLE IF EXISTS customer_payments;
    DROP TABLE IF EXISTS customer_accounts;
    DROP TABLE IF EXISTS customers;
    DROP TABLE IF EXISTS partner_share_history;
    DROP TABLE IF EXISTS partners;
  `);
};
