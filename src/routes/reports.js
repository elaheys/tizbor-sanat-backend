const express = require('express');
const router = express.Router();
const pool = require('../db');
const requireAdmin = require('../middleware/requireAdmin');

// transaction types that bring money IN (sale, repair fee, exchange price-difference)
const REVENUE_TYPES = ['sale', 'repair', 'exchange'];

// GET /api/reports/monthly?year=2026&month=8
router.get('/monthly', async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10); // 1-12
    if (!year || !month) {
      return res.status(400).json({ error: 'year and month query params are required' });
    }

    // 1) company-wide revenue and expense for the month
    const revenueResult = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM transactions
       WHERE type = ANY($1)
         AND EXTRACT(YEAR FROM created_at) = $2
         AND EXTRACT(MONTH FROM created_at) = $3`,
      [REVENUE_TYPES, year, month]
    );
    const expenseResult = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM transactions
       WHERE type = 'purchase'
         AND EXTRACT(YEAR FROM created_at) = $1
         AND EXTRACT(MONTH FROM created_at) = $2`,
      [year, month]
    );

    const totalRevenue = Number(revenueResult.rows[0].total);
    const totalExpense = Number(expenseResult.rows[0].total);
    const profit = totalRevenue - totalExpense;

    // 2) previous month, to look up the balance carried over
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;

    // the bookkeeper/admin is not a profit-sharing partner, so they never appear in the split
    const partners = await pool.query("SELECT * FROM partners WHERE role = 'partner' ORDER BY id");

    // last day of the requested month, used to look up each partner's share AS IT WAS THEN
    const monthEndDate = `${year}-${String(month).padStart(2, '0')}-28`;

    const breakdown = [];
    for (const partner of partners.rows) {
      const historicalShare = await pool.query(
        `SELECT share_percent FROM partner_share_history
         WHERE partner_id = $1 AND effective_from <= $2
         ORDER BY effective_from DESC LIMIT 1`,
        [partner.id, monthEndDate]
      );
      const sharePercent = historicalShare.rows.length
        ? Number(historicalShare.rows[0].share_percent)
        : Number(partner.share_percent); // fallback, shouldn't normally happen

      const profitShare = Math.round(profit * (sharePercent / 100));

      const prevBalance = await pool.query(
        'SELECT closing_balance, is_settled FROM monthly_balances WHERE partner_id = $1 AND year = $2 AND month = $3',
        [partner.id, prevYear, prevMonth]
      );
      const openingBalance = prevBalance.rows.length && !prevBalance.rows[0].is_settled
        ? Number(prevBalance.rows[0].closing_balance)
        : 0;

      const loanBalance = await pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN from_partner_id = $1 THEN amount ELSE 0 END), 0) AS lent,
           COALESCE(SUM(CASE WHEN to_partner_id = $1 THEN amount ELSE 0 END), 0) AS borrowed
         FROM loans
         WHERE is_settled = false AND (from_partner_id = $1 OR to_partner_id = $1)`,
        [partner.id]
      );
      const netLoanBalance = Number(loanBalance.rows[0].lent) - Number(loanBalance.rows[0].borrowed);

      const closingBalance = openingBalance + profitShare + netLoanBalance;

      // save/update this month's snapshot so it can be looked up as "previous month" later
      await pool.query(
        `INSERT INTO monthly_balances (partner_id, year, month, opening_balance, profit_share, closing_balance, is_settled)
         VALUES ($1, $2, $3, $4, $5, $6, false)
         ON CONFLICT (partner_id, year, month)
         DO UPDATE SET opening_balance = $4, profit_share = $5, closing_balance = $6`,
        [partner.id, year, month, openingBalance, profitShare, closingBalance]
      );

      breakdown.push({
        partner_id: partner.id,
        partner_name: partner.name,
        share_percent: sharePercent,
        opening_balance: openingBalance,
        profit_share: profitShare,
        net_loan_balance: netLoanBalance,
        closing_balance: closingBalance,
      });
    }

    res.json({
      year,
      month,
      total_revenue: totalRevenue,
      total_expense: totalExpense,
      profit,
      partners: breakdown,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// PATCH /api/reports/monthly/:partnerId/settle?year=&month=
router.patch('/monthly/:partnerId/settle', requireAdmin, async (req, res) => {
  try {
    const { partnerId } = req.params;
    const { year, month } = req.query;

    const result = await pool.query(
      `UPDATE monthly_balances SET is_settled = true
       WHERE partner_id = $1 AND year = $2 AND month = $3 RETURNING *`,
      [partnerId, year, month]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'balance record not found for that partner/year/month' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

module.exports = router;
