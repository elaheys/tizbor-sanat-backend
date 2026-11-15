const rateLimit = require('express-rate-limit');

// slows down brute-force guessing against login and password-change endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many attempts — please try again later' },
});

module.exports = authLimiter;
