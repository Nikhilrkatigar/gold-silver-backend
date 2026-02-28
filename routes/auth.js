const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { auth } = require('../middleware/auth');
const CONSTANTS = require('../utils/constants');

const sanitizePhone = (phone) => String(phone || '').replace(/\D/g, '');

const generateToken = (userId) => (
  jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: CONSTANTS.JWT.EXPIRY })
);

const validateLogin = [
  body('phoneNumber')
    .customSanitizer(sanitizePhone)
    .matches(CONSTANTS.VALIDATION.PHONE_REGEX)
    .withMessage(CONSTANTS.ERROR_MESSAGES.INVALID_PHONE),
  body('password')
    .notEmpty()
    .withMessage('Password is required')
];

const validateCreateAdmin = [
  body('shopName').trim().isLength({ min: 2 }).withMessage('Shop name is required'),
  body('phoneNumber')
    .customSanitizer(sanitizePhone)
    .matches(CONSTANTS.VALIDATION.PHONE_REGEX)
    .withMessage(CONSTANTS.ERROR_MESSAGES.INVALID_PHONE),
  body('password')
    .isLength({ min: CONSTANTS.VALIDATION.PASSWORD_MIN_LENGTH })
    .withMessage(`Password must be at least ${CONSTANTS.VALIDATION.PASSWORD_MIN_LENGTH} characters`)
];

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();

  return res.status(CONSTANTS.HTTP_STATUS.BAD_REQUEST).json({
    success: false,
    message: 'Validation failed',
    errors: errors.array().map((err) => ({ field: err.path, message: err.msg }))
  });
};

const mapUser = (user) => ({
  id: user._id,
  shopName: user.shopName,
  phoneNumber: user.phoneNumber,
  role: user.role,
  licenseExpiryDate: user.licenseExpiryDate,
  theme: user.theme,
  voucherSettings: user.voucherSettings,
  gstEnabled: user.gstEnabled,
  gstSettings: user.gstSettings,
  labourChargeSettings: user.labourChargeSettings,
  stockMode: user.stockMode,
  daysUntilExpiry: user.getDaysUntilExpiry?.(),
  isLicenseExpired: user.isLicenseExpired?.()
});

router.post('/login', validateLogin, handleValidationErrors, async (req, res) => {
  try {
    const phoneNumber = sanitizePhone(req.body.phoneNumber);
    const { password } = req.body;

    const user = await User.findOne({ phoneNumber });
    if (!user) {
      return res.status(CONSTANTS.HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        message: CONSTANTS.ERROR_MESSAGES.INVALID_CREDENTIALS
      });
    }

    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(CONSTANTS.HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        message: CONSTANTS.ERROR_MESSAGES.INVALID_CREDENTIALS
      });
    }

    if (!user.isActive) {
      return res.status(CONSTANTS.HTTP_STATUS.FORBIDDEN).json({
        success: false,
        message: 'Account is deactivated. Please contact admin.'
      });
    }

    return res.json({
      success: true,
      token: generateToken(user._id),
      user: mapUser(user)
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(CONSTANTS.HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      message: CONSTANTS.ERROR_MESSAGES.SERVER_ERROR
    });
  }
});

router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) {
      return res.status(CONSTANTS.HTTP_STATUS.NOT_FOUND).json({
        success: false,
        message: 'User not found'
      });
    }

    return res.json({
      success: true,
      user: mapUser(user)
    });
  } catch (error) {
    console.error('Get user error:', error);
    return res.status(CONSTANTS.HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      message: CONSTANTS.ERROR_MESSAGES.SERVER_ERROR
    });
  }
});

router.patch('/settings', auth, async (req, res) => {
  try {
    const { theme, voucherSettings, gstSettings, labourChargeSettings } = req.body;
    const user = await User.findById(req.userId);

    if (!user) {
      return res.status(CONSTANTS.HTTP_STATUS.NOT_FOUND).json({
        success: false,
        message: 'User not found'
      });
    }

    if (theme !== undefined) {
      if (!['light', 'dark', 'system'].includes(theme)) {
        return res.status(CONSTANTS.HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          message: 'Invalid theme selected'
        });
      }
      user.theme = theme;
    }

    if (voucherSettings) {
      user.voucherSettings = {
        ...(user.voucherSettings?.toObject?.() || user.voucherSettings || {}),
        ...voucherSettings
      };
    }

    if (gstSettings) {
      if (!user.gstEnabled) {
        return res.status(CONSTANTS.HTTP_STATUS.FORBIDDEN).json({
          success: false,
          message: 'GST is disabled for this account'
        });
      }

      if (user.role !== 'admin' && user.gstSettings?.gstEditPermission === 'admin') {
        return res.status(CONSTANTS.HTTP_STATUS.FORBIDDEN).json({
          success: false,
          message: 'Only admin can edit GST settings for this account'
        });
      }

      user.gstSettings = {
        ...(user.gstSettings?.toObject?.() || user.gstSettings || {}),
        ...gstSettings,
        gstNumber: gstSettings.gstNumber ? gstSettings.gstNumber.toUpperCase() : user.gstSettings?.gstNumber
      };
    }

    if (labourChargeSettings) {
      if (!['full', 'per-gram'].includes(labourChargeSettings.type)) {
        return res.status(CONSTANTS.HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          message: 'Invalid labour charge type. Must be "full" or "per-gram"'
        });
      }
      user.labourChargeSettings = {
        ...(user.labourChargeSettings?.toObject?.() || user.labourChargeSettings || {}),
        ...labourChargeSettings
      };
    }

    await user.save();

    return res.json({
      success: true,
      user: mapUser(user)
    });
  } catch (error) {
    console.error('Update settings error:', error);
    return res.status(CONSTANTS.HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      message: 'Server error updating settings'
    });
  }
});

router.post('/create-admin', validateCreateAdmin, handleValidationErrors, async (req, res) => {
  try {
    const { shopName, password } = req.body;
    const phoneNumber = sanitizePhone(req.body.phoneNumber);

    const adminExists = await User.findOne({ role: 'admin' });
    if (adminExists) {
      return res.status(CONSTANTS.HTTP_STATUS.FORBIDDEN).json({
        success: false,
        message: 'Admin already exists'
      });
    }

    const admin = new User({
      shopName: shopName.trim(),
      phoneNumber,
      password,
      role: 'admin',
      licenseExpiryDate: new Date('2099-12-31'),
      licenseDays: 999999
    });

    await admin.save();

    return res.status(CONSTANTS.HTTP_STATUS.CREATED).json({
      success: true,
      message: 'Admin created successfully',
      token: generateToken(admin._id),
      user: {
        id: admin._id,
        shopName: admin.shopName,
        phoneNumber: admin.phoneNumber,
        role: admin.role
      }
    });
  } catch (error) {
    console.error('Create admin error:', error);
    return res.status(CONSTANTS.HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      message: 'Server error creating admin'
    });
  }
});

module.exports = router;
