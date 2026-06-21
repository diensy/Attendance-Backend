const db = require('../db');

exports.getLogs = async (req, res) => {
  const userId = req.user.id;
  try {
    const result = await db.query(
      'SELECT * FROM clover_attendance WHERE user_id = $1 ORDER BY date DESC LIMIT 100',
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Get Attendance Logs Error:', err.message);
    res.status(500).json({ message: 'Server error retrieving logs' });
  }
};

exports.logManualAttendance = async (req, res) => {
  const { date, status, study_hours, daily_notes } = req.body;
  const userId = req.user.id;

  if (!date || !status) {
    return res.status(400).json({ message: 'Date and status are required' });
  }

  const hours = Number(Number(study_hours || 0).toFixed(2));

  try {
    // Upsert attendance record
    const queryStr = `
      INSERT INTO clover_attendance (user_id, date, status, study_hours, daily_notes) 
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, date) 
      DO UPDATE SET status = EXCLUDED.status, study_hours = EXCLUDED.study_hours, daily_notes = EXCLUDED.daily_notes
      RETURNING *
    `;

    const result = await db.query(queryStr, [userId, date, status, hours, daily_notes || '']);

    // Recalculate based on new hours and completed todos
    await exports.recalculateAttendance(userId, date);

    // Fetch the final computed attendance
    const finalRes = await db.query(
      'SELECT * FROM clover_attendance WHERE user_id = $1 AND date = $2',
      [userId, date]
    );
    const finalAttendance = finalRes.rows[0];

    // Check goals update using the calculated smart status
    if (hours > 0 && finalAttendance.status === 'Present') {
      // Increment general learning goals
      await db.query(
        'UPDATE clover_goals SET current_hours = LEAST(target_hours, current_hours + $1), is_completed = (current_hours + $1 >= target_hours) WHERE user_id = $2 AND is_completed = false AND category = $3',
        [hours, userId, 'General']
      );
    }

    res.status(201).json({
      message: 'Attendance logged successfully!',
      attendance: finalAttendance
    });
  } catch (err) {
    console.error('Log Attendance Error:', err.message);
    res.status(500).json({ message: 'Server error logging attendance' });
  }
};

exports.getStats = async (req, res) => {
  const userId = req.user.id;

  try {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    // A. Fetch today's attendance details
    const todayAttRes = await db.query(
      'SELECT status, study_hours FROM clover_attendance WHERE user_id = $1 AND date = $2',
      [userId, todayStr]
    );
    let todayStatus = 'Absent';
    let todayStudyHours = 0.00;
    if (todayAttRes.rows.length > 0) {
      todayStatus = todayAttRes.rows[0].status;
      todayStudyHours = Number(todayAttRes.rows[0].study_hours);
    }

    // B. Fetch today's focus sessions to count total seconds and list topics studied
    const todayFocusRes = await db.query(
      'SELECT duration_seconds, topics FROM clover_focus_sessions WHERE user_id = $1 AND completed_at::date = $2',
      [userId, todayStr]
    );
    let todayFocusSeconds = 0;
    const topicsSet = new Set();
    todayFocusRes.rows.forEach(row => {
      todayFocusSeconds += parseInt(row.duration_seconds || '0');
      if (row.topics && Array.isArray(row.topics)) {
        row.topics.forEach(t => topicsSet.add(t));
      }
    });
    const topicsLearnedToday = Array.from(topicsSet);

    // C. Fetch completed and total todos due today
    const todosTodayRes = await db.query(
      'SELECT COUNT(*) as total, COUNT(CASE WHEN is_completed = true THEN 1 END) as completed FROM clover_todos WHERE user_id = $1 AND due_date = $2',
      [userId, todayStr]
    );
    const todosTotalToday = parseInt(todosTodayRes.rows[0].total || '0');
    const todosCompletedToday = parseInt(todosTodayRes.rows[0].completed || '0');

    // D. Fetch GitHub commits today
    const { getTodayCommitsCount } = require('./githubController');
    const todayCommits = await getTodayCommitsCount(userId);

    // E. Calculate weighted productivity score components
    // 1. Attendance (30%)
    let attendancePts = 0;
    if (todayStatus === 'Present') attendancePts = 30;
    else if (todayStatus === 'Half Day') attendancePts = 15;

    // 2. Focus Time (25%) - 2 hours (7200 seconds) target
    const focusPts = Math.min(25, (todayFocusSeconds / 7200) * 25);

    // 3. Todo Complete (25%)
    let todoPts = 0;
    if (todosTotalToday > 0) {
      todoPts = (todosCompletedToday / todosTotalToday) * 25;
    }

    // 4. GitHub Commits (20%) - 3 commits = 20 pts, 2 commits = 14 pts, 1 commit = 8 pts, 0 commits = 0 pts
    let githubPts = 0;
    if (todayCommits >= 3) githubPts = 20;
    else if (todayCommits === 2) githubPts = 14;
    else if (todayCommits === 1) githubPts = 8;

    const totalProductivityScore = Math.round(attendancePts + focusPts + todoPts + githubPts);

    const productivityBreakdown = {
      attendance: Number(attendancePts.toFixed(1)),
      focusTime: Number(focusPts.toFixed(1)),
      todos: Number(todoPts.toFixed(1)),
      github: Number(githubPts.toFixed(1)),
      total: totalProductivityScore
    };

    // 1. Fetch all attendance logs for the user to compute percentages and streaks
    const result = await db.query(
      "SELECT date::text, status, study_hours FROM clover_attendance WHERE user_id = $1 ORDER BY date DESC",
      [userId]
    );

    const logs = result.rows;
    
    // Total present days
    const totalPresent = logs.filter(log => log.status === 'Present').length;
    const totalDays = logs.length;
    const attendancePercentage = totalDays > 0 ? Math.round((totalPresent / totalDays) * 100) : 0;

    // Total study hours
    const totalStudyHours = Number(logs.reduce((acc, log) => acc + Number(log.study_hours), 0).toFixed(2));

    // 2. Calculate consecutive day streak
    let streak = 0;
    
    // Filter present days and parse dates
    const presentDates = logs
      .filter(log => log.status === 'Present')
      .map(log => new Date(log.date))
      .sort((a, b) => b - a); // Sort newest first

    if (presentDates.length > 0) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);

      // Verify if they studied today or yesterday to maintain streak
      const newestDate = new Date(presentDates[0]);
      newestDate.setHours(0, 0, 0, 0);

      if (newestDate >= yesterday) {
        streak = 1;
        let lastDate = newestDate;

        for (let i = 1; i < presentDates.length; i++) {
          const currentDate = new Date(presentDates[i]);
          currentDate.setHours(0, 0, 0, 0);

          const diffTime = Math.abs(lastDate - currentDate);
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

          if (diffDays === 1) {
            streak++;
            lastDate = currentDate;
          } else if (diffDays > 1) {
            break; // Gap detected, end streak count
          }
          // if diffDays is 0, it means multiple logs on same day - ignore
        }
      }
    }

    // 3. Unlock streak badges
    const newBadges = [];
    if (streak >= 3) {
      const badge = { name: 'Three-Leaf Sprout', desc: 'Studied consistently for a 3-day streak!', icon: 'streak-3' };
      const check = await db.query('INSERT INTO clover_achievements (user_id, badge_name, badge_description, icon) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING *', [userId, badge.name, badge.desc, badge.icon]);
      if (check.rows.length > 0) newBadges.push(badge);
    }
    if (streak >= 7) {
      const badge = { name: 'Lucky Seven', desc: 'Reached a consecutive 7-day study streak!', icon: 'streak-7' };
      const check = await db.query('INSERT INTO clover_achievements (user_id, badge_name, badge_description, icon) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING *', [userId, badge.name, badge.desc, badge.icon]);
      if (check.rows.length > 0) newBadges.push(badge);
    }

    // 4. Retrieve unlocked badges
    const badgeRes = await db.query(
      'SELECT badge_name, badge_description, icon, unlocked_at FROM clover_achievements WHERE user_id = $1 ORDER BY unlocked_at ASC',
      [userId]
    );

    res.json({
      totalPresent,
      totalDays,
      attendancePercentage,
      totalStudyHours,
      streak,
      badges: badgeRes.rows,
      newBadgesUnlocked: newBadges,
      
      // Expanded Study OS Stats
      todosCompletedToday,
      todosTotalToday,
      todayCommits,
      todayFocusSeconds,
      productivityScore: totalProductivityScore,
      productivityBreakdown,
      topicsLearnedToday,
      todayStatus
    });
  } catch (err) {
    console.error('Get Stats Error:', err.message);
    res.status(500).json({ message: 'Server error retrieving stats' });
  }
};

exports.recalculateAttendance = async (userId, dateStr) => {
  // 1. Get study hours from focus sessions completed on dateStr
  const focusRes = await db.query(
    "SELECT COALESCE(SUM(duration_seconds), 0) as total_seconds FROM clover_focus_sessions WHERE user_id = $1 AND completed_at::date = $2",
    [userId, dateStr]
  );
  const studySeconds = parseInt(focusRes.rows[0].total_seconds || '0');
  let studyHours = Number((studySeconds / 3600).toFixed(2));

  // 2. Check if a manual attendance log exists to check manual study_hours override
  const attRes = await db.query(
    'SELECT * FROM clover_attendance WHERE user_id = $1 AND date = $2',
    [userId, dateStr]
  );
  
  let attendanceRecord = null;
  if (attRes.rows.length > 0) {
    attendanceRecord = attRes.rows[0];
    const manualHours = Number(attendanceRecord.study_hours);
    if (manualHours > studyHours) {
      studyHours = manualHours;
    }
  }

  // 3. Get completed todos count due on dateStr
  const todosRes = await db.query(
    'SELECT COUNT(*) FROM clover_todos WHERE user_id = $1 AND due_date = $2 AND is_completed = true',
    [userId, dateStr]
  );
  const completedCount = parseInt(todosRes.rows[0].count || '0');

  // 4. Determine status
  let status = 'Absent';
  if (studyHours >= 2.0 && completedCount >= 3) {
    status = 'Present';
  } else if (studyHours >= 1.0) {
    status = 'Half Day';
  }

  // 5. Update or insert the attendance row
  if (attRes.rows.length === 0) {
    // Only insert if they have completed todos or study hours > 0
    if (completedCount > 0 || studyHours > 0) {
      await db.query(
        'INSERT INTO clover_attendance (user_id, date, status, study_hours, daily_notes) VALUES ($1, $2, $3, $4, $5)',
        [userId, dateStr, status, studyHours, '[System] Auto-synchronized study status.']
      );
    }
  } else {
    await db.query(
      'UPDATE clover_attendance SET status = $1, study_hours = $2 WHERE id = $3',
      [status, studyHours, attendanceRecord.id]
    );
  }
};

