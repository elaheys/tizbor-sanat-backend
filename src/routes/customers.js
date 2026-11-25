const express = require('express');
const router = express.Router();
const pool = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const validate = require('../middleware/validate');
const schemas = require('../schemas');

// GET /api/customers?q=search&page=&limit=
// Always alphabetical by name. `page`/`limit` are optional: omit both for the full matching
// list unchanged (used by InvoiceForm's and CustomerCombobox's pickers). Pass both to opt
// into page-based pagination — response shape then becomes { data, has_more }.
router.get('/', async (req, res) => {
  try {
    const { q, page, limit } = req.query;
    const conditions = [];
    const values = [];

    if (q) { values.push(`%${q}%`); conditions.push(`name ILIKE $${values.length}`); }

    const pageSize = limit ? parseInt(limit, 10) : null;
    const pageNum = page ? parseInt(page, 10) : null;

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = pageSize ? `LIMIT ${pageSize + 1} OFFSET ${(pageNum - 1) * pageSize}` : '';

    const result = await pool.query(
      `SELECT * FROM customers ${where} ORDER BY name ASC, id ASC ${limitClause}`,
      values
    );

    if (!pageSize) {
      return res.json(result.rows);
    }

    const hasMore = result.rows.length > pageSize;
    const data = hasMore ? result.rows.slice(0, pageSize) : result.rows;
    res.json({ data, has_more: hasMore });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// POST /api/customers (admin only)
router.post('/', requireAdmin, validate(schemas.createCustomer), async (req, res) => {
  try {
    const { name, phone } = req.body;

    const result = await pool.query(
      'INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING *',
      [name, phone || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// GET /api/customers/:id  (profile + pre-sale accounts + balances)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const customer = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);
    if (customer.rows.length === 0) {
      return res.status(404).json({ error: 'customer not found' });
    }

    const accounts = await pool.query(
      `SELECT ca.*, COALESCE(SUM(cp.amount), 0) AS paid_amount
       FROM customer_accounts ca
       LEFT JOIN customer_payments cp ON cp.customer_account_id = ca.id
       WHERE ca.customer_id = $1
       GROUP BY ca.id
       ORDER BY ca.created_at DESC`,
      [id]
    );

    res.json({ ...customer.rows[0], accounts: accounts.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// PATCH /api/customers/:id (admin only)
router.patch('/:id', requireAdmin, validate(schemas.updateCustomer), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone } = req.body;

    const result = await pool.query(
      `UPDATE customers SET name = COALESCE($1, name), phone = COALESCE($2, phone)
       WHERE id = $3 RETURNING *`,
      [name, phone, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'customer not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// DELETE /api/customers/:id (admin only) — blocked by the database (friendly 409, not a
// raw error) if the customer has any pre-sale account, transaction, or invoice on record.
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM customers WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'customer not found' });
    }
    res.status(204).send();
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ error: 'this customer has accounts, transactions, or invoices on record and cannot be deleted' });
    }
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

module.exports = router;
