if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const xssClean = require('xss-clean');
const fs = require('fs');
const path = require('path');

// Ensure upload directories exist
const uploadDirs = [
  path.join(__dirname, 'uploads'),
  path.join(__dirname, 'uploads', 'qrcodes')
];

uploadDirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created directory: ${dir}`);
  }
});

const app = express();
app.set('trust proxy', 1);

app.use(cors({
  origin(origin, callback) {
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:5173',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
      'http://127.0.0.1:5173',
      'http://192.168.29.11:3000',
      'https://gold-silver-frontend.vercel.app',
      'https://gold-silver-frontend-red.vercel.app',
      'https://gold-silver-frontend-green.vercel.app'
    ];

    if (process.env.FRONTEND_URL) {
      allowedOrigins.push(process.env.FRONTEND_URL.trim());
    }

    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.warn(`CORS blocked request from origin: ${origin}`);
    callback(null, true); // Kept permissive by request.
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200
}));

app.options('*', cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' } // Allow serving uploaded files
}));
app.use(mongoSanitize()); // Prevent NoSQL injection ($gt, $ne, etc.)
app.use(xssClean());      // Sanitize HTML in request body/params/query

// Rate limiting — strict on login, moderate on general API
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,                    // 5 login attempts per window
  message: { success: false, message: 'Too many login attempts, please try after 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,                  // 300 requests per window (generous for normal use)
  message: { success: false, message: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/auth/login', loginLimiter);
app.use('/api/', apiLimiter);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/ledger', require('./routes/ledger'));
app.use('/api/voucher', require('./routes/voucher'));
app.use('/api/settlement', require('./routes/settlement'));
app.use('/api/stock', require('./routes/stock'));
app.use('/api/karigar', require('./routes/karigar'));
app.use('/api/expense', require('./routes/expense'));
app.use('/api/category', require('./routes/category'));
app.use('/api/item', require('./routes/item'));

// Serve uploaded files (QR codes, etc.)
app.use('/uploads', express.static('./uploads'));

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

if (!process.env.MONGODB_URI) {
  throw new Error('MONGODB_URI is not defined');
}
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is not defined');
}

const PORT = process.env.PORT || 5000;

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    app.listen(PORT, () => {
      console.log('Server running');
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  mongoose.connection.close().then(() => {
    console.log('MongoDB connection closed');
    process.exit(0);
  });
});

module.exports = app;
