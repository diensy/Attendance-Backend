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

      // Auto-complete ended smart goals and send success emails
      await checkAndAutocompleteSmartGoals(now);

      // Auto-interrupt goals when user goes offline or no heartbeat is received
      await checkAndInterruptOfflineSmartGoals(now);

    } catch (err) {
      console.error('❌ [Scheduler] Error in scheduler tick:', err.message);
    }
  }, 60000); // Check every 60 seconds
};

const checkAndAutocompleteSmartGoals = async (now) => {
  try {
    // 1. Find all active goals that have ended
    const goalsRes = await db.query(
      `SELECT g.*, u.username, u.email 
       FROM clover_smart_goals g 
       JOIN clover_users u ON g.user_id = u.id 
       WHERE g.status = 'Active' AND g.end_time <= $1`,
      [now]
    );

    if (goalsRes.rows.length > 0) {
      console.log(`⏰ [Scheduler] Found ${goalsRes.rows.length} ended smart goals. Auto-completing and sending success emails...`);
      
      const { sendGoalCompletedEmail } = require('./mailer');
      const { recalculateAttendance } = require('../controllers/attendanceController');

      for (const goal of goalsRes.rows) {
        // A. Update status to Completed in database
        await db.query(
          `UPDATE clover_smart_goals 
           SET status = 'Completed', actual_end_time = end_time 
           WHERE id = $1`,
          [goal.id]
        );

        // B. Recalculate attendance for that date to update streaks timezone-safely
        const dateStr = new Date(goal.end_time).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        await recalculateAttendance(goal.user_id, dateStr);

        // C. Send success email
        await sendGoalCompletedEmail(goal.email, goal.username, goal);
      }
    }
  } catch (err) {
    console.error('❌ [Scheduler] Error in checkAndAutocompleteSmartGoals:', err.message);
  }
};

const checkAndInterruptOfflineSmartGoals = async (now) => {
  try {
    // Find all active goals currently within their scheduled window
    const goalsRes = await db.query(
      `SELECT g.*, u.username, u.email 
       FROM clover_smart_goals g 
       JOIN clover_users u ON g.user_id = u.id 
       WHERE g.status = 'Active' AND g.start_time <= $1 AND g.end_time > $1`,
      [now]
    );

    if (goalsRes.rows.length > 0) {
      const { sendEarlyQuitEmail } = require('./mailer');
      const { recalculateAttendance } = require('../controllers/attendanceController');

      for (const goal of goalsRes.rows) {
        let shouldInterrupt = false;
        let quitReason = '';

        const startTime = new Date(goal.start_time);
        
        if (goal.last_heartbeat) {
          const lastHeartbeat = new Date(goal.last_heartbeat);
          const diffSeconds = Math.floor((now - lastHeartbeat) / 1000);
          if (diffSeconds > 90) {
            shouldInterrupt = true;
            quitReason = 'Application Closed / User Offline';
          }
        } else {
          // No heartbeat ever received. Check if 5 minutes (300 seconds) have passed since the start time.
          const diffMinutes = Math.floor((now - startTime) / 60000);
          if (diffMinutes >= 5) {
            shouldInterrupt = true;
            quitReason = 'Session never started (No heartbeat)';
          }
        }

        if (shouldInterrupt) {
          console.log(`⏰ [Scheduler] Interrupting smart goal ${goal.id} for user ${goal.user_id} due to inactivity. Reason: ${quitReason}`);
          
          // Update status to Interrupted, set actual_end_time to now, and record quit_reason
          await db.query(
            `UPDATE clover_smart_goals 
             SET status = 'Interrupted', 
                 actual_end_time = $2, 
                 quit_reason = $3 
             WHERE id = $1`,
            [goal.id, now, quitReason]
          );

          // Recalculate attendance
          const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
          await recalculateAttendance(goal.user_id, dateStr);

          // Send email
          await sendEarlyQuitEmail(goal.email, goal.username, { ...goal, actual_end_time: now }, quitReason);
        }
      }
    }
  } catch (err) {
    console.error('❌ [Scheduler] Error in checkAndInterruptOfflineSmartGoals:', err.message);
  }
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
