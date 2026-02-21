const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const Voucher = require('../models/Voucher');
const Settlement = require('../models/Settlement');
const Karigar = require('../models/Karigar');
const { Stock, StockInput } = require('../models/Stock');
const { auth, isAdmin } = require('../middleware/auth');

const sanitizePhone = (phone) => String(phone || '').replace(/\D/g, '');

const mapUser = (user) => ({
  id: user._id,
  shopName: user.shopName,
  phoneNumber: user.phoneNumber,
  licenseExpiryDate: user.licenseExpiryDate,
  licenseDays: user.licenseDays,
  daysUntilExpiry: user.getDaysUntilExpiry(),
  isExpired: user.isLicenseExpired(),
  isActive: user.isActive,
  gstEnabled: user.gstEnabled,
  gstSettings: user.gstSettings,
  stockMode: user.stockMode,
  createdAt: user.createdAt
});

router.use(auth);
router.use(isAdmin);

router.post('/users', async (req, res) => {
  try {
    const {
      shopName,
      password,
      gstEnabled = false,
      gstSettings = {},
      stockMode = 'bulk'
    } = req.body;
    const phoneNumber = sanitizePhone(req.body.phoneNumber);
    const licenseDays = Number(req.body.licenseDays);

    if (!shopName || !phoneNumber || !password || !Number.isFinite(licenseDays) || licenseDays <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid shopName, phoneNumber, password and licenseDays are required'
      });
    }

    if (!/^[0-9]{10}$/.test(phoneNumber)) {
      return res.status(400).json({
        success: false,
        message: 'Phone number must be 10 digits'
      });
    }

    const existingUser = await User.findOne({ phoneNumber });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User with this phone number already exists'
      });
    }

    const licenseExpiryDate = new Date();
    licenseExpiryDate.setDate(licenseExpiryDate.getDate() + Math.floor(licenseDays));

    const user = new User({
      shopName: shopName.trim(),
      phoneNumber,
      password,
      licenseDays: Math.floor(licenseDays),
      licenseExpiryDate,
      role: 'user',
      createdBy: req.userId,
      stockMode: ['bulk', 'item'].includes(stockMode) ? stockMode : 'bulk',
      gstEnabled: !!gstEnabled,
      gstSettings: {
        defaultGSTRate: gstSettings.defaultGSTRate ?? 18,
        gstEditPermission: gstSettings.gstEditPermission || 'user',
        gstNumber: gstSettings.gstNumber || undefined,
        businessState: gstSettings.businessState || undefined
      }
    });

    await user.save();

    return res.status(201).json({
      success: true,
      message: 'User created successfully',
      user: mapUser(user)
    });
  } catch (error) {
    console.error('Create user error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error creating user'
    });
  }
});

router.get('/users', async (req, res) => {
  try {
    const users = await User.find({ role: 'user' }).select('-password').sort({ createdAt: -1 });

    // Calculate storage usage for each user (in bytes)
    const usersWithStorage = await Promise.all(
      users.map(async (user) => {
        // Calculate collection size by fetching documents and measuring their size
        const calculateCollectionSize = async (Model) => {
          try {
            const documents = await Model.find({ userId: user._id }).lean();

            if (documents.length === 0) {
              return { totalSize: 0, count: 0 };
            }

            // Calculate size by converting to JSON and measuring byte length
            const totalSize = documents.reduce((sum, doc) => {
              // Convert to JSON string and get byte length
              const jsonString = JSON.stringify(doc);
              const byteLength = Buffer.byteLength(jsonString, 'utf8');
              // Add ~20% overhead for BSON vs JSON (indexes, metadata, etc.)
              return sum + Math.ceil(byteLength * 1.2);
            }, 0);

            return { totalSize, count: documents.length };
          } catch (error) {
            console.error(`Error calculating size for ${Model.modelName}:`, error);
            return { totalSize: 0, count: 0 };
          }
        };

        const [ledgerData, voucherData, settlementData, karigarData, stockData, stockInputData] = await Promise.all([
          calculateCollectionSize(Ledger),
          calculateCollectionSize(Voucher),
          calculateCollectionSize(Settlement),
          calculateCollectionSize(Karigar),
          calculateCollectionSize(Stock),
          calculateCollectionSize(StockInput)
        ]);

        const totalBytes =
          ledgerData.totalSize +
          voucherData.totalSize +
          settlementData.totalSize +
          karigarData.totalSize +
          stockData.totalSize +
          stockInputData.totalSize;

        return {
          ...mapUser(user),
          storageUsage: {
            totalBytes: totalBytes,
            totalKB: (totalBytes / 1024).toFixed(2),
            totalMB: (totalBytes / (1024 * 1024)).toFixed(2),
            totalGB: (totalBytes / (1024 * 1024 * 1024)).toFixed(4),
            breakdown: {
              ledgers: { bytes: ledgerData.totalSize, count: ledgerData.count },
              vouchers: { bytes: voucherData.totalSize, count: voucherData.count },
              settlements: { bytes: settlementData.totalSize, count: settlementData.count },
              karigars: { bytes: karigarData.totalSize, count: karigarData.count },
              stock: { bytes: stockData.totalSize, count: stockData.count },
              stockInputs: { bytes: stockInputData.totalSize, count: stockInputData.count }
            }
          }
        };
      })
    );

    return res.json({
      success: true,
      users: usersWithStorage
    });
  } catch (error) {
    console.error('Get users error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching users'
    });
  }
});

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
    })
      .select('-password')
      .sort({ licenseExpiryDate: 1 });

    return res.json({
      success: true,
      users: users.map((user) => ({
        id: user._id,
        shopName: user.shopName,
        phoneNumber: user.phoneNumber,
        licenseExpiryDate: user.licenseExpiryDate,
        daysUntilExpiry: user.getDaysUntilExpiry()
      }))
    });
  } catch (error) {
    console.error('Get expiring users error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching expiring users'
    });
  }
});

router.patch('/users/:id', async (req, res) => {
  try {
    const { shopName, password, gstEnabled, gstSettings } = req.body;
    const phoneNumber = req.body.phoneNumber ? sanitizePhone(req.body.phoneNumber) : undefined;
    const extraLicenseDays = req.body.licenseDays !== undefined ? Number(req.body.licenseDays) : undefined;

    const user = await User.findOne({ _id: req.params.id, role: 'user' });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (shopName !== undefined) user.shopName = shopName.trim();

    if (phoneNumber !== undefined) {
      if (!/^[0-9]{10}$/.test(phoneNumber)) {
        return res.status(400).json({
          success: false,
          message: 'Phone number must be 10 digits'
        });
      }

      const existingPhone = await User.findOne({
        _id: { $ne: user._id },
        phoneNumber
      });
      if (existingPhone) {
        return res.status(400).json({
          success: false,
          message: 'Another user already uses this phone number'
        });
      }

      user.phoneNumber = phoneNumber;
    }

    if (password) {
      user.password = password;
    }

    if (gstEnabled !== undefined) {
      user.gstEnabled = !!gstEnabled;
    }

    if (gstSettings) {
      user.gstSettings = {
        ...(user.gstSettings?.toObject?.() || user.gstSettings || {}),
        ...gstSettings
      };
    }

    if (extraLicenseDays !== undefined) {
      if (!Number.isFinite(extraLicenseDays) || extraLicenseDays <= 0) {
        return res.status(400).json({
          success: false,
          message: 'licenseDays must be a positive number'
        });
      }

      const now = new Date();
      const baseDate = user.licenseExpiryDate > now ? new Date(user.licenseExpiryDate) : now;
      baseDate.setDate(baseDate.getDate() + Math.floor(extraLicenseDays));
      user.licenseExpiryDate = baseDate;
      user.licenseDays += Math.floor(extraLicenseDays);
    }

    await user.save();

    return res.json({
      success: true,
      message: 'User updated successfully',
      user: mapUser(user)
    });
  } catch (error) {
    console.error('Update user error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error updating user'
    });
  }
});

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

    await Promise.all([
      Ledger.deleteMany({ userId: req.params.id }),
      Voucher.deleteMany({ userId: req.params.id }),
      Settlement.deleteMany({ userId: req.params.id }),
      Karigar.deleteMany({ userId: req.params.id }),
      Stock.deleteMany({ userId: req.params.id }),
      StockInput.deleteMany({ userId: req.params.id }),
      User.findByIdAndDelete(req.params.id)
    ]);

    return res.json({
      success: true,
      message: 'User and all associated data deleted successfully'
    });
  } catch (error) {
    console.error('Delete user error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error deleting user'
    });
  }
});

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

    return res.json({
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
    return res.status(500).json({
      success: false,
      message: 'Server error fetching statistics'
    });
  }
});

module.exports = router;
