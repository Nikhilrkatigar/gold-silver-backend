const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Category = require('../models/Category');
const User = require('../models/User');
const { auth, checkLicense } = require('../middleware/auth');

const createError = (status, message, code) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
};

// Apply middleware to all routes
router.use(auth);
router.use(checkLicense);

// Verify user is in item mode
const checkItemMode = async (req, res, next) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (user.stockMode !== 'item') {
      return res.status(403).json({
        success: false,
        message: 'Item mode is not enabled for this user'
      });
    }
    next();
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error verifying user mode' });
  }
};

// Get all categories for user
router.get('/', checkItemMode, async (req, res) => {
  try {
    const categories = await Category.find({ userId: req.userId, isActive: true })
      .sort({ type: 1, name: 1 });

    res.json({
      success: true,
      categories
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching categories'
    });
  }
});

// Get category by ID
router.get('/:id', checkItemMode, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid category ID'
      });
    }

    const category = await Category.findOne({
      _id: req.params.id,
      userId: req.userId
    });

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    res.json({
      success: true,
      category
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching category'
    });
  }
});

// Create new category
router.post('/', checkItemMode, async (req, res) => {
  try {
    const { name, type } = req.body;

    if (!name || !type) {
      return res.status(400).json({
        success: false,
        message: 'Name and type are required'
      });
    }

    if (!['ornament', 'coin', 'raw_material'].includes(type)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid category type'
      });
    }

    // Check for duplicate (escape regex special chars to prevent injection)
    const escapedName = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const existing = await Category.findOne({
      userId: req.userId,
      name: { $regex: `^${escapedName}$`, $options: 'i' },
      type
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Category already exists'
      });
    }

    const category = new Category({
      userId: req.userId,
      name: name.trim(),
      type,
      isActive: true
    });

    await category.save();

    res.status(201).json({
      success: true,
      message: 'Category created successfully',
      category
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Category already exists'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error creating category'
    });
  }
});

// Update category
router.put('/:id', checkItemMode, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid category ID'
      });
    }

    const { name, type } = req.body;

    if (!name || !type) {
      return res.status(400).json({
        success: false,
        message: 'Name and type are required'
      });
    }

    const category = await Category.findOne({
      _id: req.params.id,
      userId: req.userId
    });

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    category.name = name.trim();
    category.type = type;
    await category.save();

    res.json({
      success: true,
      message: 'Category updated successfully',
      category
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Category with this name and type already exists'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error updating category'
    });
  }
});

// Soft delete category (mark as inactive)
router.delete('/:id', checkItemMode, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid category ID'
      });
    }

    const category = await Category.findOne({
      _id: req.params.id,
      userId: req.userId
    });

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    // Check if category has active items
    const Item = require('../models/Item');
    const itemCount = await Item.countDocuments({
      categoryId: req.params.id,
      status: 'available'
    });

    if (itemCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete category with ${itemCount} active items`
      });
    }

    category.isActive = false;
    await category.save();

    res.json({
      success: true,
      message: 'Category deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting category'
    });
  }
});

// Get category statistics
router.get('/:id/stats', checkItemMode, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid category ID'
      });
    }

    const Item = require('../models/Item');

    const category = await Category.findOne({
      _id: req.params.id,
      userId: req.userId
    });

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    const stats = await Item.aggregate([
      { $match: { categoryId: mongoose.Types.ObjectId(req.params.id) } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalGrossWeight: { $sum: '$grossWeight' },
          totalNetWeight: { $sum: '$netWeight' }
        }
      }
    ]);

    res.json({
      success: true,
      category,
      stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching category statistics'
    });
  }
});

module.exports = router;
