const express = require('express');
const router = express.Router();
const pool = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const validate = require('../middleware/validate');
const idempotent = require('../middleware/idempotency');
const schemas = require('../schemas');

// GET /api/loans
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*, fp.name AS from_partner_name, tp.name AS to_partner_name
       FROM loans l
       JOIN partners fp ON fp.id = l.from_partner_id
       JOIN partners tp ON tp.id = l.to_partner_id
       ORDER BY l.loan_date DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// POST /api/loans (admin only) — from_partner_id lends money TO to_partner_id
router.post('/', requireAdmin, idempotent, validate(schemas.createLoan), async (req, res) => {
  try {
    const { from_partner_id, to_partner_id, amount, loan_date } = req.body;

    const result = await pool.query(
      `INSERT INTO loans (from_partner_id, to_partner_id, amount, loan_date)
       VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE)) RETURNING *`,
      [from_partner_id, to_partner_id, amount, loan_date || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// PATCH /api/loans/:id/settle (admin only)
router.patch('/:id/settle', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE loans SET is_settled = true WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'loan not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

module.exports = router;
