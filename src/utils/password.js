const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;

// bcrypt generates a fresh random salt per call automatically and embeds it in the
// output string, so a plain hashPassword(plain) call already gives every user a unique
// salt — nothing else needed.
function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
}

async function verifyPassword(hash, plainPassword) {
  if (!hash) return false;
  try {
    return await bcrypt.compare(plainPassword, hash);
  } catch (err) {
    // a malformed/foreign hash (e.g. a leftover argon2 hash from testing) throws
    // rather than returning false — treat that as "no match"
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
