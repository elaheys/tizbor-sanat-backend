const express = require('express');
const router = express.Router();
const pool = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const validate = require('../middleware/validate');
const idempotent = require('../middleware/idempotency');
const schemas = require('../schemas');

// POST /api/customer-accounts (admin only) — open a new pre-sale / installment account
router.post('/', requireAdmin, idempotent, validate(schemas.createCustomerAccount), async (req, res) => {
  try {
    const { customer_id, total_amount, description } = req.body;

    const result = await pool.query(
      `INSERT INTO customer_accounts (customer_id, total_amount, description)
       VALUES ($1, $2, $3) RETURNING *`,
      [customer_id, total_amount, description || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// GET /api/customer-accounts/:id  (with payments + remaining balance)
router.get('/:id', async (req, res) => {
  try {
    const account = await pool.query('SELECT * FROM customer_accounts WHERE id = $1', [req.params.id]);
    if (account.rows.length === 0) {
      return res.status(404).json({ error: 'account not found' });
    }

    const payments = await pool.query(
      'SELECT * FROM customer_payments WHERE customer_account_id = $1 ORDER BY paid_at',
      [req.params.id]
    );
    const paid = payments.rows.reduce((sum, p) => sum + Number(p.amount), 0);

    res.json({
      ...account.rows[0],
      payments: payments.rows,
      paid_amount: paid,
      remaining_balance: Number(account.rows[0].total_amount) - paid,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// POST /api/customer-accounts/:id/payments (admin only) — register an installment payment
router.post('/:id/payments', requireAdmin, idempotent, validate(schemas.createCustomerPayment), async (req, res) => {
  try {
    const { amount, paid_at } = req.body;

    const result = await pool.query(
      `INSERT INTO customer_payments (customer_account_id, amount, paid_at)
       VALUES ($1, $2, COALESCE($3, CURRENT_DATE)) RETURNING *`,
      [req.params.id, amount, paid_at || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

module.exports = router;
