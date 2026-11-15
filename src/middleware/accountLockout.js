// Tracks failed logins PER USERNAME, independent of IP — the IP-based rate limiter
// (authLimiter) alone doesn't stop an attacker spreading guesses across many IPs
// (a botnet, rotating VPNs) at one specific account. This closes that gap.
//
// In-memory only: fine for this app's scale (a handful of accounts), and a restart
// clearing lockouts is an acceptable tradeoff. A multi-instance deployment would need
// this moved to a shared store (Redis) instead of process memory.

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // failures older than this don't count

const attemptsByUsername = new Map(); // username -> { count, firstFailAt, lockedUntil }

function isLocked(username) {
  const entry = attemptsByUsername.get(username);
  if (!entry || !entry.lockedUntil) return false;
  if (Date.now() >= entry.lockedUntil) {
    attemptsByUsername.delete(username); // lockout expired — start clean
    return false;
  }
  return true;
}

function msUntilUnlock(username) {
  const entry = attemptsByUsername.get(username);
  if (!entry || !entry.lockedUntil) return 0;
  return Math.max(0, entry.lockedUntil - Date.now());
}

function recordFailure(username) {
  const now = Date.now();
  const entry = attemptsByUsername.get(username);

  if (!entry || now - entry.firstFailAt > ATTEMPT_WINDOW_MS) {
    attemptsByUsername.set(username, { count: 1, firstFailAt: now, lockedUntil: null });
    return;
  }

  entry.count += 1;
  if (entry.count >= MAX_FAILED_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_MS;
  }
}

function clearFailures(username) {
  attemptsByUsername.delete(username);
}

module.exports = { isLocked, msUntilUnlock, recordFailure, clearFailures };
