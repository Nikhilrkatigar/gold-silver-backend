/**
 * Application Constants
 * Centralized configuration for magic numbers and constants
 */

module.exports = {
  // JWT Configuration
  JWT: {
    EXPIRY: '24h',
    SECRET_KEY: process.env.JWT_SECRET || 'your-secret-key'
  },

  // Credit Payment Configuration
  CREDIT_PAYMENT: {
    DUE_DAYS: 5,
    DEFAULT_INTEREST_RATE: 0
  },

  // Reversal Policy
  // Set REVERSAL_WINDOW_HOURS in environment (e.g., 24 or 48).
  REVERSAL_POLICY: {
    WINDOW_HOURS: Number(process.env.REVERSAL_WINDOW_HOURS || 48)
  },

  // Stock Configuration
  STOCK: {
    MIN_ALLOWED: 0,
    PRECISION_DECIMALS: 3
  },

  // Settlement Direction
  SETTLEMENT_DIRECTION: {
    RECEIPT: 'receipt',  // Customer gave fine
    PAYMENT: 'payment'   // Customer took fine
  },

  // Payment Types
  PAYMENT_TYPE: {
    CASH: 'cash',
    CREDIT: 'credit'
  },

  // Invoice Type
  INVOICE_TYPE: {
    NORMAL: 'normal',
    GST: 'gst'
  },

  // Metal Types
  METAL_TYPE: {
    GOLD: 'gold',
    SILVER: 'silver'
  },

  // GST Configuration
  GST: {
    RATES: [0, 3, 5, 12, 18],
    DEFAULT_RATE: 18,
    FORMAT_REGEX: /^\d{2}[A-Z]{5}\d{4}[A-Z0-9]{4}$/,
    LENGTH: 15,
    STATE_CODE_LENGTH: 2
  },

  // Pagination
  PAGINATION: {
    DEFAULT_LIMIT: 20,
    DEFAULT_PAGE: 1,
    MAX_LIMIT: 100
  },

  // License
  LICENSE: {
    DEFAULT_DAYS: 30,
    EXPIRY_WARNING_DAYS: 7
  },

  // Validation Rules
  VALIDATION: {
    PHONE_REGEX: /^[0-9]{10}$/,
    PASSWORD_MIN_LENGTH: 6,
    PASSWORD_REGEX: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/,
    NAME_MIN_LENGTH: 2,
    NAME_MAX_LENGTH: 100,
    AMOUNT_PRECISION: 2,
    WEIGHT_PRECISION: 3
  },

  // HTTP Status Codes
  HTTP_STATUS: {
    OK: 200,
    CREATED: 201,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    INTERNAL_ERROR: 500
  },

  // Error Messages
  ERROR_MESSAGES: {
    INVALID_CREDENTIALS: 'Invalid phone number or password',
    INSUFFICIENT_STOCK: 'Insufficient stock available',
    INSUFFICIENT_BALANCE: 'Insufficient balance for this transaction',
    DUPLICATE_INVOICE: 'Invoice number already exists',
    INVALID_PHONE: 'Phone number must be 10 digits',
    INVALID_PASSWORD: 'Password must be at least 8 characters with uppercase, lowercase, digit and special character',
    INVALID_GST: 'Invalid GST number format (e.g., 29AABCR1718E1ZL)',
    LICENSE_EXPIRED: 'License expired. Please contact admin.',
    UNAUTHORIZED: 'Unauthorized access',
    SERVER_ERROR: 'Internal server error'
  }
};
