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
    trim: true
  },
  password: {
    type: String,
    required: true
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

// Hash password before saving
userSchema.pre('save', async function(next) {
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
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Method to check if license is expired
userSchema.methods.isLicenseExpired = function() {
  return new Date() > this.licenseExpiryDate;
};

// Method to get days until expiry
userSchema.methods.getDaysUntilExpiry = function() {
  const now = new Date();
  const expiry = new Date(this.licenseExpiryDate);
  const diffTime = expiry - now;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays;
};

module.exports = mongoose.model('User', userSchema);
