const { z } = require('zod');

const login = z.object({
  username: z.string().min(1, 'username is required'),
  password: z.string().min(1, 'password is required'),
});

const changeOwnPassword = z.object({
  current_password: z.string().min(1, 'current_password is required'),
  new_password: z.string().min(8, 'new_password must be at least 8 characters'),
});

const resetPassword = z.object({
  new_password: z.string().min(8, 'new_password must be at least 8 characters'),
});

const ROLES = ['admin', 'partner'];

const createPartner = z.object({
  name: z.string().min(1, 'name is required'),
  role: z.enum(ROLES).optional(),
  share_percent: z.coerce.number().min(0).max(100).optional(),
});

const updatePartner = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(ROLES).optional(),
  // plain z.boolean(), NOT z.coerce.boolean() — coercion would turn the string "false"
  // into `true` (JS's Boolean("false") is true), silently re-activating a partner that
  // was meant to be deactivated. This is a JSON-only API, so the client always sends a
  // real JSON boolean; there's no legitimate case that needs string coercion here.
  is_active: z.boolean().optional(),
  share_percent: z.coerce.number().min(0).max(100).optional(),
});

const createCustomer = z.object({
  name: z.string().min(1, 'name is required'),
  phone: z.string().min(1).optional(),
});

const updateCustomer = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
});

const createCustomerAccount = z.object({
  customer_id: z.coerce.number().int().positive(),
  total_amount: z.coerce.number().positive(),
  description: z.string().optional(),
});

const createCustomerPayment = z.object({
  amount: z.coerce.number().positive(),
  paid_at: z.string().optional(),
});

const createLoan = z.object({
  from_partner_id: z.coerce.number().int().positive(),
  to_partner_id: z.coerce.number().int().positive(),
  amount: z.coerce.number().positive(),
  loan_date: z.string().optional(),
  note: z.string().optional(),
}).refine((data) => data.from_partner_id !== data.to_partner_id, {
  message: 'from_partner_id and to_partner_id must be different',
  path: ['to_partner_id'],
});

const updateLedgerEntry = z.object({
  amount: z.coerce.number().positive().optional(),
  entry_date: z.string().optional(),
  note: z.string().optional(),
});

const createInvoice = z.object({
  customer_id: z.coerce.number().int().positive().optional(),
  partner_id: z.coerce.number().int().positive(),
  transaction_id: z.coerce.number().int().positive().optional(),
  amount: z.coerce.number().positive(),
  description: z.string().optional(),
});

const TX_TYPES = ['sale', 'purchase', 'repair', 'exchange'];

const createTransaction = z.object({
  type: z.enum(TX_TYPES),
  scissor_type: z.string().min(1, 'scissor_type is required'),
  customer_id: z.coerce.number().int().positive().optional(),
  partner_id: z.coerce.number().int().positive(),
  amount: z.coerce.number().positive(),
  quantity: z.coerce.number().int().positive().optional(),
  note: z.string().optional(),
  created_at: z.coerce.date().optional(),
});

const updateTransaction = z.object({
  type: z.enum(TX_TYPES).optional(),
  scissor_type: z.string().min(1).optional(),
  customer_id: z.coerce.number().int().positive().nullable().optional(),
  partner_id: z.coerce.number().int().positive().optional(),
  amount: z.coerce.number().positive().optional(),
  quantity: z.coerce.number().int().positive().optional(),
  note: z.string().optional(),
});

module.exports = {
  login,
  changeOwnPassword,
  resetPassword,
  createPartner,
  updatePartner,
  createCustomer,
  updateCustomer,
  createCustomerAccount,
  createCustomerPayment,
  createLoan,
  updateLedgerEntry,
  createTransaction,
  updateTransaction,
  createInvoice,
};
