import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let replSet: MongoMemoryReplSet | null = null;

export async function setupTestReplSet(): Promise<string> {
  if (!replSet) {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
  }

  const uri = replSet.getUri();
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri);
  }

  return uri;
}

export async function teardownTestReplSet(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  if (replSet) {
    await replSet.stop();
    replSet = null;
  }
}

export async function clearTestDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== 0 && mongoose.connection.db) {
    const collections = await mongoose.connection.db.collections();
    for (const collection of collections) {
      await collection.deleteMany({});
    }
  }
}
