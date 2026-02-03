const mongoose = require('mongoose');

const stockInputSchema = new mongoose.Schema({
  gold: { type: Number, default: 0 },
  silver: { type: Number, default: 0 },
  date: { type: Date, default: Date.now },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
});

const StockInput = mongoose.model('StockInput', stockInputSchema);

const stockSchema = new mongoose.Schema({
  gold: { type: Number, default: 0 },
  silver: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now },
});

const Stock = mongoose.model('Stock', stockSchema);

module.exports = { Stock, StockInput };
