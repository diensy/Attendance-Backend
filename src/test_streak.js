const db = require('./db');
const { recalculateAttendance } = require('./controllers/attendanceController');

const test = async () => {
  try {
    console.log('Testing connection...');
    await db.query('SELECT NOW()');
    console.log('Connection OK!');

    // 1. Check clover_roadmap_items table columns
    const columnsRes = await db.query(
      `SELECT column_name, data_type 
       FROM information_schema.columns 
       WHERE table_name = 'clover_roadmap_items'`
    );
    console.log('Roadmap Items columns:');
    columnsRes.rows.forEach(col => {
      console.log(`- ${col.column_name}: ${col.data_type}`);
    });

    const completedAtCol = columnsRes.rows.find(col => col.column_name === 'completed_at');
    if (completedAtCol) {
      console.log('✅ completed_at column is successfully migrated and present!');
    } else {
      console.error('❌ completed_at column NOT found!');
    }

    // 2. Query some attendance rows or test calculations
    // Find a user ID to test with
    const userRes = await db.query('SELECT id, username FROM clover_users LIMIT 1');
    if (userRes.rows.length === 0) {
      console.log('No users found in database, skipping recalculate test.');
      return;
    }
    const userId = userRes.rows[0].id;
    const username = userRes.rows[0].username;
    console.log(`Found test user: ${username} (ID: ${userId})`);

    const testDate = '2026-06-21';
    console.log(`Running recalculateAttendance for user ${userId} on date ${testDate}...`);
    await recalculateAttendance(userId, testDate);
    
    const attRes = await db.query(
      'SELECT status, study_hours FROM clover_attendance WHERE user_id = $1 AND date = $2',
      [userId, testDate]
    );
    console.log('Resulting attendance record:', attRes.rows[0]);

  } catch (err) {
    console.error('Test error:', err.message);
  } finally {
    process.exit(0);
  }
};

test();
