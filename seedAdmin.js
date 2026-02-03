require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');

const seedAdmin = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/gold-silver-saas');
    console.log('✅ Connected to MongoDB');

    // Check if admin already exists
    const adminExists = await User.findOne({ role: 'admin' });
    
    if (adminExists) {
      console.log('⚠️  Admin user already exists');
      console.log('Shop Name:', adminExists.shopName);
      console.log('Phone:', adminExists.phoneNumber);
      await mongoose.disconnect();
      return;
    }

    // Create admin user
    const admin = new User({
      shopName: 'Admin',
      phoneNumber: 'admin',
      password: 'admin123',
      role: 'admin',
      licenseExpiryDate: new Date('2099-12-31'),
      licenseDays: 999999
    });

    await admin.save();

    console.log('✅ Admin user created successfully!');
    console.log('');
    console.log('Login credentials:');
    console.log('Phone: admin');
    console.log('Password: admin123');
    console.log('');
    console.log('⚠️  Please change the password after first login!');

    await mongoose.disconnect();
    console.log('✅ Database connection closed');
  } catch (error) {
    console.error('❌ Error seeding admin:', error);
    process.exit(1);
  }
};

seedAdmin();
