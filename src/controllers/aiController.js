const db = require('../db');
const { OpenAI } = require('openai');

// Initialize OpenAI client if key is configured
const getOpenAIClient = () => {
  if (process.env.OPENAI_API_KEY) {
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return null;
};

// Local Rule-Based NLP Parser for Topic Detection and Summary Generation
const generateLocalAnalysis = (notesText, topicsArray = []) => {
  const notes = notesText.toLowerCase();
  const detected = new Set(topicsArray);

  // Topic keywords dictionaries
  const dict = {
    'Node.js': ['node', 'express', 'javascript', 'js', 'jwt', 'npm', 'backend', 'api', 'cors', 'middleware', 'database', 'pg', 'postgresql'],
    'Python': ['python', 'py', 'django', 'flask', 'pandas', 'numpy', 'pip', 'scripting'],
    'DSA': ['dsa', 'leetcode', 'array', 'string', 'linked list', 'binary tree', 'sorting', 'searching', 'graph', 'recursion', 'complexity', 'o(n)', 'stack', 'queue'],
    'AI/Data Science': ['ai', 'machine learning', 'ml', 'deep learning', 'neural', 'regression', 'classification', 'tensor', 'pytorch', 'scikit', 'model', 'training', 'nlp', 'data science']
  };

  // Run keyword scanning
  for (const [subject, keywords] of Object.entries(dict)) {
    for (const word of keywords) {
      if (notes.includes(word)) {
        detected.add(subject);
        break;
      }
    }
  }

  // Ensure we fall back to general if nothing matched
  if (detected.size === 0) {
    detected.add('General Study');
  }

  const detectedList = Array.from(detected);

  // Dynamic summary templates
  let summary = `You focused on **${detectedList.join(', ')}** during today's study. `;
  if (notesText && notesText.trim().length > 10) {
    summary += `Your study notes indicated: "${notesText.trim().substring(0, 120)}${notesText.length > 120 ? '...' : ''}". `;
  } else {
    summary += `Logged standard study sessions. `;
  }

  // Construct recommendations
  let insights = '';
  if (detected.has('Node.js')) {
    insights += '💡 **Backend Tip**: Make sure to implement proper error handling middleware and validation filters in your Express controllers. Validate your PostgreSQL connection pool limits.\n';
  }
  if (detected.has('Python')) {
    insights += '💡 **Python Tip**: Remember to structure virtual environments (`venv`) and track package versions inside a `requirements.txt` file.\n';
  }
  if (detected.has('DSA')) {
    insights += '💡 **DSA Tip**: Try working through time and space complexities (Big O notation) for each algorithm you solve. Practice both recursive and iterative styles.\n';
  }
  if (detected.has('AI/Data Science')) {
    insights += '💡 **AI Tip**: Always split datasets into training, validation, and test subsets to check for model overfitting or bias issues.\n';
  }
  if (insights === '') {
    insights += '💡 **Study Tip**: Keep up the great pace! Reviewing your notes weekly is a proven way to increase memory retention and lock in knowledge.\n';
  }

  // Structured recommendations
  const dynamicReport = `### 🍀 Study Insight Report
${summary}

#### 📋 Topics Detected
${detectedList.map(tag => `- \`${tag}\``).join('\n')}

#### 🚀 Learning Strategies
${insights}
*Consistency is the key to progress. Let Code Clover guide your growth!*`;

  return {
    topics: detectedList,
    summaryText: summary,
    reportMarkdown: dynamicReport
  };
};

exports.analyzeNotes = async (req, res) => {
  const { notes, topics } = req.body;
  
  if (!notes) {
    return res.status(400).json({ message: 'No notes content provided' });
  }

  const openai = getOpenAIClient();

  try {
    if (openai) {
      // Call OpenAI API
      const prompt = `You are Code Clover's AI mentor. Analyze this student's study notes and topics covered today.
Notes: "${notes}"
Selected Topics: "${(topics || []).join(', ')}"

Provide a concise JSON response containing:
1. "detected_topics": array of primary subjects (e.g. Node.js, Python, DSA, AI/Data Science, etc.)
2. "summary_text": a 2-sentence summary of what they learned.
3. "report_markdown": a beautiful Markdown formatted summary containing a motivational review, study highlights, and one actionable, highly specific learning tip based on their notes.`;

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' }
      });

      const data = JSON.parse(response.choices[0].message.content);
      return res.json({
        topics: data.detected_topics,
        summaryText: data.summary_text,
        reportMarkdown: data.report_markdown,
        isAIReal: true
      });
    }

    // Call Local parser
    const analysis = generateLocalAnalysis(notes, topics);
    res.json({
      topics: analysis.topics,
      summaryText: analysis.summaryText,
      reportMarkdown: analysis.reportMarkdown,
      isAIReal: false
    });

  } catch (err) {
    console.error('AI Analyze Error:', err.message);
    // Graceful fallback
    const analysis = generateLocalAnalysis(notes, topics);
    res.json({
      topics: analysis.topics,
      summaryText: analysis.summaryText,
      reportMarkdown: analysis.reportMarkdown,
      isAIReal: false
    });
  }
};

exports.generateDailySummary = async (req, res) => {
  const userId = req.user.id;
  const localDateObj = new Date();
  const today = `${localDateObj.getFullYear()}-${String(localDateObj.getMonth() + 1).padStart(2, '0')}-${String(localDateObj.getDate()).padStart(2, '0')}`;

  try {
    // 1. Fetch focus sessions for today
    const sessions = await db.query(
      "SELECT * FROM clover_focus_sessions WHERE user_id = $1 AND completed_at::date = $2",
      [userId, today]
    );

    // 2. Fetch daily attendance
    const attendanceRes = await db.query(
      "SELECT * FROM clover_attendance WHERE user_id = $1 AND date = $2",
      [userId, today]
    );

    if (attendanceRes.rows.length === 0) {
      return res.status(404).json({ message: 'No attendance record found for today yet. Start a study session first!' });
    }

    const attendance = attendanceRes.rows[0];
    const studyHours = Number(attendance.study_hours);

    // Combine notes
    let notesText = attendance.daily_notes || '';
    const topics = [];
    
    sessions.rows.forEach(session => {
      if (session.notes) notesText += ` ${session.notes}`;
      if (session.topics) topics.push(...session.topics);
    });

    // A. Fetch completed and total todos due today
    const todosTodayRes = await db.query(
      'SELECT COUNT(*) as total, COUNT(CASE WHEN is_completed = true THEN 1 END) as completed, string_agg(title, \', \') as titles FROM clover_todos WHERE user_id = $1 AND due_date = $2',
      [userId, today]
    );
    const todosTotalToday = parseInt(todosTodayRes.rows[0].total || '0');
    const todosCompletedToday = parseInt(todosTodayRes.rows[0].completed || '0');
    const todoTitles = todosTodayRes.rows[0].titles || '';

    // B. Fetch GitHub commits today
    const { getTodayCommitsCount } = require('./githubController');
    const todayCommits = await getTodayCommitsCount(userId);

    // C. Fetch focus seconds for today
    const todayFocusRes = await db.query(
      'SELECT COALESCE(SUM(duration_seconds), 0) as sum FROM clover_focus_sessions WHERE user_id = $1 AND completed_at::date = $2',
      [userId, today]
    );
    const todayFocusSeconds = parseInt(todayFocusRes.rows[0].sum || '0');

    // D. Compute Productivity Score
    let attendancePts = 0;
    if (attendance.status === 'Present') attendancePts = 30;
    else if (attendance.status === 'Half Day') attendancePts = 15;

    const focusPts = Math.min(25, (todayFocusSeconds / 7200) * 25);

    let todoPts = 25;
    if (todosTotalToday > 0) {
      todoPts = (todosCompletedToday / todosTotalToday) * 25;
    }

    let githubPts = 0;
    if (todayCommits >= 3) githubPts = 20;
    else if (todayCommits === 2) githubPts = 14;
    else if (todayCommits === 1) githubPts = 8;

    const productivityScore = Math.round(attendancePts + focusPts + todoPts + githubPts);

    const openai = getOpenAIClient();
    let summaryText = '';

    if (openai) {
      const prompt = `You are Code Clover's Study OS AI assistant. Generate a structured Daily Study Summary in markdown format.

Today's Statistics:
- Study Time: ${studyHours} hours
- Attendance: ${attendance.status}
- Completed Todos: ${todosCompletedToday} out of ${todosTotalToday} (Tasks: ${todoTitles || 'None'})
- GitHub Commits: ${todayCommits}
- Productivity Score: ${productivityScore}%
- Topics Covered: ${topics.join(', ') || 'None'}
- Notes Taken: "${notesText}"

Please format your response EXACTLY in the following markdown layout, analyzing the notes and topics to suggest "Tomorrow's Focus":

### Daily Summary

- **Study Time**: ${studyHours}h
- **Topics Learned**:
${topics.length > 0 ? Array.from(new Set(topics)).map(t => `  - ${t}`).join('\n') : '  - None logged'}

- **Todos Completed**: ${todosCompletedToday}/${todosTotalToday}
- **Attendance**: ${attendance.status}
- **Productivity Score**: ${productivityScore}%

**Tomorrow's Focus**:
- [Suggest 1st focus area based on today's study, notes, or incomplete tasks]
- [Suggest 2nd focus area based on today's study, notes, or incomplete tasks]`;

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }]
      });
      summaryText = response.choices[0].message.content.trim();
    } else {
      // Local programmatic markdown generation
      let tomorrowSuggestions = [];
      const topicsList = Array.from(new Set(topics));
      if (topicsList.includes('Node.js')) {
        tomorrowSuggestions = ['Refresh Tokens', 'Express Route Testing'];
      } else if (topicsList.includes('Python')) {
        tomorrowSuggestions = ['Python OOP', 'Pandas Dataframes'];
      } else if (topicsList.includes('DSA')) {
        tomorrowSuggestions = ['Stack & Queue Problems', 'Recursion & Backtracking'];
      } else if (topicsList.includes('AI/Data Science')) {
        tomorrowSuggestions = ['Model Fine-Tuning', 'NLP Embeddings'];
      } else {
        tomorrowSuggestions = ['Next Roadmap Chapter', 'Review Today\'s Notes'];
      }

      summaryText = `### Daily Summary

- **Study Time**: ${studyHours}h
- **Topics Learned**:
${topicsList.length > 0 ? topicsList.map(t => `  - ${t}`).join('\n') : '  - None logged'}

- **Todos Completed**: ${todosCompletedToday}/${todosTotalToday}
- **Attendance**: ${attendance.status}
- **Productivity Score**: ${productivityScore}%

**Tomorrow's Focus**:
- ${tomorrowSuggestions[0]}
- ${tomorrowSuggestions[1]}`;
    }

    // 3. Update the attendance record with the AI summary
    const updated = await db.query(
      'UPDATE clover_attendance SET ai_summary = $1 WHERE id = $2 RETURNING *',
      [summaryText, attendance.id]
    );

    res.json({
      message: 'Daily AI summary generated and saved successfully!',
      attendance: updated.rows[0]
    });

  } catch (err) {
    console.error('AI Daily Summary Error:', err.message);
    res.status(500).json({ message: 'Server error generating daily summary' });
  }
};

exports.emailInsights = async (req, res) => {
  const userId = req.user.id;
  const { notes, reportMarkdown } = req.body;

  if (!reportMarkdown) {
    return res.status(400).json({ message: 'No insights report provided to email.' });
  }

  try {
    const userRes = await db.query(
      'SELECT username, email FROM clover_users WHERE id = $1',
      [userId]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = userRes.rows[0];
    const mailer = require('../utils/mailer');

    const mailResult = await mailer.sendStudyPlanEmail(
      user.email,
      user.username,
      notes || '',
      reportMarkdown
    );

    if (mailResult && mailResult.error) {
      return res.status(500).json({ 
        message: 'Could not transmit email. Check server log SMTP configurations.',
        error: mailResult.error
      });
    }

    res.json({ 
      message: 'Study plan and AI insights report successfully emailed!',
      devFallback: !!mailResult?.devFallback
    });

  } catch (err) {
    console.error('AI Email Insights Error:', err.message);
    res.status(500).json({ message: 'Server error emailing study plan insights' });
  }
};// ─── AI Coach & Preferences ────────────────────────────────────────────────────

exports.getPreferences = async (req, res) => {
  try {
    const userId = req.user.id;
    const prefRes = await db.query('SELECT * FROM clover_user_preferences WHERE user_id = $1', [userId]);
    
    if (prefRes.rows.length === 0) {
      // Return defaults
      return res.json({
        preferred_study_time: 'Night',
        daily_hours: 2.0,
        office_time_start: '10:00:00',
        office_time_end: '19:00:00',
        career_goal: 'Backend Developer'
      });
    }
    
    res.json(prefRes.rows[0]);
  } catch (err) {
    console.error('Get preferences error:', err.message);
    res.status(500).json({ message: 'Server error retrieving preferences' });
  }
};

exports.savePreferences = async (req, res) => {
  try {
    const userId = req.user.id;
    const { preferred_study_time, daily_hours, office_time_start, office_time_end, career_goal } = req.body;
    
    const upsertQuery = `
      INSERT INTO clover_user_preferences (user_id, preferred_study_time, daily_hours, office_time_start, office_time_end, career_goal, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id) 
      DO UPDATE SET 
        preferred_study_time = EXCLUDED.preferred_study_time,
        daily_hours = EXCLUDED.daily_hours,
        office_time_start = EXCLUDED.office_time_start,
        office_time_end = EXCLUDED.office_time_end,
        career_goal = EXCLUDED.career_goal,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *;
    `;
    
    const result = await db.query(upsertQuery, [
      userId, 
      preferred_study_time || 'Night', 
      daily_hours || 2.0, 
      office_time_start || '10:00:00', 
      office_time_end || '19:00:00', 
      career_goal || 'Backend Developer'
    ]);
    
    res.json({ message: 'Preferences saved!', preferences: result.rows[0] });
  } catch (err) {
    console.error('Save preferences error:', err.message);
    res.status(500).json({ message: 'Server error saving preferences' });
  }
};

exports.chatWithCoach = async (req, res) => {
  try {
    const userId = req.user.id;
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ message: 'Chat prompt cannot be empty.' });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ message: 'OpenAI API key is missing on the server.' });
    }

    // Gather Full Context
    // 1. Preferences
    let prefs = { preferred_study_time: 'Night', daily_hours: 2, office_time_start: '10:00', office_time_end: '19:00', career_goal: 'Software Engineer' };
    const prefRes = await db.query('SELECT * FROM clover_user_preferences WHERE user_id = $1', [userId]);
    if (prefRes.rows.length > 0) prefs = prefRes.rows[0];

    // 2. Active Goals (if table exists yet, else skip)
    let activeGoals = [];
    try {
      const goalsRes = await db.query("SELECT title, category, target_hours, current_hours FROM clover_goals WHERE user_id = $1 AND is_completed = false LIMIT 3", [userId]);
      activeGoals = goalsRes.rows;
    } catch(e) {} // Ignore if phase 3 table not init yet

    // 3. Recent Attendance
    const todayStr = new Date().toISOString().split('T')[0];
    let todayStudyHours = 0;
    const attRes = await db.query('SELECT study_hours FROM clover_attendance WHERE user_id = $1 AND date = $2', [userId, todayStr]);
    if (attRes.rows.length > 0) todayStudyHours = attRes.rows[0].study_hours;

    // 4. Pending Todos
    const todosRes = await db.query('SELECT title, priority FROM clover_todos WHERE user_id = $1 AND is_completed = false LIMIT 5', [userId]);
    const todos = todosRes.rows;

    const openai = new OpenAI({ apiKey });

    const systemMessage = `
You are Code Clover 🍀, a brilliant, personalized AI Study Coach for the user.
Your personality is encouraging, practical, and highly structured.
You MUST provide actionable, time-boxed schedules when the user asks for a plan.
Format your responses using clean Markdown. Use emojis appropriately.

Here is the user's current context:
- Career Goal: ${prefs.career_goal}
- Preferred Study Time: ${prefs.preferred_study_time}
- Target Daily Study Hours: ${prefs.daily_hours} hrs
- Work/Office Hours: ${prefs.office_time_start} to ${prefs.office_time_end}
- Hours studied today so far: ${todayStudyHours} hrs
- Active Long-term Goals: ${activeGoals.length > 0 ? JSON.stringify(activeGoals) : 'None currently set'}
- Top Pending Todos: ${todos.length > 0 ? JSON.stringify(todos) : 'None currently pending'}

When generating plans (like "Plan My Day"):
- Factor in their office hours (don't schedule study during office hours).
- Factor in their preferred study time (Morning, Afternoon, Night).
- Factor in their career goal and pending todos.
- Provide a concrete timeline (e.g. 8:00 PM - 9:00 PM: [Task]).
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: prompt }
      ],
      temperature: 0.7,
    });

    const aiMessage = response.choices[0].message.content.trim();

    // Optionally save to chat history
    try {
      await db.query('INSERT INTO clover_chat_history (user_id, role, content) VALUES ($1, $2, $3)', [userId, 'user', prompt]);
      await db.query('INSERT INTO clover_chat_history (user_id, role, content) VALUES ($1, $2, $3)', [userId, 'assistant', aiMessage]);
    } catch(e) {} // ignore if optional table missing

    res.json({ reply: aiMessage });
  } catch (err) {
    console.error('AI Coach Chat Error:', err.message);
    res.status(500).json({ message: 'Error communicating with AI coach' });
  }
};

exports.generateCodingTasks = async (req, res) => {
  const { topic, count = 10 } = req.body;
  if (!topic) {
    return res.status(400).json({ message: 'Topic is required' });
  }

  const openai = getOpenAIClient();
  if (!openai) {
    return res.status(503).json({ message: 'OpenAI client not configured' });
  }

  try {
    const prompt = `You are an expert programming instructor. Generate exactly ${count} progressive coding challenges for the topic: "${topic}".
Since these will be executed in a pure JS browser environment via new Function(), do NOT ask the user to spin up an actual HTTP server or use 'require()'. Instead, ask them to write pure functions that *simulate* or represent concepts (e.g. write an Express middleware function 'function logger(req, res, next)', write a routing logic function, etc.).

Return the response STRICTLY as a JSON object with a single key 'tasks' containing an array of exactly ${count} objects.
Each object must have:
- title: A short descriptive title
- description: Instructions for the task
- starterCode: The JavaScript boilerplate for the user to start with
- testCode: Hidden JavaScript code that will be appended to the user's code to test it. This code must call the user's function and throw an Error if the logic is incorrect. If it passes, it should do nothing.

Example format:
{
  "tasks": [
    {
      "title": "Basic Express Middleware",
      "description": "Write a middleware function named 'addTimestamp' that adds a 'timestamp' property to the 'req' object.",
      "starterCode": "function addTimestamp(req, res, next) {\\n  // your code here\\n}",
      "testCode": "const req = {}; let nextCalled = false; const next = () => { nextCalled = true }; addTimestamp(req, {}, next); if (!req.timestamp) throw new Error('timestamp not added'); if (!nextCalled) throw new Error('next() not called');"
    }
  ]
}

DO NOT include markdown formatting or backticks around the JSON. ONLY output the raw JSON object.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "system", content: prompt }],
      temperature: 0.7,
      response_format: { type: "json_object" }
    });

    const aiResponse = completion.choices[0].message.content;
    const parsedTasks = JSON.parse(aiResponse);

    res.json(parsedTasks);
  } catch (err) {
    console.error('Error generating coding tasks:', err.message);
    res.status(500).json({ message: 'Failed to generate coding tasks' });
  }
};
