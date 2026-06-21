const db = require('../db');
const { sendEarlyQuitEmail } = require('../utils/mailer');

exports.getSmartGoals = async (req, res) => {
  const userId = req.user.id;
  try {
    // Auto-complete any active goals where the end_time has passed
    const autoCompletedRes = await db.query(
      `UPDATE clover_smart_goals 
       SET status = 'Completed', actual_end_time = end_time
       WHERE user_id = $1 AND status = 'Active' AND end_time <= CURRENT_TIMESTAMP
       RETURNING end_time`,
      [userId]
    );

    if (autoCompletedRes.rows.length > 0) {
      const { recalculateAttendance } = require('./attendanceController');
      for (const row of autoCompletedRes.rows) {
        const dateStr = new Date(row.end_time).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        await recalculateAttendance(userId, dateStr);
      }
    }

    const result = await db.query(
      `SELECT * FROM clover_smart_goals 
       WHERE user_id = $1 
       ORDER BY start_time DESC`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Get smart goals error:', err.message);
    res.status(500).json({ message: 'Server error retrieving smart goals' });
  }
};

exports.createSmartGoal = async (req, res) => {
  const userId = req.user.id;
  const { title, start_time, end_time, reason, priority } = req.body;

  try {
    const result = await db.query(
      `INSERT INTO clover_smart_goals (user_id, title, start_time, end_time, reason, priority, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Active') RETURNING *`,
      [userId, title, start_time, end_time, reason, priority || 'Medium']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create smart goal error:', err.message);
    res.status(500).json({ message: 'Server error creating smart goal' });
  }
};

exports.interruptSmartGoal = async (req, res) => {
  const userId = req.user.id;
  const goalId = req.params.id;
  const { quit_reason } = req.body;

  try {
    const result = await db.query(
      `UPDATE clover_smart_goals 
       SET status = 'Interrupted', 
           actual_end_time = COALESCE(actual_end_time, CURRENT_TIMESTAMP), 
           quit_reason = COALESCE($3, quit_reason)
       WHERE id = $1 AND user_id = $2 AND (status = 'Active' OR status = 'Interrupted') RETURNING *`,
      [goalId, userId, quit_reason || null]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Active goal not found.' });
    }
    
    // Send early quit email in the background
    if (quit_reason) {
      // Get user email and username
      const userRes = await db.query('SELECT username, email FROM clover_users WHERE id = $1', [userId]);
      if (userRes.rows.length > 0) {
        const user = userRes.rows[0];
        sendEarlyQuitEmail(user.email, user.username, result.rows[0], quit_reason).catch(console.error);
      }
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Interrupt goal error:', err.message);
    res.status(500).json({ message: 'Server error interrupting goal' });
  }
};

exports.completeSmartGoal = async (req, res) => {
  const userId = req.user.id;
  const goalId = req.params.id;

  try {
    const result = await db.query(
      `UPDATE clover_smart_goals 
       SET status = 'Completed', actual_end_time = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2 AND status = 'Active' RETURNING *`,
      [goalId, userId]
    );
    if (result.rows.length > 0) {
      const { recalculateAttendance } = require('./attendanceController');
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      await recalculateAttendance(userId, todayStr);
    }
    res.json(result.rows[0] || { message: 'Goal already completed or not found' });
  } catch (err) {
    console.error('Complete goal error:', err.message);
    res.status(500).json({ message: 'Server error completing goal' });
  }
};

exports.saveQuitReason = async (req, res) => {
  const userId = req.user.id;
  const goalId = req.params.id;
  const { quit_reason } = req.body;

  try {
    const result = await db.query(
      `UPDATE clover_smart_goals 
       SET quit_reason = $1
       WHERE id = $2 AND user_id = $3 RETURNING *`,
      [quit_reason, goalId, userId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Save quit reason error:', err.message);
    res.status(500).json({ message: 'Server error saving quit reason' });
  }
};
exports.handleEarlyLogout = async (req, res) => {
  const userId = req.user.id;
  try {
    // Find all active goals that are currently in progress (started, but not yet ended)
    const result = await db.query(
      `UPDATE clover_smart_goals
       SET status = 'Interrupted', actual_end_time = CURRENT_TIMESTAMP
       WHERE user_id = $1 
         AND status = 'Active' 
         AND start_time <= CURRENT_TIMESTAMP 
         AND end_time > CURRENT_TIMESTAMP
       RETURNING id, title, start_time, end_time`,
      [userId]
    );
    
    const interruptedGoals = result.rows;

    if (interruptedGoals.length > 0) {
      // Get user email
      const userRes = await db.query('SELECT username, email FROM clover_users WHERE id = $1', [userId]);
      if (userRes.rows.length > 0) {
        const user = userRes.rows[0];
        // Send email for each interrupted goal
        for (const goal of interruptedGoals) {
          sendEarlyQuitEmail(user.email, user.username, goal, "Session was abandoned. Reason required.").catch(console.error);
        }
      }
    }

    res.json({ message: 'Logout processed', interruptedGoals });
  } catch (err) {
    console.error('Early logout error:', err.message);
    res.status(500).json({ message: 'Server error processing early logout' });
  }
};
