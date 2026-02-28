const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    date: {
        type: Date,
        required: true,
        default: Date.now,
        index: true
    },
    category: {
        type: String,
        enum: ['petrol', 'electricity', 'water', 'furniture', 'rent', 'license', 'miscellaneous'],
        required: true
    },
    amount: {
        type: Number,
        required: true,
        min: 0
    },
    description: {
        type: String,
        trim: true,
        default: ''
    },
    paymentMethod: {
        type: String,
        enum: ['cash', 'online'],
        default: 'cash'
    }
}, {
    timestamps: true
});

// Indexes for efficient queries
expenseSchema.index({ userId: 1, date: -1 });
expenseSchema.index({ userId: 1, category: 1 });

module.exports = mongoose.model('Expense', expenseSchema);
