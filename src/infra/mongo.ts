import mongoose from 'mongoose';
import { env } from '@config/env.js';
import { logger } from '@common/logger.js';

export async function connectMongo(): Promise<typeof mongoose> {
  try {
    mongoose.connection.on('connected', () => {
      logger.info('MongoDB connected successfully');
    });

    mongoose.connection.on('error', (err) => {
      logger.error({ err }, 'MongoDB connection error');
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected');
    });

    await mongoose.connect(env.MONGO_URI, {
      maxPoolSize: 50,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    return mongoose;
  } catch (error) {
    logger.error({ err: error }, 'Failed to connect to MongoDB');
    throw error;
  }
}

export async function disconnectMongo(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    logger.info('MongoDB disconnected cleanly');
  }
}

export async function checkMongoHealth(): Promise<boolean> {
  try {
    if (mongoose.connection.readyState !== 1) {
      return false;
    }
    const adminDb = mongoose.connection.db?.admin();
    if (!adminDb) return false;
    const res = await adminDb.ping();
    return res.ok === 1;
  } catch {
    return false;
  }
}
