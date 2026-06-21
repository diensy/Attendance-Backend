const fs = require('fs');
const path = require('path');
const db = require('./db');

const migrate = async () => {
  console.log('🍀 [Migration] Starting database migration for Code Clover...');
  
  // 1. Test connection
  const connected = await db.testConnection();
  if (!connected) {
    console.error('❌ [Migration] Database connection failed. Please check your credentials in .env.');
    process.exit(1);
  }

  try {
    // 2. Read schema.sql file
    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');

    console.log('🍀 [Migration] Reading schema.sql definitions...');
    
    // We can run the entire schema block
    await db.query(sql);

    // Verify individual tables exist in database
    const tablesToVerify = [
      'clover_users',
      'clover_attendance',
      'clover_focus_sessions',
      'clover_goals',
      'clover_achievements',
      'clover_todos',
      'clover_courses',
      'clover_course_videos',
      'clover_user_video_progress',
      'clover_roadmaps',
      'clover_roadmap_items'
    ];

    console.log('\n🔍 [Migration] Verifying table status:');
    for (const table of tablesToVerify) {
      const res = await db.query(
        "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)",
        [table]
      );
      const exists = res.rows[0].exists;
      if (exists) {
        console.log(`  ✅ Table "${table}" is verified and active.`);
      } else {
        console.warn(`  ⚠️ Table "${table}" could not be verified.`);
      }
    }

    console.log('\n🍀 [Migration] Database migration completed successfully!');
    process.exit(0);

  } catch (err) {
    console.error('\n❌ [Migration] Migration failed with error:', err.message);
    process.exit(1);
  }
};

migrate();
