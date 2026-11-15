// must run AFTER requireAuth, since it relies on req.partner being set already.
// partners (role 'partner') can read everything but cannot create/edit/settle anything —
// only the single bookkeeper/admin account can.
function requireAdmin(req, res, next) {
  if (!req.partner || req.partner.role !== 'admin') {
    return res.status(403).json({ error: 'only the admin account can perform this action' });
  }
  next();
}

module.exports = requireAdmin;
