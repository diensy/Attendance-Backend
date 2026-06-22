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

    // Migrate existing roadmap items to add completed_at column if needed
    try {
      await db.query(`
        ALTER TABLE clover_roadmap_items ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ DEFAULT NULL;
      `);
      console.log('🍀 [Database] roadmap_items columns verified/migrated.');
    } catch (migErr) {
      console.warn('⚠️ [Database] roadmap_items migration warning:', migErr.message);
    }

    // Migrate existing smart goals to add last_heartbeat column if needed
    try {
      await db.query(`
        ALTER TABLE clover_smart_goals ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMPTZ DEFAULT NULL;
      `);
      console.log('🍀 [Database] smart_goals last_heartbeat verified/migrated.');
    } catch (migErr) {
      console.warn('⚠️ [Database] smart_goals last_heartbeat migration warning:', migErr.message);
    }

    console.log('🍀 [Database] Tables initialized/verified successfully.');
  } catch (err) {
    console.error('❌ [Database] Failed to initialize tables:', err.message);
  }
};

module.exports = initDatabase;
