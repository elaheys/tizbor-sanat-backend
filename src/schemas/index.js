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
  is_active: z.coerce.boolean().optional(),
  share_percent: z.coerce.number().min(0).max(100).optional(),
});

const createCustomer = z.object({
  name: z.string().min(1, 'name is required'),
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
}).refine((data) => data.from_partner_id !== data.to_partner_id, {
  message: 'from_partner_id and to_partner_id must be different',
  path: ['to_partner_id'],
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
});

module.exports = {
  login,
  changeOwnPassword,
  resetPassword,
  createPartner,
  updatePartner,
  createCustomer,
  createCustomerAccount,
  createCustomerPayment,
  createLoan,
  createTransaction,
};
