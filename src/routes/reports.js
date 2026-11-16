const express = require('express');
const router = express.Router();
const pool = require('../db');
const { withTransaction } = require('../db');
const requireAdmin = require('../middleware/requireAdmin');

// transaction types that bring money IN (sale, repair fee, exchange price-difference)
const REVENUE_TYPES = ['sale', 'repair', 'exchange'];

// There is no central cash fund in this workshop: when a sale happens, the cash sits
// with whichever partner recorded it. So after profit is split by share percentage,
// whoever collected MORE cash than their fair share must hand the difference to
// whoever collected LESS. This turns each partner's (cash collected - profit due)
// difference into the smallest possible set of direct partner-to-partner transfers —
// e.g. [+30, +10, -40] becomes one transfer of 30 and one of 10 into the deficit partner,
// never a three-way split that would need a middleman.
function computeTransfers(diffs) {
  const EPSILON = 1; // sub-toman rounding noise from profit-share division, ignore it
  const payers = diffs
    .filter((d) => d.diff > EPSILON)
    .map((d) => ({ partner_id: d.partner_id, remaining: d.diff }))
    .sort((a, b) => b.remaining - a.remaining);
  const receivers = diffs
    .filter((d) => d.diff < -EPSILON)
    .map((d) => ({ partner_id: d.partner_id, remaining: -d.diff }))
    .sort((a, b) => b.remaining - a.remaining);

  const transfers = [];
  let i = 0;
  let j = 0;
  while (i < payers.length && j < receivers.length) {
    const payer = payers[i];
    const receiver = receivers[j];
    const amount = Math.round(Math.min(payer.remaining, receiver.remaining));
    if (amount > 0) {
      transfers.push({ from_partner_id: payer.partner_id, to_partner_id: receiver.partner_id, amount });
    }
    payer.remaining -= amount;
    receiver.remaining -= amount;
    if (payer.remaining <= EPSILON) i += 1;
    if (receiver.remaining <= EPSILON) j += 1;
  }
  return transfers;
}

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

    // the bookkeeper/admin is not a profit-sharing partner, so they never appear in the split
    const partners = await pool.query("SELECT * FROM partners WHERE role = 'partner' AND is_active = true ORDER BY id");

    // last day of the requested month, used to look up each partner's share AS IT WAS THEN
    const monthEndDate = `${year}-${String(month).padStart(2, '0')}-28`;

    // how much cash each partner actually collected this month (revenue minus purchases
    // they personally recorded) — this is what "they are physically holding" right now
    const cashCollected = await pool.query(
      `SELECT partner_id,
              COALESCE(SUM(CASE WHEN type = ANY($1) THEN amount ELSE -amount END), 0) AS net
       FROM transactions
       WHERE EXTRACT(YEAR FROM created_at) = $2 AND EXTRACT(MONTH FROM created_at) = $3
       GROUP BY partner_id`,
      [REVENUE_TYPES, year, month]
    );
    const cashByPartner = new Map(cashCollected.rows.map((r) => [r.partner_id, Number(r.net)]));

    const breakdown = [];
    const diffs = [];
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

      // open balance carried from before this month: the net of any still-unsettled
      // profit-settlement transfers involving this partner (replaces the old
      // monthly_balances.opening_balance/is_settled carry-over)
      const carry = await pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN to_partner_id = $1 THEN amount ELSE 0 END), 0) AS owed_to,
           COALESCE(SUM(CASE WHEN from_partner_id = $1 THEN amount ELSE 0 END), 0) AS owed_by
         FROM partner_ledger
         WHERE type = 'profit_settlement' AND is_settled = false
           AND (to_partner_id = $1 OR from_partner_id = $1)
           AND (period_year < $2 OR (period_year = $2 AND period_month < $3))`,
        [partner.id, year, month]
      );
      const openingBalance = Number(carry.rows[0].owed_to) - Number(carry.rows[0].owed_by);

      const loanBalance = await pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN from_partner_id = $1 THEN amount ELSE 0 END), 0) AS lent,
           COALESCE(SUM(CASE WHEN to_partner_id = $1 THEN amount ELSE 0 END), 0) AS borrowed
         FROM partner_ledger
         WHERE type = 'loan' AND is_settled = false AND (from_partner_id = $1 OR to_partner_id = $1)`,
        [partner.id]
      );
      const netLoanBalance = Number(loanBalance.rows[0].lent) - Number(loanBalance.rows[0].borrowed);

      const closingBalance = openingBalance + profitShare + netLoanBalance;

      // save/update this month's snapshot — informational history only; it is no longer
      // the source of truth for carry-over (partner_ledger is), see openingBalance above
      await pool.query(
        `INSERT INTO monthly_balances (partner_id, year, month, opening_balance, profit_share, closing_balance, is_settled)
         VALUES ($1, $2, $3, $4, $5, $6, false)
         ON CONFLICT (partner_id, year, month)
         DO UPDATE SET opening_balance = $4, profit_share = $5, closing_balance = $6`,
        [partner.id, year, month, openingBalance, profitShare, closingBalance]
      );

      const cashHeld = cashByPartner.get(partner.id) || 0;
      const settlementDiff = cashHeld - profitShare; // + means holds surplus and must pay out

      diffs.push({ partner_id: partner.id, diff: settlementDiff });

      breakdown.push({
        partner_id: partner.id,
        partner_name: partner.name,
        share_percent: sharePercent,
        opening_balance: openingBalance,
        profit_share: profitShare,
        net_loan_balance: netLoanBalance,
        closing_balance: closingBalance,
        cash_collected: cashHeld,
        settlement_diff: settlementDiff,
      });
    }

    // preview only — NOT persisted here. POST .../settlements below creates the actual
    // partner_ledger rows (so a report can be viewed repeatedly without side effects)
    const neededTransfers = computeTransfers(diffs).map((t) => ({
      ...t,
      from_partner_name: partners.rows.find((p) => p.id === t.from_partner_id)?.name,
      to_partner_name: partners.rows.find((p) => p.id === t.to_partner_id)?.name,
    }));

    res.json({
      year,
      month,
      total_revenue: totalRevenue,
      total_expense: totalExpense,
      profit,
      partners: breakdown,
      needed_transfers: neededTransfers,
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

// POST /api/reports/monthly/:year/:month/settlements (admin only)
// Turns that month's cash-vs-share imbalance into real, settleable partner_ledger rows.
// Idempotent: calling it again for a month that was already generated just returns the
// existing rows instead of creating duplicates.
router.post('/monthly/:year/:month/settlements', requireAdmin, async (req, res) => {
  try {
    const year = parseInt(req.params.year, 10);
    const month = parseInt(req.params.month, 10);
    if (!year || !month) {
      return res.status(400).json({ error: 'invalid year/month' });
    }

    // The whole read-compute-insert sequence runs in one SERIALIZABLE transaction: if two
    // requests for the same month somehow overlap (e.g. a double-click without an
    // Idempotency-Key), Postgres aborts the loser with a serialization error instead of
    // letting both insert their own full set of transfers.
    const outcome = await withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');

      const existing = await client.query(
        `SELECT pl.*, fp.name AS from_partner_name, tp.name AS to_partner_name
         FROM partner_ledger pl
         JOIN partners fp ON fp.id = pl.from_partner_id
         JOIN partners tp ON tp.id = pl.to_partner_id
         WHERE pl.type = 'profit_settlement' AND pl.period_year = $1 AND pl.period_month = $2`,
        [year, month]
      );
      if (existing.rows.length > 0) {
        return { already_generated: true, settlements: existing.rows };
      }

      const totalRevenue = Number(
        (await client.query(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
           WHERE type = ANY($1) AND EXTRACT(YEAR FROM created_at) = $2 AND EXTRACT(MONTH FROM created_at) = $3`,
          [REVENUE_TYPES, year, month]
        )).rows[0].total
      );
      const totalExpense = Number(
        (await client.query(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
           WHERE type = 'purchase' AND EXTRACT(YEAR FROM created_at) = $1 AND EXTRACT(MONTH FROM created_at) = $2`,
          [year, month]
        )).rows[0].total
      );
      const profit = totalRevenue - totalExpense;

      const partners = await client.query("SELECT * FROM partners WHERE role = 'partner' AND is_active = true ORDER BY id");
      const monthEndDate = `${year}-${String(month).padStart(2, '0')}-28`;

      const cashCollected = await client.query(
        `SELECT partner_id,
                COALESCE(SUM(CASE WHEN type = ANY($1) THEN amount ELSE -amount END), 0) AS net
         FROM transactions
         WHERE EXTRACT(YEAR FROM created_at) = $2 AND EXTRACT(MONTH FROM created_at) = $3
         GROUP BY partner_id`,
        [REVENUE_TYPES, year, month]
      );
      const cashByPartner = new Map(cashCollected.rows.map((r) => [r.partner_id, Number(r.net)]));

      const diffs = [];
      for (const partner of partners.rows) {
        const historicalShare = await client.query(
          `SELECT share_percent FROM partner_share_history
           WHERE partner_id = $1 AND effective_from <= $2
           ORDER BY effective_from DESC LIMIT 1`,
          [partner.id, monthEndDate]
        );
        const sharePercent = historicalShare.rows.length
          ? Number(historicalShare.rows[0].share_percent)
          : Number(partner.share_percent);
        const profitShare = Math.round(profit * (sharePercent / 100));
        const cashHeld = cashByPartner.get(partner.id) || 0;
        diffs.push({ partner_id: partner.id, diff: cashHeld - profitShare });
      }

      const transfers = computeTransfers(diffs);

      const inserted = [];
      for (const t of transfers) {
        const row = await client.query(
          `INSERT INTO partner_ledger (from_partner_id, to_partner_id, amount, type, period_year, period_month)
           VALUES ($1, $2, $3, 'profit_settlement', $4, $5) RETURNING *`,
          [t.from_partner_id, t.to_partner_id, t.amount, year, month]
        );
        inserted.push(row.rows[0]);
      }

      return { already_generated: false, settlements: inserted };
    });

    res.status(outcome.already_generated ? 200 : 201).json(outcome);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// GET /api/reports/transactions-summary?year=&month=  (or ?from=&to=)
// Count + total amount per transaction type — the "transactions broken down by type" detail on the report page.
router.get('/transactions-summary', async (req, res) => {
  try {
    const { year, month, from, to } = req.query;
    const conditions = [];
    const values = [];

    if (year && month) {
      values.push(Number(year), Number(month));
      conditions.push(`EXTRACT(YEAR FROM created_at) = $${values.length - 1}`);
      conditions.push(`EXTRACT(MONTH FROM created_at) = $${values.length}`);
    } else {
      if (from) { values.push(from); conditions.push(`created_at >= $${values.length}`); }
      if (to) { values.push(to); conditions.push(`created_at <= $${values.length}`); }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT type, COUNT(*)::int AS count, COALESCE(SUM(amount), 0) AS total
       FROM transactions
       ${where}
       GROUP BY type
       ORDER BY type`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// GET /api/reports/customers-open-balance
// Every customer with a pre-sale/installment account that isn't fully paid off yet —
// the "customer balances" detail on the report page.
router.get('/customers-open-balance', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id AS customer_id, c.name AS customer_name, c.phone,
              ca.id AS account_id, ca.description, ca.total_amount,
              COALESCE(SUM(cp.amount), 0) AS paid_amount,
              ca.total_amount - COALESCE(SUM(cp.amount), 0) AS remaining_balance
       FROM customer_accounts ca
       JOIN customers c ON c.id = ca.customer_id
       LEFT JOIN customer_payments cp ON cp.customer_account_id = ca.id
       GROUP BY c.id, c.name, c.phone, ca.id, ca.description, ca.total_amount
       HAVING ca.total_amount - COALESCE(SUM(cp.amount), 0) > 0
       ORDER BY remaining_balance DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// GET /api/reports/daily?date=YYYY-MM-DD
// Per-partner and workshop-wide revenue/expense for one day — the dashboard's "today" stat,
// generalized to any date.
router.get('/daily', async (req, res) => {
  try {
    const date = req.query.date;
    if (!date) {
      return res.status(400).json({ error: 'date query param is required (YYYY-MM-DD)' });
    }

    const perPartner = await pool.query(
      `SELECT p.id AS partner_id, p.name AS partner_name,
              COALESCE(SUM(CASE WHEN t.type = ANY($2) THEN t.amount ELSE 0 END), 0) AS revenue,
              COALESCE(SUM(CASE WHEN t.type = 'purchase' THEN t.amount ELSE 0 END), 0) AS expense,
              COUNT(t.id)::int AS transaction_count
       FROM partners p
       LEFT JOIN transactions t ON t.partner_id = p.id AND t.created_at::date = $1
       WHERE p.role = 'partner' AND p.is_active = true
       GROUP BY p.id, p.name
       ORDER BY p.id`,
      [date, REVENUE_TYPES]
    );

    const totals = perPartner.rows.reduce(
      (acc, r) => ({
        revenue: acc.revenue + Number(r.revenue),
        expense: acc.expense + Number(r.expense),
        transaction_count: acc.transaction_count + Number(r.transaction_count),
      }),
      { revenue: 0, expense: 0, transaction_count: 0 }
    );

    res.json({
      date,
      partners: perPartner.rows.map((r) => ({
        partner_id: r.partner_id,
        partner_name: r.partner_name,
        revenue: Number(r.revenue),
        expense: Number(r.expense),
        transaction_count: r.transaction_count,
      })),
      workshop_total: {
        revenue: totals.revenue,
        expense: totals.expense,
        profit: totals.revenue - totals.expense,
        transaction_count: totals.transaction_count,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

module.exports = router;
