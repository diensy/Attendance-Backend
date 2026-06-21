const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'Attendance',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'Dinesh@2002',
});

// Function to check connection on startup
const testConnection = async () => {
  try {
    const client = await pool.connect();
    console.log(`🍀 [Database] Connected successfully to PostgreSQL database: "${process.env.DB_NAME || 'Attendance'}"`);
    client.release();
    return true;
  } catch (err) {
    console.error('❌ [Database] Connection failed!');
    console.error('Details:', err.message);
    console.log('💡 Note: Please ensure your PostgreSQL service is running and credentials in backend/.env match.');
    return false;
  }
};

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  testConnection
};
