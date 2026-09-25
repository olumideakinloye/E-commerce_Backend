import { connectMongo, disconnectMongo } from '@infra/mongo.js';
import { User } from '@modules/auth/models/user.model.js';
import { hashPassword } from '@common/utils/password.js';
import { logger } from '@common/logger.js';

export async function seedAdmin(adminEmail?: string, adminPassword?: string) {
  const email = (adminEmail || process.env.ADMIN_EMAIL || 'admin@ecommerce.local')
    .toLowerCase()
    .trim();
  const password = adminPassword || process.env.ADMIN_PASSWORD || 'AdminPassword123!';

  await connectMongo();

  const existing = await User.findOne({ email });
  if (existing) {
    if (existing.role === 'admin') {
      logger.info({ email }, 'Admin user already exists');
    } else {
      existing.role = 'admin';
      await existing.save();
      logger.info({ email }, 'Updated existing user role to admin');
    }
  } else {
    const passwordHash = await hashPassword(password);
    await User.create({
      email,
      passwordHash,
      role: 'admin',
      tokenVersion: 0,
    });
    logger.info({ email }, 'Admin user created successfully');
  }

  await disconnectMongo();
}

// Auto-run when executed directly via CLI/script
if (process.argv[1]?.endsWith('seed-admin.ts') || process.argv[1]?.endsWith('seed-admin.js')) {
  seedAdmin()
    .then(() => {
      logger.info('Seed admin finished');
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, 'Failed to seed admin user');
      process.exit(1);
    });
}
