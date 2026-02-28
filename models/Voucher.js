const mongoose = require('mongoose');

const voucherItemSchema = new mongoose.Schema({
  sourceItemId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Item'
  },
  itemName: {
    type: String,
    required: true
  },
  pieces: {
    type: Number,
    required: true,
    default: 1
  },
  grossWeight: {
    type: Number,
    required: true
  },
  lessWeight: {
    type: Number,
    default: 0
  },
  netWeight: {
    type: Number,
    required: true
  },
  melting: {
    type: Number,
    default: 0
  },
  wastage: {
    type: Number,
    default: 0
  },
  fineWeight: {
    type: Number,
    required: true
  },
  labourRate: {
    type: Number,
    default: 0
  },
  amount: {
    type: Number,
    required: true
  },
  metalType: {
    type: String,
    enum: ['gold', 'silver'],
    required: true
  },
  hsnCode: {
    type: String,
    default: '7108',
    trim: true
  }
});

const voucherSchema = new mongoose.Schema({
  voucherNumber: {
    type: String,
    required: true
  },
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
  invoiceType: {
    type: String,
    enum: ['normal', 'gst'],
    default: 'normal'
  },
  invoiceNumber: {
    type: String,
    trim: true,
    sparse: true,
    index: true
  },
  referenceNo: {
    type: String,
    trim: true,
    sparse: true
  },
  gstDetails: {
    sellerGSTNumber: {
      type: String,
      trim: true,
      sparse: true
    },
    sellerState: {
      type: String,
      trim: true,
      sparse: true
    },
    customerGSTNumber: {
      type: String,
      trim: true,
      sparse: true
    },
    customerState: {
      type: String,
      trim: true,
      sparse: true
    },
    gstType: {
      type: String,
      enum: ['IGST', 'CGST_SGST'],
      sparse: true
    },
    gstRate: {
      type: Number,
      default: 0
    },
    taxableValue: {
      type: Number,
      default: 0
    },
    igst: {
      type: Number,
      default: 0
    },
    cgst: {
      type: Number,
      default: 0
    },
    sgst: {
      type: Number,
      default: 0
    },
    totalGST: {
      type: Number,
      default: 0
    }
  },
  paymentType: {
    type: String,
    enum: ['cash', 'credit', 'add_cash', 'add_gold', 'add_silver', 'money_to_gold', 'money_to_silver'],
    required: true
  },
  goldRate: {
    type: Number,
    default: 0
  },
  silverRate: {
    type: Number,
    default: 0
  },
  items: [voucherItemSchema],
  totals: {
    pieces: { type: Number, default: 0 },
    grossWeight: { type: Number, default: 0 },
    lessWeight: { type: Number, default: 0 },
    netWeight: { type: Number, default: 0 },
    melting: { type: Number, default: 0 },
    wastage: { type: Number, default: 0 },
    fineWeight: { type: Number, default: 0 },
    labourRate: { type: Number, default: 0 },
    amount: { type: Number, default: 0 }
  },
  stoneAmount: {
    type: Number,
    default: 0
  },
  fineAmount: {
    type: Number,
    default: 0
  },
  issue: {
    gross: { type: Number, default: 0 }
  },
  receipt: {
    gross: { type: Number, default: 0 }
  },
  oldBalance: {
    amount: { type: Number, default: 0 },
    fineWeight: { type: Number, default: 0 }
  },
  currentBalance: {
    amount: { type: Number, default: 0 },
    netWeight: { type: Number, default: 0 }
  },
  balanceSnapshot: {
    // Old balance at time of saving
    oldBalance: {
      creditAmount: { type: Number, default: 0 },
      cashAmount: { type: Number, default: 0 },
      totalAmount: { type: Number, default: 0 },
      goldFineWeight: { type: Number, default: 0 },
      silverFineWeight: { type: Number, default: 0 }
    },
    // Current balance at time of saving
    currentBalance: {
      amount: { type: Number, default: 0 },
      goldFineWeight: { type: Number, default: 0 },
      silverFineWeight: { type: Number, default: 0 }
    }
  },
  total: {
    type: Number,
    required: true
  },
  cashReceived: {
    type: Number,
    default: 0
  },
  narration: {
    type: String,
    default: ''
  },
  eWayBill: {
    type: String,
    trim: true,
    sparse: true
  },
  eWayBillNo: {
    type: String,
    trim: true,
    sparse: true
  },
  transportDetails: {
    type: String,
    trim: true,
    sparse: true
  },
  transport: {
    type: String,
    trim: true,
    sparse: true
  },
  transportId: {
    type: String,
    trim: true,
    sparse: true
  },
  deliveryLocation: {
    type: String,
    trim: true,
    sparse: true
  },
  bankName: {
    type: String,
    trim: true,
    sparse: true
  },
  accountNumber: {
    type: String,
    trim: true,
    sparse: true
  },
  ifscCode: {
    type: String,
    trim: true,
    sparse: true
  },
  upiId: {
    type: String,
    trim: true,
    sparse: true
  },
  creditDueDate: {
    type: Date
  },
  status: {
    type: String,
    enum: ['active', 'cancelled'],
    default: 'active'
  },
  // 'sale' = shop sells to customer, 'purchase' = shop buys from customer (old gold exchange)
  voucherType: {
    type: String,
    enum: ['sale', 'purchase'],
    default: 'sale',
    index: true
  },
  cancelledReason: {
    type: String,
    sparse: true
  },
  previousLedgerState: {
    goldFineWeight: { type: Number, default: 0 },
    silverFineWeight: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    cashBalance: { type: Number, default: 0 },
    creditBalance: { type: Number, default: 0 }
  },
  stockAdjusted: {
    type: Boolean,
    default: false
  },
  stockAdjustment: {
    gold: { type: Number, default: 0 },
    silver: { type: Number, default: 0 }
  },
  stockRestored: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

voucherSchema.pre('validate', function normalizeVoucherFields(next) {
  if (this.invoiceNumber) {
    this.invoiceNumber = this.invoiceNumber.trim();
  }
  if (this.items?.length) {
    this.items.forEach((item) => {
      if (item.hsnCode) {
        item.hsnCode = String(item.hsnCode).trim();
      }
    });
  }
  next();
});

// Index for efficient queries
voucherSchema.index({ userId: 1, voucherNumber: 1 });
voucherSchema.index({ userId: 1, ledgerId: 1 });
voucherSchema.index({ userId: 1, date: -1 });
voucherSchema.index({ userId: 1, creditDueDate: 1 });
voucherSchema.index({ userId: 1, invoiceNumber: 1 });

module.exports = mongoose.model('Voucher', voucherSchema);
