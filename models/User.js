const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  shopName: {
    type: String,
    required: true,
    trim: true
  },
  phoneNumber: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    match: [/^[0-9]{10}$/, 'Phone number must be 10 digits']
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  role: {
    type: String,
    enum: ['admin', 'user'],
    default: 'user'
  },
  licenseExpiryDate: {
    type: Date,
    required: true
  },
  licenseDays: {
    type: Number,
    default: 30
  },
  voucherSettings: {
    autoIncrement: {
      type: Boolean,
      default: true
    },
    currentVoucherNumber: {
      type: Number,
      default: 1
    }
  },
  gstEnabled: {
    type: Boolean,
    default: false
  },
  gstSettings: {
    gstNumber: {
      type: String,
      trim: true,
      sparse: true,
      validate: {
        validator: function (v) {
          if (!v) return !this.gstEnabled; // Optional if GST disabled
          // GST Format: 2 digits (state) + 5 letters (PAN) + 4 digits (entity) + 4 alphanumeric (check/filler)
          return /^\d{2}[A-Z]{5}\d{4}[A-Z0-9]{4}$/.test(v);
        },
        message: 'Invalid GST number format (format: 29AABCR1718E1ZL)'
      }
    },
    businessState: {
      type: String,
      enum: [
        '01', '02', '03', '04', '05', '06', '07', '08', '09', '10',
        '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
        '21', '22', '23', '24', '25', '26', '27', '28', '29', '30',
        '31', '32', '33', '34', '35', '36', '37', '38', '97', '99'
      ],
      sparse: true
    },
    defaultGSTRate: {
      type: Number,
      enum: [0, 3, 5, 12, 18],
      default: 3  // Gold jewellery: 3% GST (not 18%). Making charges: 5% GST.
    },
    gstEditPermission: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user'
    }
  },
  labourChargeSettings: {
    type: {
      type: String,
      enum: ['full', 'per-gram'],
      default: 'full'
    }
  },
  stockMode: {
    type: String,
    enum: ['bulk', 'item'],
    default: 'bulk',
    index: true
  },
  theme: {
    type: String,
    enum: ['light', 'dark', 'system'],
    default: 'system'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

userSchema.pre('validate', function normalizePhone(next) {
  if (this.phoneNumber) {
    this.phoneNumber = String(this.phoneNumber).replace(/\D/g, '');
  }
  if (this.gstSettings?.gstNumber) {
    this.gstSettings.gstNumber = this.gstSettings.gstNumber.toUpperCase();
  }
  next();
});

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) {
    return next();
  }

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare password
userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Method to check if license is expired
userSchema.methods.isLicenseExpired = function () {
  return new Date() > this.licenseExpiryDate;
};

// Method to get days until expiry
userSchema.methods.getDaysUntilExpiry = function () {
  const now = new Date();
  const expiry = new Date(this.licenseExpiryDate);
  const diffTime = expiry - now;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays;
};

module.exports = mongoose.model('User', userSchema);
