require('dotenv').config();
const pool = require('../src/db');

async function migrate() {
  await pool.query(`
    ALTER TABLE partners
      ADD COLUMN IF NOT EXISTS username TEXT UNIQUE,
      ADD COLUMN IF NOT EXISTS password_hash TEXT;
  `);
  console.log('Migration done: partners.username and partners.password_hash added.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
