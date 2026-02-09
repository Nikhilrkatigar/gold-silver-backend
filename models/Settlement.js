const mongoose = require('mongoose');

const settlementSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  ledgerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Ledger',
    required: true
  },
  customerName: {
    type: String,
    required: true
  },
  date: {
    type: Date,
    required: true,
    default: Date.now
  },
  metalType: {
    type: String,
    enum: ['gold', 'silver'],
    required: true
  },
  balanceBefore: {
    type: Number,
    required: true
  },
  metalRate: {
    type: Number,
    required: true
  },
  fineGiven: {
    type: Number,
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  balanceAfter: {
    amount: {
      type: Number,
      required: true
    },
    fineWeight: {
      type: Number,
      required: true
    }
  },
  narration: {
    type: String,
    default: ''
  },
  direction: {
    type: String,
    enum: ['receipt', 'payment'],
    required: true,
    default: 'payment',
    description: 'receipt = customer gave fine, payment = customer took fine'
  }
}, {
  timestamps: true
});

// Index for efficient queries
settlementSchema.index({ userId: 1, ledgerId: 1 });
settlementSchema.index({ userId: 1, date: -1 });

module.exports = mongoose.model('Settlement', settlementSchema);
