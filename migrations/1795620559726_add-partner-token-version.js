/* eslint-disable camelcase */

// Bumped every time a partner's password changes (self-service or admin reset) so every
// JWT issued before that point can be rejected — see requireAuth, which compares the
// token_version a JWT was signed with against the current value here.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE partners ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE partners DROP COLUMN IF EXISTS token_version;`);
};
