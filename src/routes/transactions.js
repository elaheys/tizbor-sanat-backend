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

module.exports = router;
