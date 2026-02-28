const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Item = require('../models/Item');
const ItemTransaction = require('../models/ItemTransaction');
const Category = require('../models/Category');
const User = require('../models/User');
const { auth, checkLicense } = require('../middleware/auth');
const { generateItemQRCode, deleteItemQRCode } = require('../utils/qrCodeGenerator');

const CONSTANTS = require('../utils/constants');

const createError = (status, message, code) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
};

const supportsTransactions = () => {
  const topologyType = mongoose.connection?.client?.topology?.description?.type;
  return Boolean(topologyType && topologyType !== 'Single');
};

const startOptionalSession = async () => {
  if (!supportsTransactions()) return null;
  const session = await mongoose.startSession();
  session.startTransaction();
  return session;
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
    req.user = user;
    next();
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error verifying user mode' });
  }
};

/**
 * Log item transaction (audit log)
 */
const logItemTransaction = async (itemId, userId, action, performedBy, options = {}) => {
  try {
    const { session, previousValues, newValues, metadata } = options;
    const transactionData = {
      itemId,
      userId,
      action,
      performedBy,
      previousValues: previousValues || null,
      newValues: newValues || null,
      metadata: metadata || {}
    };

    let query = ItemTransaction.create([transactionData]);
    if (session) {
      query = ItemTransaction.create([transactionData], { session });
    }

    await query;
  } catch (error) {
    console.error('Error logging item transaction:', error.message);
    // Don't throw - audit logging failure shouldn't break main operation
  }
};

// Get all items for user
router.get('/', checkItemMode, async (req, res) => {
  try {
    const { status, categoryId, metal } = req.query;
    let filter = { userId: req.userId };

    if (status && ['available', 'sold'].includes(status)) {
      filter.status = status;
    }
    if (categoryId && mongoose.Types.ObjectId.isValid(categoryId)) {
      filter.categoryId = mongoose.Types.ObjectId(categoryId);
    }
    if (metal && ['gold', 'silver'].includes(metal)) {
      filter.metal = metal;
    }

    const items = await Item.find(filter)
      .populate('categoryId', 'name type')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      items
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching items'
    });
  }
});

// Get item by ID
router.get('/:id', checkItemMode, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid item ID'
      });
    }

    const item = await Item.findOne({
      _id: req.params.id,
      userId: req.userId
    }).populate('categoryId', 'name type');

    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Item not found'
      });
    }

    res.json({
      success: true,
      item
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching item'
    });
  }
});

// Create new item
router.post('/', checkItemMode, async (req, res) => {
  let session = null;
  try {
    const {
      itemCode,
      name,
      metal,
      purity,
      grossWeight,
      lessWeight = 0,
      meltingPercent = 0,
      wastage = 0,
      labour = 0,
      purchaseRate = 0,
      categoryId,
      huid,
      hallmarkDate
    } = req.body;

    // Validation
    if (!name || !metal || !purity || grossWeight === undefined || !categoryId) {
      return res.status(400).json({
        success: false,
        message: 'Required fields: name, metal, purity, grossWeight, categoryId'
      });
    }

    if (!['gold', 'silver'].includes(metal)) {
      return res.status(400).json({
        success: false,
        message: 'Metal must be gold or silver'
      });
    }

    if (!mongoose.Types.ObjectId.isValid(categoryId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid category ID'
      });
    }

    // Verify category exists and belongs to user
    const category = await Category.findOne({
      _id: categoryId,
      userId: req.userId
    });

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    // Start transaction if supported
    session = await startOptionalSession();

    // Generate unique item code if not provided
    let finalItemCode = itemCode;
    if (!finalItemCode) {
      finalItemCode = `${metal.charAt(0).toUpperCase()}${Date.now()}`;
    } else {
      // Check if code is unique
      const existingItem = await Item.findOne({ itemCode: finalItemCode });
      if (existingItem) {
        return res.status(400).json({
          success: false,
          message: 'Item code already exists'
        });
      }
    }

    // Calculate net weight
    const netWeight = parseFloat(grossWeight) - parseFloat(lessWeight);
    if (netWeight <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Net weight must be greater than 0'
      });
    }

    // Calculate cost price: (netWeight × purchaseRate) + labour
    const parsedPurchaseRate = parseFloat(purchaseRate) || 0;
    const parsedLabour = parseFloat(labour) || 0;
    const costPrice = (netWeight * parsedPurchaseRate) + parsedLabour;

    // Create item
    const itemData = {
      userId: req.userId,
      itemCode: finalItemCode,
      name: name.trim(),
      metal,
      purity: purity.trim(),
      grossWeight: parseFloat(grossWeight),
      lessWeight: parseFloat(lessWeight),
      netWeight,
      meltingPercent: parseFloat(meltingPercent),
      wastage: parseFloat(wastage),
      labour: parsedLabour,
      purchaseRate: parsedPurchaseRate,
      costPrice,
      categoryId,
      ...(huid ? { huid: String(huid).toUpperCase().trim() } : {}),
      ...(hallmarkDate ? { hallmarkDate: new Date(hallmarkDate) } : {}),
      status: 'available'
    };

    let item = new Item(itemData);
    if (session) {
      await item.save({ session });
    } else {
      await item.save();
    }

    // Generate QR code
    try {
      const qrCodePath = await generateItemQRCode(item._id.toString(), req.userId);
      item.qrCodePath = qrCodePath;
      if (session) {
        await item.save({ session });
      } else {
        await item.save();
      }
    } catch (qrError) {
      console.error('QR code generation failed:', qrError.message);
      // Continue without QR code - can be regenerated
    }

    // Log transaction
    await logItemTransaction(
      item._id,
      req.userId,
      'created',
      req.userId,
      { session, newValues: item.toObject() }
    );

    if (session) {
      await session.commitTransaction();
    }

    await item.populate('categoryId', 'name type');

    res.status(201).json({
      success: true,
      message: 'Item created successfully',
      item
    });
  } catch (error) {
    if (session) {
      await session.abortTransaction();
    }

    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Item code already exists'
      });
    }

    console.error('Error creating item:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating item'
    });
  } finally {
    if (session) {
      session.endSession();
    }
  }
});

// Update item (only if status = available)
router.put('/:id', checkItemMode, async (req, res) => {
  let session = null;
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid item ID'
      });
    }

    const item = await Item.findOne({
      _id: req.params.id,
      userId: req.userId
    });

    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Item not found'
      });
    }

    // Prevent editing sold items
    if (item.status === 'sold') {
      return res.status(400).json({
        success: false,
        message: 'Cannot modify a sold item'
      });
    }

    session = await startOptionalSession();

    const previousValues = item.toObject();
    const {
      name,
      metal,
      purity,
      grossWeight,
      lessWeight = item.lessWeight,
      meltingPercent = item.meltingPercent,
      wastage = item.wastage,
      labour = item.labour,
      purchaseRate,
      categoryId,
      huid,
      hallmarkDate
    } = req.body;

    // Update fields
    if (name) item.name = name.trim();
    if (metal && ['gold', 'silver'].includes(metal)) item.metal = metal;
    if (purity) item.purity = purity.trim();
    if (grossWeight !== undefined) {
      const newLessWeight = parseFloat(lessWeight);
      const newGrossWeight = parseFloat(grossWeight);
      const newNetWeight = newGrossWeight - newLessWeight;

      if (newNetWeight <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Net weight must be greater than 0'
        });
      }

      item.grossWeight = newGrossWeight;
      item.lessWeight = newLessWeight;
      item.netWeight = newNetWeight;
    }
    if (meltingPercent !== undefined) item.meltingPercent = parseFloat(meltingPercent);
    if (wastage !== undefined) item.wastage = parseFloat(wastage);
    if (labour !== undefined) item.labour = parseFloat(labour);
    if (purchaseRate !== undefined) item.purchaseRate = parseFloat(purchaseRate) || 0;
    if (categoryId && mongoose.Types.ObjectId.isValid(categoryId)) {
      const category = await Category.findOne({ _id: categoryId, userId: req.userId });
      if (category) {
        item.categoryId = categoryId;
      }
    }
    if (huid !== undefined) item.huid = huid ? String(huid).toUpperCase().trim() : '';
    if (hallmarkDate !== undefined) item.hallmarkDate = hallmarkDate ? new Date(hallmarkDate) : null;

    // Always recompute costPrice after any field changes
    item.costPrice = (item.netWeight * (item.purchaseRate || 0)) + (item.labour || 0);

    if (session) {
      await item.save({ session });
    } else {
      await item.save();
    }

    // Log transaction
    await logItemTransaction(
      item._id,
      req.userId,
      'edited',
      req.userId,
      { session, previousValues, newValues: item.toObject() }
    );

    if (session) {
      await session.commitTransaction();
    }

    await item.populate('categoryId', 'name type');

    res.json({
      success: true,
      message: 'Item updated successfully',
      item
    });
  } catch (error) {
    if (session) {
      await session.abortTransaction();
    }

    console.error('Error updating item:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating item'
    });
  } finally {
    if (session) {
      session.endSession();
    }
  }
});

// Delete item (only if status = available)
router.delete('/:id', checkItemMode, async (req, res) => {
  let session = null;
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid item ID'
      });
    }

    const item = await Item.findOne({
      _id: req.params.id,
      userId: req.userId
    });

    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Item not found'
      });
    }

    if (item.status === 'sold') {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete a sold item'
      });
    }

    session = await startOptionalSession();

    // Delete QR code
    if (item.qrCodePath) {
      deleteItemQRCode(item.qrCodePath);
    }

    if (session) {
      await Item.findByIdAndDelete(req.params.id, { session });
    } else {
      await Item.findByIdAndDelete(req.params.id);
    }

    // Log transaction
    await logItemTransaction(
      item._id,
      req.userId,
      'deleted',
      req.userId,
      { session }
    );

    if (session) {
      await session.commitTransaction();
    }

    res.json({
      success: true,
      message: 'Item deleted successfully'
    });
  } catch (error) {
    if (session) {
      await session.abortTransaction();
    }

    console.error('Error deleting item:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting item'
    });
  } finally {
    if (session) {
      session.endSession();
    }
  }
});

// Get item by item code (for QR code scanning)
router.get('/code/:itemCode', checkItemMode, async (req, res) => {
  try {
    const item = await Item.findOne({
      userId: req.userId,
      itemCode: req.params.itemCode.toUpperCase()
    }).populate('categoryId', 'name type');

    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Item not found'
      });
    }

    // Check if item is sold
    if (item.status === 'sold') {
      return res.status(400).json({
        success: false,
        message: 'This item has already been sold',
        item
      });
    }

    res.json({
      success: true,
      item
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching item'
    });
  }
});

// Override item status (audit logged)
router.post('/:id/override', checkItemMode, async (req, res) => {
  let session = null;
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid item ID'
      });
    }

    const { action = 'mark_available', reason = '', invoiceId = null } = req.body || {};
    if (!['mark_available', 'mark_sold'].includes(action)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid override action'
      });
    }

    if (!reason || !String(reason).trim()) {
      return res.status(400).json({
        success: false,
        message: 'Override reason is required'
      });
    }

    if (action === 'mark_sold' && (!invoiceId || !mongoose.Types.ObjectId.isValid(invoiceId))) {
      return res.status(400).json({
        success: false,
        message: 'Valid invoice ID is required when marking item as sold'
      });
    }

    session = await startOptionalSession();

    const query = Item.findOne({
      _id: req.params.id,
      userId: req.userId
    });
    if (session) {
      query.session(session);
    }
    const item = await query;

    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Item not found'
      });
    }

    const previousValues = item.toObject();
    if (action === 'mark_available') {
      item.status = 'available';
      item.invoiceId = null;
      item.soldAt = null;
    } else {
      item.status = 'sold';
      item.invoiceId = invoiceId;
      item.soldAt = new Date();
    }

    if (session) {
      await item.save({ session });
    } else {
      await item.save();
    }

    await logItemTransaction(
      item._id,
      req.userId,
      'override',
      req.userId,
      {
        session,
        previousValues,
        newValues: item.toObject(),
        metadata: {
          reason: String(reason).trim(),
          ipAddress: req.ip,
          userAgent: req.get('user-agent')
        }
      }
    );

    if (session) {
      await session.commitTransaction();
    }

    await item.populate('categoryId', 'name type');

    return res.json({
      success: true,
      message: 'Item override applied successfully',
      item
    });
  } catch (error) {
    if (session) {
      await session.abortTransaction();
    }
    console.error('Error applying item override:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Error applying item override'
    });
  } finally {
    if (session) {
      session.endSession();
    }
  }
});

// Mark items as sold (bulk operation for invoice creation)
router.post('/mark-sold/batch', checkItemMode, async (req, res) => {
  let session = null;
  try {
    const { itemIds, invoiceId } = req.body;

    if (!invoiceId) {
      return res.status(400).json({
        success: false,
        message: 'Invoice ID is required'
      });
    }

    if (!mongoose.Types.ObjectId.isValid(invoiceId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid invoice ID'
      });
    }

    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Item IDs array is required'
      });
    }

    // Validate all IDs
    if (!itemIds.every(id => mongoose.Types.ObjectId.isValid(id))) {
      return res.status(400).json({
        success: false,
        message: 'Invalid item ID in array'
      });
    }

    session = await startOptionalSession();

    const normalizedItemIds = [...new Set(itemIds.map((id) => id.toString()))];
    const results = {
      success: [],
      alreadyLinked: [],
      failed: []
    };

    const query = Item.find({
      _id: { $in: normalizedItemIds },
      userId: req.userId
    });
    if (session) {
      query.session(session);
    }
    const items = await query;

    const itemsById = new Map(items.map((item) => [item._id.toString(), item]));

    for (const itemId of normalizedItemIds) {
      const item = itemsById.get(itemId);
      if (!item) {
        results.failed.push({ itemId, reason: 'Item not found' });
        continue;
      }

      if (item.status === 'sold') {
        if (item.invoiceId && item.invoiceId.toString() === invoiceId.toString()) {
          // Idempotent success for retries/edits of the same invoice.
          results.alreadyLinked.push(itemId);
          continue;
        }
        results.failed.push({ itemId, reason: 'Item already sold' });
      }
    }

    if (results.failed.length > 0) {
      if (session) {
        await session.abortTransaction();
      }
      return res.status(409).json({
        success: false,
        message: 'One or more items are unavailable for sale',
        results
      });
    }

    const now = new Date();
    const itemIdsToSell = normalizedItemIds.filter((id) => !results.alreadyLinked.includes(id));

    if (itemIdsToSell.length > 0) {
      const updateQuery = Item.updateMany(
        {
          _id: { $in: itemIdsToSell },
          userId: req.userId,
          status: 'available'
        },
        {
          $set: {
            status: 'sold',
            invoiceId,
            soldAt: now
          }
        }
      );
      if (session) {
        updateQuery.session(session);
      }

      const updateResult = await updateQuery;
      if (updateResult.modifiedCount !== itemIdsToSell.length) {
        throw createError(409, 'Failed to mark all items as sold due to concurrent updates');
      }

      for (const itemId of itemIdsToSell) {
        await logItemTransaction(
          itemId,
          req.userId,
          'sold',
          req.userId,
          { session, newValues: { status: 'sold', invoiceId } }
        );
      }

      results.success.push(...itemIdsToSell);
    }

    if (session) {
      await session.commitTransaction();
    }

    res.json({
      success: true,
      message: `Marked ${results.success.length} items as sold`,
      results
    });
  } catch (error) {
    if (session) {
      await session.abortTransaction();
    }

    console.error('Error marking items as sold:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Error marking items as sold'
    });
  } finally {
    if (session) {
      session.endSession();
    }
  }
});

module.exports = router;
