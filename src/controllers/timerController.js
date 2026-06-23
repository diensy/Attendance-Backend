const db = require('../db');

// ─── Helper: Award XP points to a user ──────────────────────────────────────
const awardXP = async (userId, points) => {
  if (!points || points <= 0) return;
  await db.query(
    'UPDATE clover_users SET xp_points = COALESCE(xp_points, 0) + $1 WHERE id = $2',
    [points, userId]
  );
};
exports.awardXP = awardXP;

// ─── Log a completed focus session ───────────────────────────────────────────
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
    
    const attendanceCheck = await client.query(
      'SELECT * FROM clover_attendance WHERE user_id = $1 AND date = $2',
      [userId, today]
    );

    let attendance;
    if (attendanceCheck.rows.length === 0) {
      const notesText = notes ? `[Timer Session]: ${notes}` : '[Timer Session] Focused study.';
      const newAttendance = await client.query(
        'INSERT INTO clover_attendance (user_id, date, status, study_hours, daily_notes) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [userId, today, 'Present', addedHours, notesText]
      );
      attendance = newAttendance.rows[0];
    } else {
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
        await client.query(
          'UPDATE clover_goals SET current_hours = LEAST(target_hours, current_hours + $1), is_completed = (current_hours + $1 >= target_hours) WHERE user_id = $2 AND is_completed = false AND category ILIKE $3',
          [addedHours, userId, `%${topic}%`]
        );
      }
    }

    // 4. Achievement & Badges checks
    const badgesUnlocked = [];

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

    if (duration_seconds >= 3600) {
      const badge = { name: 'Deep Focus', desc: 'Completed a continuous study session of 1 hour or more.', icon: 'focus' };
      const check = await client.query('INSERT INTO clover_achievements (user_id, badge_name, badge_description, icon) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING *', [userId, badge.name, badge.desc, badge.icon]);
      if (check.rows.length > 0) badgesUnlocked.push(badge);
    }

    const totalHoursRes = await client.query(
      'SELECT SUM(duration_seconds) FROM clover_focus_sessions WHERE user_id = $1',
      [userId]
    );
    const totalSeconds = parseInt(totalHoursRes.rows[0].sum || '0');
    if (totalSeconds >= 36000) {
      const badge = { name: 'Ten-Fold Luck', desc: 'Reached a cumulative 10 hours of focused study time!', icon: 'clover-4' };
      const check = await client.query('INSERT INTO clover_achievements (user_id, badge_name, badge_description, icon) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING *', [userId, badge.name, badge.desc, badge.icon]);
      if (check.rows.length > 0) badgesUnlocked.push(badge);
    }

    await client.query('COMMIT');

    // 5. Award XP: +10 base, +5 bonus for sessions >= 1 hour
    let xpAwarded = 10;
    if (duration_seconds >= 3600) xpAwarded += 5;
    await awardXP(userId, xpAwarded);

    // 6. Clear active timer from DB (session is now logged)
    await db.query(
      `UPDATE clover_users 
       SET active_timer_mode = NULL, active_timer_time_left = NULL, 
           active_timer_stopwatch_seconds = NULL, active_timer_custom_minutes = NULL,
           active_timer_started_at = NULL
       WHERE id = $1`,
      [userId]
    );

    // 7. Fetch updated XP
    const xpRes = await db.query('SELECT xp_points FROM clover_users WHERE id = $1', [userId]);
    const totalXP = xpRes.rows[0]?.xp_points || 0;

    let updatedAttendance = attendance;
    try {
      const { recalculateAttendance } = require('./attendanceController');
      await recalculateAttendance(userId, today);
      const attFetch = await db.query(
        'SELECT * FROM clover_attendance WHERE user_id = $1 AND date = $2',
        [userId, today]
      );
      if (attFetch.rows.length > 0) updatedAttendance = attFetch.rows[0];
    } catch (attErr) {
      console.error('Error recalculating attendance after session log:', attErr.message);
    }

    res.status(201).json({
      message: 'Study session logged successfully!',
      session,
      attendance: updatedAttendance,
      badgesUnlocked,
      xpAwarded,
      totalXP
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

// ─── Active Timer Persistence (save/get/clear) ────────────────────────────────
exports.saveActiveTimer = async (req, res) => {
  const userId = req.user.id;
  const { mode, time_left, stopwatch_seconds, custom_minutes } = req.body;
  try {
    await db.query(
      `UPDATE clover_users 
       SET active_timer_mode = $1,
           active_timer_time_left = $2,
           active_timer_stopwatch_seconds = $3,
           active_timer_custom_minutes = $4,
           active_timer_started_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [mode || null, time_left ?? null, stopwatch_seconds ?? null, custom_minutes ?? null, userId]
    );
    res.json({ message: 'Active timer saved' });
  } catch (err) {
    console.error('Save Active Timer Error:', err.message);
    res.status(500).json({ message: 'Server error saving timer state' });
  }
};

exports.getActiveTimer = async (req, res) => {
  const userId = req.user.id;
  try {
    const result = await db.query(
      `SELECT active_timer_mode, active_timer_time_left, active_timer_stopwatch_seconds, 
              active_timer_custom_minutes, active_timer_started_at
       FROM clover_users WHERE id = $1`,
      [userId]
    );
    if (result.rows.length === 0 || !result.rows[0].active_timer_mode) {
      return res.json({ active: false });
    }
    const row = result.rows[0];

    // Compute elapsed time since last save so the client gets accurate remaining time
    let timeLeft = row.active_timer_time_left;
    let stopwatchSeconds = row.active_timer_stopwatch_seconds || 0;
    const startedAt = row.active_timer_started_at;

    if (startedAt) {
      const elapsedSeconds = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
      if (row.active_timer_mode === 'stopwatch') {
        stopwatchSeconds += elapsedSeconds;
      } else if (timeLeft !== null) {
        timeLeft = Math.max(0, timeLeft - elapsedSeconds);
      }
    }

    res.json({
      active: true,
      mode: row.active_timer_mode,
      time_left: timeLeft,
      stopwatch_seconds: stopwatchSeconds,
      custom_minutes: row.active_timer_custom_minutes,
      saved_at: startedAt
    });
  } catch (err) {
    console.error('Get Active Timer Error:', err.message);
    res.status(500).json({ message: 'Server error fetching timer state' });
  }
};

exports.clearActiveTimer = async (req, res) => {
  const userId = req.user.id;
  try {
    await db.query(
      `UPDATE clover_users 
       SET active_timer_mode = NULL, active_timer_time_left = NULL, 
           active_timer_stopwatch_seconds = NULL, active_timer_custom_minutes = NULL,
           active_timer_started_at = NULL
       WHERE id = $1`,
      [userId]
    );
    res.json({ message: 'Active timer cleared' });
  } catch (err) {
    console.error('Clear Active Timer Error:', err.message);
    res.status(500).json({ message: 'Server error clearing timer state' });
  }
};

exports.getAnalytics = async (req, res) => {
  const userId = req.user.id;
  const localDateObj = new Date();
  const today = `${localDateObj.getFullYear()}-${String(localDateObj.getMonth() + 1).padStart(2, '0')}-${String(localDateObj.getDate()).padStart(2, '0')}`;

  try {
    const todayRes = await db.query(
      "SELECT SUM(duration_seconds) as sum FROM clover_focus_sessions WHERE user_id = $1 AND completed_at::date = $2",
      [userId, today]
    );
    const todayFocusSeconds = parseInt(todayRes.rows[0].sum || '0');

    const weekRes = await db.query(
      "SELECT SUM(duration_seconds) as sum FROM clover_focus_sessions WHERE user_id = $1 AND completed_at >= NOW() - INTERVAL '7 days'",
      [userId]
    );
    const weekFocusHours = Number((parseInt(weekRes.rows[0].sum || '0') / 3600).toFixed(2));

    const longestRes = await db.query(
      "SELECT MAX(duration_seconds) as max FROM clover_focus_sessions WHERE user_id = $1",
      [userId]
    );
    const longestSessionSeconds = parseInt(longestRes.rows[0].max || '0');

    let todayStatus = 'Absent';
    const attRes = await db.query(
      'SELECT status FROM clover_attendance WHERE user_id = $1 AND date = $2',
      [userId, today]
    );
    if (attRes.rows.length > 0) todayStatus = attRes.rows[0].status;

    const todosTodayRes = await db.query(
      'SELECT COUNT(*) as total, COUNT(CASE WHEN is_completed = true THEN 1 END) as completed FROM clover_todos WHERE user_id = $1 AND due_date = $2',
      [userId, today]
    );
    const todosTotalToday = parseInt(todosTodayRes.rows[0].total || '0');
    const todosCompletedToday = parseInt(todosTodayRes.rows[0].completed || '0');

    const { getTodayCommitsCount } = require('./githubController');
    const todayCommits = await getTodayCommitsCount(userId);

    let attendancePts = 0;
    if (todayStatus === 'Present') attendancePts = 30;
    else if (todayStatus === 'Half Day') attendancePts = 15;

    const focusPts = Math.min(25, (todayFocusSeconds / 7200) * 25);

    let todoPts = 0;
    if (todosTotalToday > 0) todoPts = (todosCompletedToday / todosTotalToday) * 25;

    let githubPts = 0;
    if (todayCommits >= 3) githubPts = 20;
    else if (todayCommits === 2) githubPts = 14;
    else if (todayCommits === 1) githubPts = 8;

    const productivityScore = Math.round(attendancePts + focusPts + todoPts + githubPts);

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
