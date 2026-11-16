const express = require('express');
const router = express.Router();
const pool = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const validate = require('../middleware/validate');
const schemas = require('../schemas');

// Generic view over partner_ledger — covers both loans and profit-settlement transfers,
// since both are "partner A owes partner B this amount" rows. /api/loans still exists as
// a loan-specific shortcut (POST/settle); this route is for listing across both types,
// and for the settled history view with a free date range.

// GET /api/partner-ledger?is_settled=&type=&partner_id= — generic listing, filterable by
// settlement state, type, and partner. partner_id matches either side of the transfer
// (a partner wants to see everything they owe OR are owed, not just one direction).
// The "loans and settlements" (active/open) page should always call this with
// ?is_settled=false — per the design, a settled row disappears from that active view and
// only lives on in /history below. Omitting is_settled here returns everything (useful
// for admin/debug views), so the frontend is responsible for passing the filter.
router.get('/', async (req, res) => {
  try {
    const { is_settled, type, partner_id } = req.query;
    const conditions = [];
    const values = [];

    if (is_settled !== undefined) {
      values.push(is_settled === 'true');
      conditions.push(`pl.is_settled = $${values.length}`);
    }
    if (type) {
      values.push(type);
      conditions.push(`pl.type = $${values.length}`);
    }
    if (partner_id) {
      values.push(partner_id);
      conditions.push(`(pl.from_partner_id = $${values.length} OR pl.to_partner_id = $${values.length})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT pl.*, fp.name AS from_partner_name, tp.name AS to_partner_name
       FROM partner_ledger pl
       JOIN partners fp ON fp.id = pl.from_partner_id
       JOIN partners tp ON tp.id = pl.to_partner_id
       ${where}
       ORDER BY pl.entry_date DESC`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// GET /api/partner-ledger/history?from=&to= — settled rows only, filtered by settlement date.
router.get('/history', async (req, res) => {
  try {
    const { from, to } = req.query;
    const conditions = [`pl.is_settled = true`];
    const values = [];

    if (from) { values.push(from); conditions.push(`pl.settled_at >= $${values.length}`); }
    if (to) { values.push(to); conditions.push(`pl.settled_at <= $${values.length}`); }

    const result = await pool.query(
      `SELECT pl.*, fp.name AS from_partner_name, tp.name AS to_partner_name
       FROM partner_ledger pl
       JOIN partners fp ON fp.id = pl.from_partner_id
       JOIN partners tp ON tp.id = pl.to_partner_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY pl.settled_at DESC`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// PATCH /api/partner-ledger/:id (admin only) — fix a mistake (wrong amount/note/date) in
// an entry that hasn't been settled yet. Once settled, a row is a closed historical
// record — fix a mistake there with a new, separate ledger entry instead of editing it.
router.patch('/:id', requireAdmin, validate(schemas.updateLedgerEntry), async (req, res) => {
  try {
    const { amount, entry_date, note } = req.body;

    const current = await pool.query('SELECT * FROM partner_ledger WHERE id = $1', [req.params.id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'ledger entry not found' });
    if (current.rows[0].is_settled) {
      return res.status(400).json({ error: 'a settled entry cannot be edited — record a new entry instead' });
    }

    const result = await pool.query(
      `UPDATE partner_ledger SET
         amount = COALESCE($1, amount),
         entry_date = COALESCE($2, entry_date),
         note = COALESCE($3, note)
       WHERE id = $4
       RETURNING *`,
      [amount, entry_date, note, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// DELETE /api/partner-ledger/:id (admin only) — removes a mistakenly-entered loan or
// settlement row. Same rule as PATCH above: a settled entry is a closed record and
// cannot be deleted.
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const current = await pool.query('SELECT * FROM partner_ledger WHERE id = $1', [req.params.id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'ledger entry not found' });
    if (current.rows[0].is_settled) {
      return res.status(400).json({ error: 'a settled entry cannot be deleted — it is a closed historical record' });
    }

    await pool.query('DELETE FROM partner_ledger WHERE id = $1', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

// PATCH /api/partner-ledger/:id/settle (admin only) — generic settle, works for either type.
router.patch('/:id/settle', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE partner_ledger SET is_settled = true, settled_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'ledger entry not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  }
});

module.exports = router;
