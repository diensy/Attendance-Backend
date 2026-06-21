const db = require('../db');
const { sendDailyGoalsReminderEmail, sendSmartGoalReminderEmail } = require('./mailer');

const startScheduler = () => {
  console.log('⏰ [Scheduler] Background study reminder scheduler active.');
  
  // Track date we sent email to avoid double firing inside the same minute
  let lastSentDateStr = '';

  setInterval(async () => {
    try {
      const now = new Date();
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();
      const currentDateStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

      // Check if it is exactly 9:00 PM (21:00) and hasn't been sent yet today
      if (currentHour === 21 && currentMinute === 0 && lastSentDateStr !== currentDateStr) {
        lastSentDateStr = currentDateStr;
        console.log(`⏰ [Scheduler] 9:00 PM check. Querying database for today's incomplete goals...`);
        await sendGoalRemindersForToday();
      }

      // Check for Smart Goals starting in 60 mins or 30 mins
      await checkSmartGoalReminders(now);

    } catch (err) {
      console.error('❌ [Scheduler] Error in scheduler tick:', err.message);
    }
  }, 60000); // Check every 60 seconds
};

const sendGoalRemindersForToday = async () => {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  try {
    // Query all uncompleted goals set for today
    const goalsRes = await db.query(
      `SELECT g.*, u.username, u.email 
       FROM clover_goals g 
       JOIN clover_users u ON g.user_id = u.id 
       WHERE g.target_date = $1 AND g.is_completed = false`,
      [todayStr]
    );

    if (goalsRes.rows.length === 0) {
      console.log('⏰ [Scheduler] No incomplete study goals scheduled for today.');
      return;
    }

    // Group the incomplete goals by user email
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

    // Send emails
    for (const [email, data] of Object.entries(userGoals)) {
      console.log(`⏰ [Scheduler] Sending goal reminder email to: ${email} with ${data.goals.length} incomplete goals.`);
      await sendDailyGoalsReminderEmail(email, data.username, data.goals);
    }

  } catch (err) {
    console.error('❌ [Scheduler] Error during scheduled daily goal reminders query:', err.message);
  }
};

const checkSmartGoalReminders = async (now) => {
  try {
    const goalsRes = await db.query(
      `SELECT g.*, u.username, u.email 
       FROM clover_smart_goals g 
       JOIN clover_users u ON g.user_id = u.id 
       WHERE g.status = 'Active'`
    );

    for (const goal of goalsRes.rows) {
      const startTime = new Date(goal.start_time);
      const diffMs = startTime - now;
      const diffMins = Math.floor(diffMs / 60000);

      // We use exactly 60 or exactly 30 so it only triggers once during that minute.
      if (diffMins === 60) {
        console.log(`⏰ [Scheduler] Sending 60-min reminder to ${goal.email} for goal: ${goal.title}`);
        await sendSmartGoalReminderEmail(goal.email, goal.username, goal, 60);
      } else if (diffMins === 30) {
        console.log(`⏰ [Scheduler] Sending 30-min reminder to ${goal.email} for goal: ${goal.title}`);
        await sendSmartGoalReminderEmail(goal.email, goal.username, goal, 30);
      }
    }
  } catch (err) {
    console.error('❌ [Scheduler] Error in checkSmartGoalReminders:', err.message);
  }
};

module.exports = { startScheduler };
