const express = require('express');
const router = express.Router();
const pool = require('../db');
const { withTransaction } = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const validate = require('../middleware/validate');
const idempotent = require('../middleware/idempotency');
const schemas = require('../schemas');

// GET /api/invoices?customer_id=&partner_id=&from=&to=
router.get('/', async (req, res) => {
  try {
    const { customer_id, partner_id, from, to } = req.query;
    const conditions = [];
    const values = [];

    if (customer_id) { values.push(customer_id); conditions.push(`i.customer_id = $${values.length}`); }
    if (partner_id) { values.push(partner_id); conditions.push(`i.partner_id = $${values.length}`); }
    if (from) { values.push(from); conditions.push(`i.issued_at >= $${values.length}`); }
    if (to) { values.push(to); conditions.push(`i.issued_at <= $${values.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT i.*, c.name AS customer_name, p.name AS partner_name
       FROM invoices i
       LEFT JOIN customers c ON c.id = i.customer_id
       JOIN partners p ON p.id = i.partner_id
       ${where}
       ORDER BY i.issued_at DESC`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// GET /api/invoices/:id
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT i.*, c.name AS customer_name, p.name AS partner_name
       FROM invoices i
       LEFT JOIN customers c ON c.id = i.customer_id
       JOIN partners p ON p.id = i.partner_id
       WHERE i.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'invoice not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// POST /api/invoices (admin only) — invoice_number is generated server-side from the row's
// own id (never client-supplied), so two admins issuing an invoice at the same instant can
// never collide on the same number.
router.post('/', requireAdmin, idempotent, validate(schemas.createInvoice), async (req, res) => {
  try {
    const { customer_id, partner_id, transaction_id, amount, description } = req.body;

    // insert + number-assignment must commit together — a crash between them must not
    // leave a numberless invoice behind
    const invoice = await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO invoices (customer_id, partner_id, transaction_id, amount, description)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [customer_id || null, partner_id, transaction_id || null, amount, description || null]
      );

      const numbered = await client.query(
        `UPDATE invoices SET invoice_number = 'INV-' || LPAD(id::text, 5, '0') WHERE id = $1 RETURNING *`,
        [inserted.rows[0].id]
      );
      return numbered.rows[0];
    });

    res.status(201).json(invoice);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

module.exports = router;
