const db = require('../db');
const { 
  sendDailyGoalsReminderEmail, 
  sendSmartGoalReminderEmail 
} = require('./mailer');

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
      await checkSmartGoalReminders();

      // Auto-complete ended smart goals and send success emails
      await checkAndAutocompleteSmartGoals();

      // Auto-interrupt goals when user goes offline or no heartbeat is received (timezone safe & DB-driven)
      await checkAndInterruptOfflineSmartGoals();

    } catch (err) {
      console.error('❌ [Scheduler] Error in scheduler tick:', err.message);
    }
  }, 60000); // Check every 60 seconds
};

const checkAndAutocompleteSmartGoals = async () => {
  try {
    // 1. Find all active goals that have ended using DB time NOW()
    const goalsRes = await db.query(
      `SELECT g.*, u.username, u.email 
       FROM clover_smart_goals g 
       JOIN clover_users u ON g.user_id = u.id 
       WHERE g.status = 'Active' AND g.end_time <= NOW()`
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
        try {
          await sendGoalCompletedEmail(goal.email, goal.username, goal);
        } catch (mailErr) {
          console.warn(`⏰ [Scheduler] Email send skipped (not configured?): ${mailErr.message}`);
        }
      }
    }
  } catch (err) {
    console.error('❌ [Scheduler] Error in checkAndAutocompleteSmartGoals:', err.message);
  }
};

const checkAndInterruptOfflineSmartGoals = async () => {
  try {
    // Find active goals within their scheduled window that should be interrupted:
    // Either they have a heartbeat and the last heartbeat was > 180 seconds (3 mins) ago,
    // OR they have no heartbeat and start_time was >= 10 minutes (600 seconds) ago.
    // Done entirely inside DB to be 100% timezone-safe and clock-drift free.
    const goalsRes = await db.query(
      `SELECT g.*, u.username, u.email,
              CASE 
                WHEN g.last_heartbeat IS NOT NULL THEN 'Application Closed / User Offline'
                ELSE 'Session never started (No heartbeat)'
              END as quit_reason_label
       FROM clover_smart_goals g 
       JOIN clover_users u ON g.user_id = u.id 
       WHERE g.status = 'Active' 
         AND g.start_time <= NOW() 
         AND g.end_time > NOW()
         AND (
           (g.last_heartbeat IS NOT NULL AND EXTRACT(EPOCH FROM (NOW() - g.last_heartbeat)) > 180)
           OR
           (g.last_heartbeat IS NULL AND EXTRACT(EPOCH FROM (NOW() - g.start_time)) >= 600)
         )`
    );

    if (goalsRes.rows.length > 0) {
      const { sendEarlyQuitEmail } = require('./mailer');
      const { recalculateAttendance } = require('../controllers/attendanceController');

      for (const goal of goalsRes.rows) {
        const quitReason = goal.quit_reason_label;
        console.log(`⏰ [Scheduler] Interrupting smart goal ${goal.id} for user ${goal.user_id} due to inactivity. Reason: ${quitReason}`);
        
        // Update status to Interrupted, set actual_end_time to NOW(), and record quit_reason
        await db.query(
          `UPDATE clover_smart_goals 
           SET status = 'Interrupted', 
               actual_end_time = NOW(), 
               quit_reason = $2 
           WHERE id = $1`,
          [goal.id, quitReason]
        );

        // Recalculate attendance
        const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        await recalculateAttendance(goal.user_id, dateStr);

        // Send email (non-fatal — skip if email is not configured)
        try {
          await sendEarlyQuitEmail(goal.email, goal.username, { ...goal, actual_end_time: new Date() }, quitReason);
        } catch (mailErr) {
          console.warn(`⏰ [Scheduler] Email send skipped (not configured?): ${mailErr.message}`);
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

const checkSmartGoalReminders = async () => {
  try {
    // Query goals starting within 60 mins or 30 mins where emails haven't been sent.
    // Calculations done inside DB via NOW() to ensure TZ-independence.
    const goalsRes = await db.query(
      `SELECT g.*, u.username, u.email,
              EXTRACT(EPOCH FROM (g.start_time - NOW())) / 60 as diff_mins
       FROM clover_smart_goals g 
       JOIN clover_users u ON g.user_id = u.id 
       WHERE g.status = 'Active' 
         AND (
           (EXTRACT(EPOCH FROM (g.start_time - NOW())) / 60 <= 60 AND EXTRACT(EPOCH FROM (g.start_time - NOW())) / 60 >= 45 AND g.reminder_sent_60 = FALSE)
           OR
           (EXTRACT(EPOCH FROM (g.start_time - NOW())) / 60 <= 30 AND EXTRACT(EPOCH FROM (g.start_time - NOW())) / 60 >= 15 AND g.reminder_sent_30 = FALSE)
         )`
    );

    for (const goal of goalsRes.rows) {
      const diffMins = Math.floor(goal.diff_mins);

      // Send 60-min reminder: starting in <= 60 mins and >= 45 mins, and not yet sent
      if (diffMins <= 60 && diffMins >= 45 && !goal.reminder_sent_60) {
        console.log(`⏰ [Scheduler] Sending 60-min reminder to ${goal.email} for goal: ${goal.title}`);
        await sendSmartGoalReminderEmail(goal.email, goal.username, goal, diffMins);
        await db.query(
          `UPDATE clover_smart_goals SET reminder_sent_60 = TRUE WHERE id = $1`,
          [goal.id]
        );
      }
      // Send 30-min reminder: starting in <= 30 mins and >= 15 mins, and not yet sent
      else if (diffMins <= 30 && diffMins >= 15 && !goal.reminder_sent_30) {
        console.log(`⏰ [Scheduler] Sending 30-min reminder to ${goal.email} for goal: ${goal.title}`);
        await sendSmartGoalReminderEmail(goal.email, goal.username, goal, diffMins);
        await db.query(
          `UPDATE clover_smart_goals SET reminder_sent_30 = TRUE WHERE id = $1`,
          [goal.id]
        );
      }
    }
  } catch (err) {
    console.error('❌ [Scheduler] Error in checkSmartGoalReminders:', err.message);
  }
};

module.exports = { startScheduler };
