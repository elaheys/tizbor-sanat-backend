// Usage: node scripts/set_password.js <partner_id> <username> <password>
// Example: node scripts/set_password.js 1 ali Str0ngPass!2026
// (id 6 = the bookkeeper/admin account; ids 1-3 = the 3 partners; id 4 = reserved for a future 4th partner)
require('dotenv').config();
const pool = require('../src/db');
const { hashPassword } = require('../src/utils/password');

async function main() {
  const [, , partnerId, username, password] = process.argv;

  if (!partnerId || !username || !password) {
    console.log('Usage: node scripts/set_password.js <partner_id> <username> <password>');
    process.exit(1);
  }
  if (password.length < 8) {
    console.log('Password must be at least 8 characters.');
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const result = await pool.query(
    'UPDATE partners SET username = $1, password_hash = $2 WHERE id = $3 RETURNING id, name, username',
    [username, passwordHash, partnerId]
  );

  if (result.rows.length === 0) {
    console.log('No partner found with id', partnerId);
  } else {
    console.log('Login set for:', result.rows[0]);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
