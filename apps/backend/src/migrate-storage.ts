import { Database } from './database.js';
import { migrateLegacyFiles } from './storage.js';
const db = new Database();
try {
  await db.onModuleInit();
  await migrateLegacyFiles(db);
  console.log('Workspace storage migration complete. Original files preserved.');
} finally {
  await db.$disconnect();
}
