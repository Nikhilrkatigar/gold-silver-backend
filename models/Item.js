const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  itemCode: {
    type: String,
    required: true,
    unique: true,
    sparse: true,
    trim: true,
    uppercase: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  metal: {
    type: String,
    enum: ['gold', 'silver'],
    required: true,
    index: true
  },
  purity: {
    type: String,
    required: true,
    trim: true
  },
  grossWeight: {
    type: Number,
    required: true,
    min: 0
  },
  lessWeight: {
    type: Number,
    default: 0,
    min: 0
  },
  netWeight: {
    type: Number,
    required: true,
    min: 0
  },
  meltingPercent: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  wastage: {
    type: Number,
    default: 0,
    min: 0
  },
  labour: {
    type: Number,
    default: 0,
    min: 0
  },
  // Purchase rate per gram (₹/g) at time of item creation/acquisition
  purchaseRate: {
    type: Number,
    default: 0,
    min: 0
  },
  // Total cost price = (netWeight × purchaseRate) + labour
  costPrice: {
    type: Number,
    default: 0,
    min: 0
  },
  categoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category',
    required: true,
    index: true
  },
  qrCodePath: {
    type: String,
    sparse: true
  },
  // BIS Hallmark Unique Identification — 6-char alphanumeric code
  huid: {
    type: String,
    trim: true,
    uppercase: true,
    sparse: true,
    index: true,
    maxlength: 16
  },
  // Date when the item was hallmarked at a BIS assaying centre
  hallmarkDate: {
    type: Date,
    sparse: true
  },
  status: {
    type: String,
    enum: ['available', 'sold'],
    default: 'available',
    index: true
  },
  invoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Voucher',
    sparse: true,
    index: true
  },
  soldAt: {
    type: Date,
    sparse: true,
    index: true
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Compound index for user and status
itemSchema.index({ userId: 1, status: 1 });

// Compound index for user and created date
itemSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Item', itemSchema);
