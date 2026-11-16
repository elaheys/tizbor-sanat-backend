const express = require('express');
const router = express.Router();
const pool = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const validate = require('../middleware/validate');
const idempotent = require('../middleware/idempotency');
const schemas = require('../schemas');

// Backed by `partner_ledger` (type = 'loan') — see migrations/1794900000000_partner-ledger.js
// for why loans and profit-settlement transfers share one table. This route only ever
// touches the 'loan' rows; profit_settlement rows are managed under /api/reports.

// GET /api/loans?is_settled=true|false&partner_id= — defaults to all
router.get('/', async (req, res) => {
  try {
    const conditions = [`type = 'loan'`];
    const values = [];
    if (req.query.is_settled !== undefined) {
      values.push(req.query.is_settled === 'true');
      conditions.push(`is_settled = $${values.length}`);
    }
    if (req.query.partner_id) {
      values.push(req.query.partner_id);
      conditions.push(`(from_partner_id = $${values.length} OR to_partner_id = $${values.length})`);
    }

    const result = await pool.query(
      `SELECT pl.*, fp.name AS from_partner_name, tp.name AS to_partner_name
       FROM partner_ledger pl
       JOIN partners fp ON fp.id = pl.from_partner_id
       JOIN partners tp ON tp.id = pl.to_partner_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY pl.entry_date DESC`,
      values
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
    const { from_partner_id, to_partner_id, amount, loan_date, note } = req.body;

    const result = await pool.query(
      `INSERT INTO partner_ledger (from_partner_id, to_partner_id, amount, type, entry_date, note)
       VALUES ($1, $2, $3, 'loan', COALESCE($4, CURRENT_DATE), $5) RETURNING *`,
      [from_partner_id, to_partner_id, amount, loan_date || null, note || null]
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
      `UPDATE partner_ledger SET is_settled = true, settled_at = now()
       WHERE id = $1 AND type = 'loan' RETURNING *`,
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
