const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const pool = require('../db');
const requireAuth = require('../middleware/requireAuth');
const validate = require('../middleware/validate');
const schemas = require('../schemas');
const { hashPassword, verifyPassword } = require('../utils/password');
const accountLockout = require('../middleware/accountLockout');

// POST /api/auth/login
router.post('/login', validate(schemas.login), async (req, res) => {
  try {
    const { username, password } = req.body;

    if (accountLockout.isLocked(username)) {
      const minutesLeft = Math.ceil(accountLockout.msUntilUnlock(username) / 60000);
      return res.status(423).json({
        error: `too many failed attempts for this account — try again in ${minutesLeft} minute(s)`,
      });
    }

    const result = await pool.query('SELECT * FROM partners WHERE username = $1', [username]);
    const partner = result.rows[0];

    // same generic error whether the username doesn't exist or the password is wrong,
    // so an attacker can't use this endpoint to discover valid usernames
    if (!partner || !partner.password_hash) {
      accountLockout.recordFailure(username);
      return res.status(401).json({ error: 'invalid username or password' });
    }

    const passwordMatches = await verifyPassword(partner.password_hash, password);
    if (!passwordMatches) {
      accountLockout.recordFailure(username);
      return res.status(401).json({ error: 'invalid username or password' });
    }

    accountLockout.clearFailures(username);

    const token = jwt.sign(
      { id: partner.id, name: partner.name, username: partner.username, role: partner.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    res.json({
      token,
      partner: { id: partner.id, name: partner.name, username: partner.username, role: partner.role },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// PATCH /api/auth/password — self-service: any logged-in partner/admin changes their own password
// mounted under /api/auth, which sits BEFORE the global requireAuth in index.js, so it's applied here directly
router.patch('/password', requireAuth, validate(schemas.changeOwnPassword), async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    const result = await pool.query('SELECT * FROM partners WHERE id = $1', [req.partner.id]);
    const partner = result.rows[0];
    if (!partner || !partner.password_hash) {
      return res.status(404).json({ error: 'account not found' });
    }

    const currentMatches = await verifyPassword(partner.password_hash, current_password);
    if (!currentMatches) {
      return res.status(401).json({ error: 'current password is incorrect' });
    }

    const newHash = await hashPassword(new_password);
    await pool.query('UPDATE partners SET password_hash = $1 WHERE id = $2', [newHash, partner.id]);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

module.exports = router;
