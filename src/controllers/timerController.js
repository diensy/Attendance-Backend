const db = require('../db');

exports.logSession = async (req, res) => {
  const { type, mode, duration_seconds, topics, notes } = req.body;
  const userId = req.user.id;

  if (!type || !duration_seconds) {
    return res.status(400).json({ message: 'Type and duration are required' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Insert focus session
    const sessionResult = await client.query(
      'INSERT INTO clover_focus_sessions (user_id, type, mode, duration_seconds, topics, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [userId, type, mode || 'Custom', duration_seconds, topics || [], notes || '']
    );

    const session = sessionResult.rows[0];
    const addedHours = Number((duration_seconds / 3600).toFixed(2));

    // 2. Automate/Update Attendance for today
    const localDateObj = new Date();
    const today = `${localDateObj.getFullYear()}-${String(localDateObj.getMonth() + 1).padStart(2, '0')}-${String(localDateObj.getDate()).padStart(2, '0')}`;
    
    // Check if attendance exists
    const attendanceCheck = await client.query(
      'SELECT * FROM clover_attendance WHERE user_id = $1 AND date = $2',
      [userId, today]
    );

    let attendance;
    if (attendanceCheck.rows.length === 0) {
      // Create new attendance
      const notesText = notes ? `[Timer Session]: ${notes}` : '[Timer Session] Focused study.';
      const newAttendance = await client.query(
        'INSERT INTO clover_attendance (user_id, date, status, study_hours, daily_notes) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [userId, today, 'Present', addedHours, notesText]
      );
      attendance = newAttendance.rows[0];
    } else {
      // Update attendance
      const existing = attendanceCheck.rows[0];
      const newHours = Number((Number(existing.study_hours) + addedHours).toFixed(2));
      const updatedNotes = notes 
        ? (existing.daily_notes ? `${existing.daily_notes}\n[Timer Session]: ${notes}` : `[Timer Session]: ${notes}`)
        : existing.daily_notes;

      const updatedAttendance = await client.query(
        'UPDATE clover_attendance SET status = $1, study_hours = $2, daily_notes = $3 WHERE id = $4 RETURNING *',
        ['Present', newHours, updatedNotes, existing.id]
      );
      attendance = updatedAttendance.rows[0];
    }

    // 3. Update goals target hours if relevant categories exist
    if (topics && topics.length > 0) {
      for (const topic of topics) {
        // Find active uncompleted goal for this category
        // Categories can be Node.js, Python, DSA, AI/Data Science, GitHub, General
        await client.query(
          'UPDATE clover_goals SET current_hours = LEAST(target_hours, current_hours + $1), is_completed = (current_hours + $1 >= target_hours) WHERE user_id = $2 AND is_completed = false AND category ILIKE $3',
          [addedHours, userId, `%${topic}%`]
        );
      }
    }

    // 4. Achievement & Badges checks
    const badgesUnlocked = [];

    // Badge 1: First Leaf (first focus session)
    const sessionCountRes = await client.query(
      'SELECT count(*) FROM clover_focus_sessions WHERE user_id = $1',
      [userId]
    );
    const sessionCount = parseInt(sessionCountRes.rows[0].count);
    if (sessionCount === 1) {
      const badge = { name: 'First Leaf', desc: 'Logged your very first focus session!', icon: 'leaf-1' };
      const check = await client.query('INSERT INTO clover_achievements (user_id, badge_name, badge_description, icon) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING *', [userId, badge.name, badge.desc, badge.icon]);
      if (check.rows.length > 0) badgesUnlocked.push(badge);
    }

    // Badge 2: Deep Focus (focused for 1 hour or more in a single session)
    if (duration_seconds >= 3600) {
      const badge = { name: 'Deep Focus', desc: 'Completed a continuous study session of 1 hour or more.', icon: 'focus' };
      const check = await client.query('INSERT INTO clover_achievements (user_id, badge_name, badge_description, icon) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING *', [userId, badge.name, badge.desc, badge.icon]);
      if (check.rows.length > 0) badgesUnlocked.push(badge);
    }

    // Badge 3: Ten-Fold Luck (reached 10 total focus hours)
    const totalHoursRes = await client.query(
      'SELECT SUM(duration_seconds) FROM clover_focus_sessions WHERE user_id = $1',
      [userId]
    );
    const totalSeconds = parseInt(totalHoursRes.rows[0].sum || '0');
    if (totalSeconds >= 36000) { // 10 hours
      const badge = { name: 'Ten-Fold Luck', desc: 'Reached a cumulative 10 hours of focused study time!', icon: 'clover-4' };
      const check = await client.query('INSERT INTO clover_achievements (user_id, badge_name, badge_description, icon) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING *', [userId, badge.name, badge.desc, badge.icon]);
      if (check.rows.length > 0) badgesUnlocked.push(badge);
    }

    await client.query('COMMIT');

    let updatedAttendance = attendance;
    try {
      const { recalculateAttendance } = require('./attendanceController');
      await recalculateAttendance(userId, today);

      const attFetch = await db.query(
        'SELECT * FROM clover_attendance WHERE user_id = $1 AND date = $2',
        [userId, today]
      );
      if (attFetch.rows.length > 0) {
        updatedAttendance = attFetch.rows[0];
      }
    } catch (attErr) {
      console.error('Error recalculating attendance after session log:', attErr.message);
    }

    res.status(201).json({
      message: 'Study session logged successfully!',
      session,
      attendance: updatedAttendance,
      badgesUnlocked
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Session Logging Error:', err.message);
    res.status(500).json({ message: 'Server error logging session' });
  } finally {
    client.release();
  }
};

exports.getSessions = async (req, res) => {
  const userId = req.user.id;
  try {
    const result = await db.query(
      'SELECT * FROM clover_focus_sessions WHERE user_id = $1 ORDER BY completed_at DESC LIMIT 50',
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Get Sessions Error:', err.message);
    res.status(500).json({ message: 'Server error retrieving sessions' });
  }
};

exports.getAnalytics = async (req, res) => {
  const userId = req.user.id;
  const localDateObj = new Date();
  const today = `${localDateObj.getFullYear()}-${String(localDateObj.getMonth() + 1).padStart(2, '0')}-${String(localDateObj.getDate()).padStart(2, '0')}`;

  try {
    // 1. Today's focus time
    const todayRes = await db.query(
      "SELECT SUM(duration_seconds) as sum FROM clover_focus_sessions WHERE user_id = $1 AND completed_at::date = $2",
      [userId, today]
    );
    const todayFocusSeconds = parseInt(todayRes.rows[0].sum || '0');

    // 2. Weekly focus hours (past 7 days)
    const weekRes = await db.query(
      "SELECT SUM(duration_seconds) as sum FROM clover_focus_sessions WHERE user_id = $1 AND completed_at >= NOW() - INTERVAL '7 days'",
      [userId]
    );
    const weekFocusHours = Number((parseInt(weekRes.rows[0].sum || '0') / 3600).toFixed(2));

    // 3. Longest study session
    const longestRes = await db.query(
      "SELECT MAX(duration_seconds) as max FROM clover_focus_sessions WHERE user_id = $1",
      [userId]
    );
    const longestSessionSeconds = parseInt(longestRes.rows[0].max || '0');

    // 4. Daily productivity score (Weighted Study OS Score)
    let todayStatus = 'Absent';
    const attRes = await db.query(
      'SELECT status FROM clover_attendance WHERE user_id = $1 AND date = $2',
      [userId, today]
    );
    if (attRes.rows.length > 0) {
      todayStatus = attRes.rows[0].status;
    }

    const todosTodayRes = await db.query(
      'SELECT COUNT(*) as total, COUNT(CASE WHEN is_completed = true THEN 1 END) as completed FROM clover_todos WHERE user_id = $1 AND due_date = $2',
      [userId, today]
    );
    const todosTotalToday = parseInt(todosTodayRes.rows[0].total || '0');
    const todosCompletedToday = parseInt(todosTodayRes.rows[0].completed || '0');

    const { getTodayCommitsCount } = require('./githubController');
    const todayCommits = await getTodayCommitsCount(userId);

    // Score components
    let attendancePts = 0;
    if (todayStatus === 'Present') attendancePts = 30;
    else if (todayStatus === 'Half Day') attendancePts = 15;

    const focusPts = Math.min(25, (todayFocusSeconds / 7200) * 25);

    let todoPts = 0;
    if (todosTotalToday > 0) {
      todoPts = (todosCompletedToday / todosTotalToday) * 25;
    }

    let githubPts = 0;
    if (todayCommits >= 3) githubPts = 20;
    else if (todayCommits === 2) githubPts = 14;
    else if (todayCommits === 1) githubPts = 8;

    const productivityScore = Math.round(attendancePts + focusPts + todoPts + githubPts);

    // 5. Subject-wise distribution (UNNEST topics array)
    const subjectRes = await db.query(
      `SELECT UNNEST(topics) as subject, SUM(duration_seconds) as total_seconds 
       FROM clover_focus_sessions 
       WHERE user_id = $1 
       GROUP BY subject 
       ORDER BY total_seconds DESC`,
      [userId]
    );
    const subjectDistribution = subjectRes.rows.map(row => ({
      subject: row.subject,
      hours: Number((parseInt(row.total_seconds) / 3600).toFixed(2))
    }));

    // 6. Trend data: focus duration grouped by day for the last 7 days
    const trendRes = await db.query(
      `SELECT d.date::date as study_date, COALESCE(SUM(s.duration_seconds), 0) as total_seconds
       FROM (
         SELECT CURRENT_DATE - i as date
         FROM generate_series(0, 6) i
       ) d
       LEFT JOIN clover_focus_sessions s ON s.completed_at::date = d.date AND s.user_id = $1
       GROUP BY d.date
       ORDER BY d.date ASC`,
      [userId]
    );
    
    const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const focusTrend = trendRes.rows.map(row => {
      const dateObj = new Date(row.study_date);
      const year = dateObj.getFullYear();
      const month = String(dateObj.getMonth() + 1).padStart(2, '0');
      const dayVal = String(dateObj.getDate()).padStart(2, '0');
      return {
        date: `${year}-${month}-${dayVal}`,
        day: weekdayNames[dateObj.getDay()],
        hours: Number((parseInt(row.total_seconds) / 3600).toFixed(2))
      };
    });

    res.json({
      todayFocusSeconds,
      weekFocusHours,
      longestSessionSeconds,
      productivityScore,
      subjectDistribution,
      focusTrend
    });
  } catch (err) {
    console.error('Analytics Error:', err.message);
    res.status(500).json({ message: 'Server error calculating analytics' });
  }
};
