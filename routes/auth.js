const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { auth, isAdmin } = require('../middleware/auth');

// Generate JWT token
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: '30d'
  });
};

// Login
router.post('/login', async (req, res) => {
  try {
    const { phoneNumber, password } = req.body;

    if (!phoneNumber || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide phone number and password'
      });
    }

    const user = await User.findOne({ phoneNumber });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: 'Account is deactivated. Please contact admin.'
      });
    }

    const token = generateToken(user._id);

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        shopName: user.shopName,
        phoneNumber: user.phoneNumber,
        role: user.role,
        licenseExpiryDate: user.licenseExpiryDate,
        theme: user.theme,
        voucherSettings: user.voucherSettings,
        daysUntilExpiry: user.getDaysUntilExpiry()
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during login'
    });
  }
});

// Get current user
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    
    res.json({
      success: true,
      user: {
        id: user._id,
        shopName: user.shopName,
        phoneNumber: user.phoneNumber,
        role: user.role,
        licenseExpiryDate: user.licenseExpiryDate,
        theme: user.theme,
        voucherSettings: user.voucherSettings,
        daysUntilExpiry: user.getDaysUntilExpiry(),
        isLicenseExpired: user.isLicenseExpired()
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Update user settings
router.patch('/settings', auth, async (req, res) => {
  try {
    const { theme, voucherSettings } = req.body;
    const updates = {};

    if (theme) updates.theme = theme;
    if (voucherSettings) updates.voucherSettings = voucherSettings;

    const user = await User.findByIdAndUpdate(
      req.userId,
      updates,
      { new: true, runValidators: true }
    ).select('-password');

    res.json({
      success: true,
      user: {
        id: user._id,
        shopName: user.shopName,
        phoneNumber: user.phoneNumber,
        role: user.role,
        theme: user.theme,
        voucherSettings: user.voucherSettings
      }
    });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error updating settings'
    });
  }
});

// Create first admin (only if no admin exists)
router.post('/create-admin', async (req, res) => {
  try {
    const { shopName, phoneNumber, password } = req.body;

    // Check if any admin exists
    const adminExists = await User.findOne({ role: 'admin' });
    
    if (adminExists) {
      return res.status(403).json({
        success: false,
        message: 'Admin already exists'
      });
    }

    const admin = new User({
      shopName,
      phoneNumber,
      password,
      role: 'admin',
      licenseExpiryDate: new Date('2099-12-31'),
      licenseDays: 999999
    });

    await admin.save();

    const token = generateToken(admin._id);

    res.status(201).json({
      success: true,
      message: 'Admin created successfully',
      token,
      user: {
        id: admin._id,
        shopName: admin.shopName,
        phoneNumber: admin.phoneNumber,
        role: admin.role
      }
    });
  } catch (error) {
    console.error('Create admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error creating admin'
    });
  }
});

module.exports = router;
