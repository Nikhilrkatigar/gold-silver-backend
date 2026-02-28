const mongoose = require('mongoose');

const stockInputSchema = new mongoose.Schema({
  gold: { type: Number, default: 0 },
  silver: { type: Number, default: 0 },
  cashAmount: { type: Number, default: 0 },
  date: { type: Date, default: Date.now },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
});

const StockInput = mongoose.model('StockInput', stockInputSchema);

const stockSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  gold: { type: Number, default: 0 },
  silver: { type: Number, default: 0 },
  cashInHand: { type: Number, default: 0 },
  goldRate: { type: Number, default: 0 },
  silverRate: { type: Number, default: 0 },
  ratesUpdatedAt: { type: Date },
  updatedAt: { type: Date, default: Date.now },
});

const Stock = mongoose.model('Stock', stockSchema);

module.exports = { Stock, StockInput };
