const express = require('express');
const cors = require('cors');
require('dotenv').config(); // Load environment variables from .env

// Trigger reload comment: Pick up profile pic, security question, and forgot password routes

const initDatabase = require('./initDb');
const authRoutes = require('./routes/auth');
const attendanceRoutes = require('./routes/attendance');
const timerRoutes = require('./routes/timer');
const goalsRoutes = require('./routes/goals');
const githubRoutes = require('./routes/github');
const aiRoutes = require('./routes/ai');
const reportsRoutes = require('./routes/reports');
const todoRoutes = require('./routes/todos');
const coursesRoutes = require('./routes/courses');
const smartGoalsRoutes = require('./routes/smartGoals');
const { startScheduler } = require('./utils/scheduler');

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS for frontend client
app.use(cors({
  origin: '*', // In development, allow all origins
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Status endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    app: 'Code Clover Backend Server 🍀',
    message: 'Consistency is learning. Growth is luck.',
    time: new Date()
  });
});

// Register API Routes
app.use('/api/auth', authRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/timer', timerRoutes);
app.use('/api/goals', goalsRoutes);
app.use('/api/github', githubRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/todos', todoRoutes);
app.use('/api/courses', coursesRoutes);
app.use('/api/smart-goals', smartGoalsRoutes);

// Start server and initialize database tables
const startServer = async () => {
  console.log('🍀 [Server] Starting Code Clover server...');
  await initDatabase();
  
  app.listen(PORT, () => {
    console.log(`🍀 [Server] Server is running on port ${PORT}`);
    startScheduler();
  });
};

startServer().catch(err => {
  console.error('❌ [Server] Fatal error on startup:', err.message);
});
