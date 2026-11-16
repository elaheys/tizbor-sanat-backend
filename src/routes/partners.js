const express = require('express');
const router = express.Router();
const pool = require('../db');
const { withTransaction } = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const authLimiter = require('../middleware/authLimiter');
const validate = require('../middleware/validate');
const schemas = require('../schemas');
const { hashPassword } = require('../utils/password');

// GET /api/partners — everyone (admin + partners) can see everyone's info
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, role, share_percent, is_active, username FROM partners ORDER BY id'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// POST /api/partners — add a new partner or the bookkeeper account (admin only)
router.post('/', requireAdmin, validate(schemas.createPartner), async (req, res) => {
  try {
    const { name, role, share_percent } = req.body;

    // both writes must succeed together — a partner with no share-history row would
    // break every monthly report that looks up their historical share percentage
    const partner = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO partners (name, role, share_percent)
         VALUES ($1, $2, $3) RETURNING id, name, role, share_percent, is_active`,
        [name, role || 'partner', share_percent || 0]
      );
      const created = result.rows[0];

      // every partner needs a starting point in the share history, even if it's 0%
      await client.query(
        `INSERT INTO partner_share_history (partner_id, share_percent, effective_from)
         VALUES ($1, $2, CURRENT_DATE)`,
        [created.id, created.share_percent]
      );

      return created;
    });

    res.status(201).json(partner);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// PATCH /api/partners/:id — edit name/role/active, and/or change share (admin only)
router.patch('/:id', requireAdmin, validate(schemas.updatePartner), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, role, is_active, share_percent } = req.body;

    const current = await pool.query('SELECT * FROM partners WHERE id = $1', [id]);
    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'partner not found' });
    }

    const shareChanged = share_percent != null && Number(share_percent) !== Number(current.rows[0].share_percent);

    const updated = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE partners SET
           name = COALESCE($1, name),
           role = COALESCE($2, role),
           is_active = COALESCE($3, is_active),
           share_percent = COALESCE($4, share_percent)
         WHERE id = $5
         RETURNING id, name, role, share_percent, is_active`,
        [name, role, is_active, share_percent, id]
      );

      // a changed share percentage gets its own dated history row — past months stay
      // untouched because reports look up the percentage that was valid AT THE TIME,
      // not whatever the current value is. Same transaction as the update above: a
      // share change without its history row would silently break past-month reports.
      if (shareChanged) {
        await client.query(
          `INSERT INTO partner_share_history (partner_id, share_percent, effective_from)
           VALUES ($1, $2, CURRENT_DATE)`,
          [id, share_percent]
        );
      }

      return result;
    });

    res.json(updated.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// PATCH /api/partners/:id/password — admin resets anyone's password (no current password needed)
router.patch('/:id/password', authLimiter, requireAdmin, validate(schemas.resetPassword), async (req, res) => {
  try {
    const { id } = req.params;
    const { new_password } = req.body;

    const current = await pool.query('SELECT id, username FROM partners WHERE id = $1', [id]);
    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'partner not found' });
    }
    if (!current.rows[0].username) {
      return res.status(400).json({ error: 'this account has no username set yet — set one before resetting the password' });
    }

    const newHash = await hashPassword(new_password);
    await pool.query('UPDATE partners SET password_hash = $1 WHERE id = $2', [newHash, id]);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

module.exports = router;
