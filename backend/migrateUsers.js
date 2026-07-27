import mongoose from 'mongoose';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import User from './models/User.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const migrateUsers = async () => {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    // Read existing users from JSON
    console.log('Reading users from JSON file...');
    const raw = await fs.readFile(USERS_FILE, 'utf8');
    const jsonUsers = JSON.parse(raw);
    console.log(`Found ${jsonUsers.length} users in JSON file`);

    // Migrate each user
    let migrated = 0;
    let skipped = 0;

    for (const jsonUser of jsonUsers) {
      // Check if user already exists in MongoDB
      const existing = await User.findOne({ email: jsonUser.email });
      
      if (existing) {
        console.log(`⏭️  Skipping existing user: ${jsonUser.email}`);
        skipped++;
        continue;
      }

      // Create new user in MongoDB
      const user = new User({
        email: jsonUser.email,
        username: jsonUser.username,
        password: jsonUser.password, // Already hashed
        role: jsonUser.role || 'user',
        accountStatus: jsonUser.accountStatus || 'active',
        isEmailVerified: jsonUser.isEmailVerified || false,
        refreshTokens: jsonUser.refreshTokens || [],
        lastLogin: jsonUser.lastLogin ? new Date(jsonUser.lastLogin) : null,
        createdAt: jsonUser.createdAt ? new Date(jsonUser.createdAt) : new Date(),
        updatedAt: jsonUser.updatedAt ? new Date(jsonUser.updatedAt) : new Date()
      });

      await user.save();
      console.log(`✅ Migrated: ${jsonUser.email} (${jsonUser.username})`);
      migrated++;
    }

    console.log('\n=== Migration Summary ===');
    console.log(`Total users in JSON: ${jsonUsers.length}`);
    console.log(`Migrated to MongoDB: ${migrated}`);
    console.log(`Skipped (already exists): ${skipped}`);
    console.log('\n✅ Migration complete!');

    // Backup JSON file
    const backupFile = path.join(DATA_DIR, `users.backup.${Date.now()}.json`);
    await fs.copyFile(USERS_FILE, backupFile);
    console.log(`📦 JSON file backed up to: ${backupFile}`);

  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
};

migrateUsers();
