require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');

const seedAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/gold-silver-saas');
    console.log('Connected to MongoDB');

    const adminExists = await User.findOne({ role: 'admin' });
    if (adminExists) {
      console.log('Admin user already exists');
      console.log('Shop Name:', adminExists.shopName);
      console.log('Phone:', adminExists.phoneNumber);
      await mongoose.disconnect();
      return;
    }

    const adminPhone = process.env.ADMIN_PHONE || '8904286980';
    const adminPassword = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
    const adminShopName = process.env.ADMIN_SHOP_NAME || 'Admin';

    const admin = new User({
      shopName: adminShopName,
      phoneNumber: adminPhone,
      password: adminPassword,
      role: 'admin',
      licenseExpiryDate: new Date('2099-12-31'),
      licenseDays: 999999
    });

    await admin.save();

    console.log('Admin user created successfully');
    console.log('');
    console.log('Login credentials:');
    console.log(`Phone: ${adminPhone}`);
    console.log(`Password: ${adminPassword}`);
    console.log('');
    if (!process.env.ADMIN_PASSWORD) {
      console.log('ADMIN_PASSWORD env not set. Default password was used.');
    }
    console.log('Please change the password after first login.');

    await mongoose.disconnect();
    console.log('Database connection closed');
  } catch (error) {
    console.error('Error seeding admin:', error);
    process.exit(1);
  }
};

seedAdmin();
