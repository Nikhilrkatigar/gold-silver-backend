const mongoose = require('mongoose');

const ledgerSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  phoneNumber: {
    type: String,
    required: true,
    trim: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
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
    }
  },
  hasVouchers: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Index for faster queries
ledgerSchema.index({ userId: 1, name: 1 });
ledgerSchema.index({ userId: 1, phoneNumber: 1 });

module.exports = mongoose.model('Ledger', ledgerSchema);
