const fs = require('fs');
const path = require('path');
const db = require('./db');

const initDatabase = async () => {
  try {
    const isDbConnected = await db.testConnection();
    if (!isDbConnected) {
      console.warn('⚠️ [Database] Skipping table initialization due to connection error.');
      return;
    }

    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');

    await db.query(sql);
    
    // Migrate existing smart goals columns to TIMESTAMPTZ if needed
    try {
      await db.query(`
        ALTER TABLE clover_smart_goals ALTER COLUMN start_time TYPE TIMESTAMPTZ;
        ALTER TABLE clover_smart_goals ALTER COLUMN end_time TYPE TIMESTAMPTZ;
        ALTER TABLE clover_smart_goals ALTER COLUMN actual_end_time TYPE TIMESTAMPTZ;
      `);
      console.log('🍀 [Database] smart_goals columns verified/migrated to TIMESTAMPTZ.');
    } catch (migErr) {
      console.warn('⚠️ [Database] smart_goals TIMESTAMPTZ migration warning:', migErr.message);
    }

    console.log('🍀 [Database] Tables initialized/verified successfully.');
  } catch (err) {
    console.error('❌ [Database] Failed to initialize tables:', err.message);
  }
};

module.exports = initDatabase;
