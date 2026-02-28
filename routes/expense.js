const express = require('express');
const router = express.Router();
const Expense = require('../models/Expense');
const { Stock } = require('../models/Stock');
const { auth, checkLicense } = require('../middleware/auth');

router.use(auth);
router.use(checkLicense);

// Create new expense
router.post('/', async (req, res) => {
    try {
        const { date, category, amount, description, paymentMethod } = req.body;

        if (!category || !amount) {
            return res.status(400).json({
                success: false,
                message: 'Category and amount are required'
            });
        }

        if (amount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Amount must be greater than 0'
            });
        }

        const expense = new Expense({
            userId: req.userId,
            date: date || new Date(),
            category,
            amount: parseFloat(amount),
            description: description || '',
            paymentMethod: paymentMethod || 'cash'
        });

        await expense.save();

        // If payment method is cash, deduct from Stock.cashInHand (atomic to prevent race conditions)
        if (paymentMethod === 'cash') {
            await Stock.findOneAndUpdate(
                { userId: req.userId },
                { $inc: { cashInHand: -parseFloat(amount) }, $set: { updatedAt: new Date() } },
                { upsert: true, new: true }
            );
        }

        return res.status(201).json({
            success: true,
            message: 'Expense created successfully',
            expense
        });
    } catch (error) {
        console.error('Create expense error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error creating expense'
        });
    }
});

// Get all expenses for user with optional filters
router.get('/', async (req, res) => {
    try {
        const { startDate, endDate, category, paymentMethod } = req.query;

        const query = { userId: req.userId };

        // Date filter
        if (startDate || endDate) {
            query.date = {};
            if (startDate) query.date.$gte = new Date(startDate);
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                query.date.$lte = end;
            }
        }

        // Category filter
        if (category) {
            query.category = category;
        }

        // Payment method filter
        if (paymentMethod) {
            query.paymentMethod = paymentMethod;
        }

        const expenses = await Expense.find(query).sort({ date: -1 });

        return res.json({
            success: true,
            expenses
        });
    } catch (error) {
        console.error('Get expenses error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error fetching expenses'
        });
    }
});

// Get single expense
router.get('/:id', async (req, res) => {
    try {
        const expense = await Expense.findOne({
            _id: req.params.id,
            userId: req.userId
        });

        if (!expense) {
            return res.status(404).json({
                success: false,
                message: 'Expense not found'
            });
        }

        return res.json({
            success: true,
            expense
        });
    } catch (error) {
        console.error('Get expense error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error fetching expense'
        });
    }
});

// Edit expense
router.put('/:id', async (req, res) => {
    try {
        const expense = await Expense.findOne({
            _id: req.params.id,
            userId: req.userId
        });

        if (!expense) {
            return res.status(404).json({
                success: false,
                message: 'Expense not found'
            });
        }

        const { date, category, amount, description, paymentMethod } = req.body;

        if (amount !== undefined && amount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Amount must be greater than 0'
            });
        }

        const newAmount = amount !== undefined ? parseFloat(amount) : expense.amount;
        const newPaymentMethod = paymentMethod || expense.paymentMethod;

        // Calculate net cash delta atomically (undo old + apply new in a single operation)
        const oldCashImpact = expense.paymentMethod === 'cash' ? expense.amount : 0;
        const newCashImpact = newPaymentMethod === 'cash' ? newAmount : 0;
        const netDelta = oldCashImpact - newCashImpact; // positive = add back, negative = deduct more

        if (netDelta !== 0) {
            await Stock.findOneAndUpdate(
                { userId: req.userId },
                { $inc: { cashInHand: netDelta }, $set: { updatedAt: new Date() } },
                { upsert: true, new: true }
            );
        }

        expense.date = date || expense.date;
        expense.category = category || expense.category;
        expense.amount = newAmount;
        expense.description = description !== undefined ? description : expense.description;
        expense.paymentMethod = newPaymentMethod;

        await expense.save();

        return res.json({
            success: true,
            message: 'Expense updated successfully',
            expense
        });
    } catch (error) {
        console.error('Edit expense error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error updating expense'
        });
    }
});

// Delete expense
router.delete('/:id', async (req, res) => {
    try {
        const expense = await Expense.findOne({
            _id: req.params.id,
            userId: req.userId
        });

        if (!expense) {
            return res.status(404).json({
                success: false,
                message: 'Expense not found'
            });
        }

        // If payment method was cash, add back to Stock.cashInHand (atomic)
        if (expense.paymentMethod === 'cash') {
            await Stock.findOneAndUpdate(
                { userId: req.userId },
                { $inc: { cashInHand: parseFloat(expense.amount) }, $set: { updatedAt: new Date() } },
                { upsert: true, new: true }
            );
        }

        await Expense.findByIdAndDelete(req.params.id);

        return res.json({
            success: true,
            message: 'Expense deleted successfully'
        });
    } catch (error) {
        console.error('Delete expense error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error deleting expense'
        });
    }
});

module.exports = router;
