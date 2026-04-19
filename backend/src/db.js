const mongoose = require('mongoose');

module.exports = async function connectDb(uri) {
  if (!uri) {
    console.error('MONGODB_URI is not set.');
    process.exit(1);
  }
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  console.log('MongoDB connected');
};
