const mongoose = require('mongoose');

const karigarTransactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  date: {
    type: Date,
    required: true,
    default: Date.now
  },
  type: {
    type: String,
    enum: ['given', 'received'],
    required: true
  },
  karigarName: {
    type: String,
    required: true,
    trim: true
  },
  itemName: {
    type: String,
    required: true
  },
  metalType: {
    type: String,
    enum: ['gold', 'silver'],
    required: true
  },
  fineWeight: {
    type: Number,
    required: true
  },
  chargeAmount: {
    type: Number,
    default: 0
  },
  narration: {
    type: String,
    default: ''
  },
  isDeleted: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

karigarTransactionSchema.index({ userId: 1, date: -1 });
karigarTransactionSchema.index({ userId: 1, isDeleted: 1 });

module.exports = mongoose.model('Karigar', karigarTransactionSchema);