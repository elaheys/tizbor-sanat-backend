// Prevents a money-creating request (new transaction, new loan, new payment...) from
// being recorded twice — e.g. a double-click, or a client that retries after a timeout
// without knowing whether the first attempt actually went through.
//
// The caller sends an `Idempotency-Key` header (any client-generated unique string, e.g.
// a UUID, kept the SAME across retries of the one logical submission). The first request
// with a given key runs normally; its response is cached. Any later request reusing that
// same key — on this route — gets the cached response replayed instead of running again.
//
// The key is optional: a client that doesn't send one gets the old behavior (no dedup
// protection). This is in-memory, so it doesn't survive a restart and won't work across
// multiple server instances — a production multi-instance deployment should move this
// store to Redis (or similar) instead.

const TTL_MS = 24 * 60 * 60 * 1000; // how long a key is remembered
const store = new Map(); // `${method} ${path} ${key}` -> { status, body, expiresAt }

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
}, 10 * 60 * 1000).unref();

function idempotent(req, res, next) {
  const key = req.headers['idempotency-key'];
  if (!key) return next(); // no key supplied — proceed unprotected

  const storeKey = `${req.method} ${req.originalUrl} ${key}`;
  const cached = store.get(storeKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.setHeader('Idempotent-Replay', 'true');
    return res.status(cached.status).json(cached.body);
  }

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    // only cache a successful creation — a validation error or server error should be
    // retryable with the same key, not permanently "stuck" replaying the failure
    if (res.statusCode >= 200 && res.statusCode < 300) {
      store.set(storeKey, { status: res.statusCode, body, expiresAt: Date.now() + TTL_MS });
    }
    return originalJson(body);
  };

  next();
  
}

module.exports = idempotent;
