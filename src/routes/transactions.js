const express = require('express');
const router = express.Router();
const pool = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const validate = require('../middleware/validate');
const idempotent = require('../middleware/idempotency');
const schemas = require('../schemas');

// GET /api/transactions?partner_id=&type=&from=&to=
router.get('/', async (req, res) => {
  try {
    const { partner_id, type, from, to } = req.query;
    const conditions = [];
    const values = [];

    if (partner_id) { values.push(partner_id); conditions.push(`partner_id = $${values.length}`); }
    if (type) { values.push(type); conditions.push(`type = $${values.length}`); }
    if (from) { values.push(from); conditions.push(`created_at >= $${values.length}`); }
    if (to) { values.push(to); conditions.push(`created_at <= $${values.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT t.*, c.name AS customer_name, p.name AS partner_name
       FROM transactions t
       LEFT JOIN customers c ON c.id = t.customer_id
       JOIN partners p ON p.id = t.partner_id
       ${where}
       ORDER BY t.created_at DESC`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// POST /api/transactions (admin only — partners are view-only)
router.post('/', requireAdmin, idempotent, validate(schemas.createTransaction), async (req, res) => {
  try {
    const { type, scissor_type, customer_id, partner_id, amount, quantity, note } = req.body;

    const result = await pool.query(
      `INSERT INTO transactions (type, scissor_type, customer_id, partner_id, amount, quantity, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [type, scissor_type, customer_id || null, partner_id, amount, quantity || 1, note || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// PATCH /api/transactions/:id (admin only) — fixes a mistake (wrong amount, wrong
// customer, etc). Note: if a monthly profit-settlement was already generated for the
// month this transaction falls in (POST /api/reports/monthly/:year/:month/settlements),
// correcting it here does NOT retroactively adjust those settlement transfers — an admin
// who edits a past transaction should regenerate or manually adjust that month's ledger.
router.patch('/:id', requireAdmin, validate(schemas.updateTransaction), async (req, res) => {
  try {
    const { id } = req.params;
    const { type, scissor_type, customer_id, partner_id, amount, quantity, note } = req.body;

    const current = await pool.query('SELECT * FROM transactions WHERE id = $1', [id]);
    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'transaction not found' });
    }

    const result = await pool.query(
      `UPDATE transactions SET
         type = COALESCE($1, type),
         scissor_type = COALESCE($2, scissor_type),
         customer_id = COALESCE($3, customer_id),
         partner_id = COALESCE($4, partner_id),
         amount = COALESCE($5, amount),
         quantity = COALESCE($6, quantity),
         note = COALESCE($7, note)
       WHERE id = $8
       RETURNING *`,
      [type, scissor_type, customer_id, partner_id, amount, quantity, note, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// DELETE /api/transactions/:id (admin only) — removes a mistakenly-entered transaction.
// Blocked by the database if an invoice already references it (foreign key), reported
// back as a friendly 409 rather than a raw database error.
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM transactions WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'transaction not found' });
    }
    res.status(204).send();
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ error: 'this transaction has an invoice issued against it and cannot be deleted' });
    }
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

module.exports = router;
