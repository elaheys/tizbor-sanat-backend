require('dotenv').config();

// a rejected promise nobody awaited, or a throw outside any try/catch, would otherwise
// crash the process with no record of why (or in older Node, silently keep running in a
// possibly-corrupted state). Log it with full detail server-side — this never reaches a client.
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  // the process may be in an inconsistent state after a truly uncaught error — exit so
  // the process manager (nodemon here, pm2/systemd in production) restarts it clean,
  // rather than keep serving requests from a possibly-broken process.
  process.exit(1);
});

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pool = require('./db');

const authRouter = require('./routes/auth');
const requireAuth = require('./middleware/requireAuth');
const authLimiter = require('./middleware/authLimiter');

const partnersRouter = require('./routes/partners');
const customersRouter = require('./routes/customers');
const transactionsRouter = require('./routes/transactions');
const loansRouter = require('./routes/loans');
const customerAccountsRouter = require('./routes/customerAccounts');
const reportsRouter = require('./routes/reports');

const app = express();

// security headers (XSS/clickjacking/MIME-sniffing protections, etc.)
app.use(helmet());

// only the app's own frontend(s) may call this API — no wildcard
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // no Origin header (curl, server-to-server, same-origin) — allow
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('not allowed by CORS'));
  },
}));

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'tizbor sanat server is running' });
});

app.get('/db-check', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ connected: true, time: result.rows[0].now });
  } catch (err) {
    console.error('db-check failed:', err);
    res.status(500).json({ connected: false, error: 'database check failed' });
  }
});

// login stays public (no token needed to get one) — rate-limited against brute-force guessing
app.use('/api/auth', authLimiter, authRouter);

app.use('/api', requireAuth); // every other /api/* route below requires a valid token

app.use('/api/partners', partnersRouter);
app.use('/api/customers', customersRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/loans', loansRouter);
app.use('/api/customer-accounts', customerAccountsRouter);
app.use('/api/reports', reportsRouter);

// catch-all error handler — must be last. Without this, an uncaught error (like the
// CORS rejection above) falls through to Express's default handler, which replies with
// an HTML page containing the full stack trace (file paths, line numbers) to the caller.
app.use((err, req, res, next) => {
  console.error(err);
  if (err.message === 'not allowed by CORS') {
    return res.status(403).json({ error: 'origin not allowed' });
  }
  res.status(500).json({ error: 'something went wrong' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`server running on ${PORT} — http://localhost:${PORT}/health`);
});
