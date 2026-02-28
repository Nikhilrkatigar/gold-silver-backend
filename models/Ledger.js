const mongoose = require('mongoose');

const ledgerSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  phoneNumber: {
    type: String,
    required: false,
    trim: true,
    validate: {
      validator: function (v) {
        // Allow empty string or 10 digits
        if (!v || v === '') return true;
        return /^[0-9]{10}$/.test(v);
      },
      message: 'Phone number must be 10 digits or empty'
    }
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  ledgerType: {
    type: String,
    enum: ['regular', 'gst'],
    default: 'regular'
  },
  gstDetails: {
    hasGST: {
      type: Boolean,
      default: false
    },
    gstNumber: {
      type: String,
      trim: true,
      sparse: true,
      validate: {
        validator: function (v) {
          if (!v) return !this.gstDetails.hasGST;
          // Format: 2 digits (state) + 5 letters (PAN) + 4 digits (entity) + 4 alphanumeric (check/filler)
          return /^\d{2}[A-Z]{5}\d{4}[A-Z0-9]{4}$/.test(v);
        },
        message: 'Invalid GST number format (e.g., 29AABCR1718E1ZL)'
      }
    },
    stateCode: {
      type: String,
      trim: true,
      sparse: true,
      match: [/^\d{2}$/, 'State code must be 2 digits']
    }
  },
  openingBalance: {
    amount: {
      type: Number,
      default: 0
    },
    goldFineWeight: {
      type: Number,
      default: 0
    },
    silverFineWeight: {
      type: Number,
      default: 0
    }
  },
  balances: {
    goldFineWeight: {
      type: Number,
      default: 0
    },
    silverFineWeight: {
      type: Number,
      default: 0
    },
    amount: {
      type: Number,
      default: 0
    },
    cashBalance: {
      type: Number,
      default: 0
    },
    creditBalance: {
      type: Number,
      default: 0
    }
  },
  hasVouchers: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

ledgerSchema.pre('validate', function normalizeFields(next) {
  if (this.phoneNumber) {
    this.phoneNumber = String(this.phoneNumber).replace(/\D/g, '');
  }
  if (this.gstDetails?.gstNumber) {
    this.gstDetails.gstNumber = this.gstDetails.gstNumber.toUpperCase();
  }
  if (this.gstDetails?.stateCode) {
    this.gstDetails.stateCode = String(this.gstDetails.stateCode).padStart(2, '0');
  }
  next();
});

// Index for faster queries
ledgerSchema.index({ userId: 1, name: 1 });
ledgerSchema.index({ userId: 1, phoneNumber: 1 });
ledgerSchema.index({ userId: 1, ledgerType: 1 });

module.exports = mongoose.model('Ledger', ledgerSchema);
