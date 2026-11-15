const express = require('express');
const router = express.Router();
const pool = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const validate = require('../middleware/validate');
const schemas = require('../schemas');

// GET /api/customers?q=search
router.get('/', async (req, res) => {
  try {
    const { q } = req.query;
    const result = q
      ? await pool.query('SELECT * FROM customers WHERE name ILIKE $1 ORDER BY name', [`%${q}%`])
      : await pool.query('SELECT * FROM customers ORDER BY name');
    res.json(result.rows);
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

module.exports = router;
