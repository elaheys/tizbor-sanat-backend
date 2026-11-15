// generic request-body validator: pass a zod schema, get back an Express middleware.
// On success, req.body is replaced with the parsed/typed result (so e.g. z.coerce.number()
// fields become real numbers downstream, not strings). On failure, responds 400 with a
// flat list of field-level problems — never the raw zod error object (which can be verbose).
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(body)',
        message: issue.message,
      }));
      return res.status(400).json({ error: 'validation failed', details });
    }
    req.body = result.data;
    next();
  };
}

module.exports = validate;
