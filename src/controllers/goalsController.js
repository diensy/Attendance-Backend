const db = require('../db');
const { sendDailyGoalsReminderEmail } = require('../utils/mailer');

exports.getGoals = async (req, res) => {
  const userId = req.user.id;
  try {
    const result = await db.query(
      'SELECT * FROM clover_goals WHERE user_id = $1 ORDER BY target_date ASC, created_at DESC',
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Get Goals Error:', err.message);
    res.status(500).json({ message: 'Server error retrieving goals' });
  }
};

exports.createGoal = async (req, res) => {
  const { title, category, target_hours, target_date } = req.body;
  const userId = req.user.id;

  if (!title || !category || !target_hours || !target_date) {
    return res.status(400).json({ message: 'Please enter all fields' });
  }

  try {
    const result = await db.query(
      `INSERT INTO clover_goals (user_id, title, category, target_hours, current_hours, target_date, is_completed)
       VALUES ($1, $2, $3, $4, 0.00, $5, false) RETURNING *`,
      [userId, title.trim(), category.trim(), Number(target_hours), target_date]
    );

    res.status(201).json({
      message: 'Goal created successfully!',
      goal: result.rows[0]
    });
  } catch (err) {
    console.error('Create Goal Error:', err.message);
    res.status(500).json({ message: 'Server error creating goal' });
  }
};

exports.updateGoal = async (req, res) => {
  const { id } = req.params;
  const { current_hours, is_completed } = req.body;
  const userId = req.user.id;

  try {
    // Verify goal ownership
    const goalCheck = await db.query(
      'SELECT * FROM clover_goals WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    if (goalCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Goal not found' });
    }

    const goal = goalCheck.rows[0];
    const newCurrentHours = current_hours !== undefined ? Number(current_hours) : Number(goal.current_hours);
    const targetHours = Number(goal.target_hours);
    
    // Automatically set completed if current_hours >= target_hours
    let autoCompleted = is_completed !== undefined ? is_completed : goal.is_completed;
    if (newCurrentHours >= targetHours) {
      autoCompleted = true;
    }

    const result = await db.query(
      'UPDATE clover_goals SET current_hours = $1, is_completed = $2 WHERE id = $3 RETURNING *',
      [newCurrentHours, autoCompleted, id]
    );

    // Goal Completion Achievement Check
    let badgeUnlocked = null;
    if (autoCompleted && !goal.is_completed) {
      // Add achievement
      try {
        const badge = { name: 'Goal Getter', desc: 'Successfully achieved one of your learning targets!', icon: 'target' };
        const check = await db.query('INSERT INTO clover_achievements (user_id, badge_name, badge_description, icon) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING *', [userId, badge.name, badge.desc, badge.icon]);
        if (check.rows.length > 0) badgeUnlocked = badge;
      } catch (err) {
        console.error('Goal badge unlock error:', err.message);
      }
    }

    res.json({
      message: 'Goal updated successfully',
      goal: result.rows[0],
      badgeUnlocked
    });
  } catch (err) {
    console.error('Update Goal Error:', err.message);
    res.status(500).json({ message: 'Server error updating goal' });
  }
};

exports.deleteGoal = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    const result = await db.query(
      'DELETE FROM clover_goals WHERE id = $1 AND user_id = $2 RETURNING *',
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Goal not found or unauthorized' });
    }

    res.json({ message: 'Goal deleted successfully' });
  } catch (err) {
    console.error('Delete Goal Error:', err.message);
    res.status(500).json({ message: 'Server error deleting goal' });
  }
};

exports.triggerReminders = async (req, res) => {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  try {
    // Find all uncompleted goals for today
    const goalsRes = await db.query(
      `SELECT g.*, u.username, u.email 
       FROM clover_goals g 
       JOIN clover_users u ON g.user_id = u.id 
       WHERE g.target_date = $1 AND g.is_completed = false`,
      [todayStr]
    );

    if (goalsRes.rows.length === 0) {
      return res.json({ message: 'No incomplete goals scheduled for today found.' });
    }

    // Group goals by email
    const userGoals = {};
    goalsRes.rows.forEach(row => {
      if (!userGoals[row.email]) {
        userGoals[row.email] = {
          username: row.username,
          goals: []
        };
      }
      userGoals[row.email].goals.push({
        title: row.title,
        category: row.category,
        current_hours: row.current_hours,
        target_hours: row.target_hours,
        target_date: row.target_date
      });
    });

    const results = [];
    for (const [email, data] of Object.entries(userGoals)) {
      const emailResult = await sendDailyGoalsReminderEmail(email, data.username, data.goals);
      results.push({ email, success: !emailResult.error, devFallback: !!emailResult.devFallback });
    }

    res.json({
      message: 'Reminder trigger process finished.',
      processedCount: results.length,
      details: results
    });

  } catch (err) {
    console.error('Manual Reminders Trigger Error:', err.message);
    res.status(500).json({ message: 'Server error triggering reminders manually' });
  }
};

