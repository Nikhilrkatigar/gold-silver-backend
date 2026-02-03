const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const Voucher = require('../models/Voucher');
const { auth, isAdmin } = require('../middleware/auth');

// All admin routes require authentication and admin role
router.use(auth);
router.use(isAdmin);

// Add new user
router.post('/users', async (req, res) => {
  try {
    const { shopName, phoneNumber, password, licenseDays } = req.body;

    if (!shopName || !phoneNumber || !password || !licenseDays) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required'
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ phoneNumber });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User with this phone number already exists'
      });
    }

    // Calculate license expiry date
    const licenseExpiryDate = new Date();
    licenseExpiryDate.setDate(licenseExpiryDate.getDate() + parseInt(licenseDays));

    const user = new User({
      shopName,
      phoneNumber,
      password,
      licenseDays: parseInt(licenseDays),
      licenseExpiryDate,
      role: 'user',
      createdBy: req.userId
    });

    await user.save();

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      user: {
        id: user._id,
        shopName: user.shopName,
        phoneNumber: user.phoneNumber,
        licenseExpiryDate: user.licenseExpiryDate,
        licenseDays: user.licenseDays,
        daysUntilExpiry: user.getDaysUntilExpiry()
      }
    });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error creating user'
    });
  }
});

// Get all users
router.get('/users', async (req, res) => {
  try {
    const users = await User.find({ role: 'user' })
      .select('-password')
      .sort({ createdAt: -1 });

    const usersWithExpiry = users.map(user => ({
      id: user._id,
      shopName: user.shopName,
      phoneNumber: user.phoneNumber,
      licenseExpiryDate: user.licenseExpiryDate,
      licenseDays: user.licenseDays,
      daysUntilExpiry: user.getDaysUntilExpiry(),
      isExpired: user.isLicenseExpired(),
      isActive: user.isActive,
      createdAt: user.createdAt
    }));

    res.json({
      success: true,
      users: usersWithExpiry
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching users'
    });
  }
});

// Get soon expiring users (within 7 days)
router.get('/users/expiring', async (req, res) => {
  try {
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

    const users = await User.find({
      role: 'user',
      licenseExpiryDate: {
        $gte: new Date(),
        $lte: sevenDaysFromNow
      }
    }).select('-password').sort({ licenseExpiryDate: 1 });

    const usersWithExpiry = users.map(user => ({
      id: user._id,
      shopName: user.shopName,
      phoneNumber: user.phoneNumber,
      licenseExpiryDate: user.licenseExpiryDate,
      daysUntilExpiry: user.getDaysUntilExpiry()
    }));

    res.json({
      success: true,
      users: usersWithExpiry
    });
  } catch (error) {
    console.error('Get expiring users error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching expiring users'
    });
  }
});

// Update user
router.patch('/users/:id', async (req, res) => {
  try {
    const { shopName, phoneNumber, password, licenseDays } = req.body;
    const updates = {};

    if (shopName) updates.shopName = shopName;
    if (phoneNumber) updates.phoneNumber = phoneNumber;
    if (password) updates.password = password;
    
    if (licenseDays) {
      const user = await User.findById(req.params.id);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      // Extend license from current expiry date
      const newExpiryDate = new Date(user.licenseExpiryDate);
      newExpiryDate.setDate(newExpiryDate.getDate() + parseInt(licenseDays));
      updates.licenseExpiryDate = newExpiryDate;
      updates.licenseDays = user.licenseDays + parseInt(licenseDays);
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      message: 'User updated successfully',
      user: {
        id: user._id,
        shopName: user.shopName,
        phoneNumber: user.phoneNumber,
        licenseExpiryDate: user.licenseExpiryDate,
        licenseDays: user.licenseDays,
        daysUntilExpiry: user.getDaysUntilExpiry()
      }
    });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error updating user'
    });
  }
});

// Delete user
router.delete('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (user.role === 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Cannot delete admin user'
      });
    }

    // Delete all associated data
    await Ledger.deleteMany({ userId: req.params.id });
    await Voucher.deleteMany({ userId: req.params.id });
    await User.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'User and all associated data deleted successfully'
    });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error deleting user'
    });
  }
});

// Get admin statistics
router.get('/stats', async (req, res) => {
  try {
    const totalUsers = await User.countDocuments({ role: 'user' });
    const activeUsers = await User.countDocuments({ 
      role: 'user',
      licenseExpiryDate: { $gte: new Date() }
    });
    const expiredUsers = totalUsers - activeUsers;
    
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
    
    const expiringUsers = await User.countDocuments({
      role: 'user',
      licenseExpiryDate: {
        $gte: new Date(),
        $lte: sevenDaysFromNow
      }
    });

    res.json({
      success: true,
      stats: {
        totalUsers,
        activeUsers,
        expiredUsers,
        expiringUsers
      }
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching statistics'
    });
  }
});

module.exports = router;
