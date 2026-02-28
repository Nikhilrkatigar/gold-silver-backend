const mongoose = require('mongoose');

const itemTransactionSchema = new mongoose.Schema({
  itemId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Item',
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  action: {
    type: String,
    enum: ['created', 'edited', 'sold', 'override', 'deleted'],
    required: true,
    index: true
  },
  performedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  previousValues: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  newValues: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  metadata: {
    reason: String,
    ipAddress: String,
    userAgent: String
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: false
});

// Compound indexes for efficient queries
itemTransactionSchema.index({ itemId: 1, timestamp: -1 });
itemTransactionSchema.index({ userId: 1, timestamp: -1 });
itemTransactionSchema.index({ userId: 1, action: 1, timestamp: -1 });

module.exports = mongoose.model('ItemTransaction', itemTransactionSchema);
