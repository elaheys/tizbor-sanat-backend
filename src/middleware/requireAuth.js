const jwt = require('jsonwebtoken');
const pool = require('../db');

// protects a route: the request must carry "Authorization: Bearer <token>"
// with a token that is valid, not expired, and signed with the partner's CURRENT
// token_version — a password change (self-service or admin reset) bumps that
// counter, which invalidates every token issued before it, on every device.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'authentication required' });
  }

  const token = header.slice('Bearer '.length);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const result = await pool.query('SELECT token_version FROM partners WHERE id = $1', [payload.id]);
    const currentVersion = result.rows[0]?.token_version;
    if (currentVersion === undefined || currentVersion !== payload.token_version) {
      return res.status(401).json({ error: 'invalid or expired token' });
    }

    req.partner = payload; // { id, name, username, role, token_version }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}

module.exports = requireAuth;
