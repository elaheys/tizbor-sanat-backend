const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// Postgres/network error codes worth retrying — all mean "the connection or server
// wasn't available right now", never "your query was wrong". A syntax error, a unique
// violation, a foreign-key violation etc. must NOT be retried — retrying those would
// just fail the same way every time (or worse, retry a write that should NOT repeat).
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  '57P03', // cannot_connect_now (e.g. server still starting up)
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
]);

function isTransient(err) {
  if (TRANSIENT_ERROR_CODES.has(err.code)) return true;
  // pg throws this plain Error (no .code) when an already-open connection drops mid-query
  if (typeof err.message === 'string' && err.message.includes('Connection terminated')) return true;
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 200; // attempt delays: 200ms, 400ms — capped at MAX_ATTEMPTS

const originalQuery = pool.query.bind(pool);

// transparent retry wrapper: every existing `pool.query(...)` call site in the app
// (there's no other way routes reach the database) benefits without being rewritten.
pool.query = async function retryingQuery(...args) {
  let attempt = 0;
  for (;;) {
    try {
      return await originalQuery(...args);
    } catch (err) {
      attempt += 1;
      if (attempt >= MAX_ATTEMPTS || !isTransient(err)) {
        throw err;
      }
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      console.error(`transient database error (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${delay}ms:`, err.message);
      await sleep(delay);
    }
  }
};

module.exports = pool;
