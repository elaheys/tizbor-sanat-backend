require('dotenv').config();
const pool = require('../src/db');

async function migrate() {
  // role distinguishes the one bookkeeper/admin (full edit rights, not a profit-sharing partner)
  // from the partners (view-only, see everyone's numbers, cannot change anything)
  await pool.query(`
    ALTER TABLE partners
      ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'partner'
        CHECK (role IN ('admin', 'partner'));
  `);

  // historical share percentages: a partner's share can change over time, but a month
  // that was already reported/settled must keep using the percentage that was valid THEN,
  // not whatever the percentage happens to be today.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_share_history (
      id SERIAL PRIMARY KEY,
      partner_id INTEGER NOT NULL REFERENCES partners(id),
      share_percent NUMERIC(5,2) NOT NULL,
      effective_from DATE NOT NULL DEFAULT CURRENT_DATE
    );
  `);

  // backfill: give every existing partner a history row starting from the beginning of time,
  // using whatever share_percent they currently have.
  await pool.query(`
    INSERT INTO partner_share_history (partner_id, share_percent, effective_from)
    SELECT id, share_percent, '2000-01-01'
    FROM partners
    WHERE NOT EXISTS (
      SELECT 1 FROM partner_share_history WHERE partner_share_history.partner_id = partners.id
    );
  `);

  console.log('Migration done: partners.role, partner_share_history (+ backfilled).');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
