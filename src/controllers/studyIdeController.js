const db = require('../db');
const { OpenAI } = require('openai');

// Initialize OpenAI client if key is configured
const getOpenAIClient = () => {
  if (process.env.OPENAI_API_KEY) {
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return null;
};

exports.getSubjectsAndTopics = async (req, res) => {
  const userId = req.user.id;
  try {
    const result = await db.query(
      `SELECT subject, topic, 
              COUNT(*) as total_tasks, 
              SUM(CASE WHEN is_completed THEN 1 ELSE 0 END) as completed_tasks
       FROM clover_study_ide_tasks
       WHERE user_id = $1
       GROUP BY subject, topic
       ORDER BY subject, topic`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching subjects/topics:', err.message);
    res.status(500).json({ message: 'Server error retrieving subjects and topics' });
  }
};

exports.getTasksForTopic = async (req, res) => {
  const userId = req.user.id;
  const { subject, topic } = req.query;

  if (!subject || !topic) {
    return res.status(400).json({ message: 'Subject and Topic are required' });
  }

  try {
    const result = await db.query(
      `SELECT id, subject, topic, title, description, 
              starter_code as "starterCode", 
              test_code as "testCode", 
              user_code as "userCode", 
              is_completed as "isCompleted", 
              task_order as "taskOrder"
       FROM clover_study_ide_tasks
       WHERE user_id = $1 AND LOWER(subject) = LOWER($2) AND LOWER(topic) = LOWER($3)
       ORDER BY task_order ASC`,
      [userId, subject.trim(), topic.trim()]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching tasks for topic:', err.message);
    res.status(500).json({ message: 'Server error retrieving tasks' });
  }
};

exports.generateOrGetTasks = async (req, res) => {
  const userId = req.user.id;
  const { subject, topic } = req.body;

  if (!subject || !topic) {
    return res.status(400).json({ message: 'Subject and Topic are required' });
  }

  try {
    // 1. Check if tasks already exist in database
    const existing = await db.query(
      `SELECT id, subject, topic, title, description, 
              starter_code as "starterCode", 
              test_code as "testCode", 
              user_code as "userCode", 
              is_completed as "isCompleted", 
              task_order as "taskOrder"
       FROM clover_study_ide_tasks
       WHERE user_id = $1 AND LOWER(subject) = LOWER($2) AND LOWER(topic) = LOWER($3)
       ORDER BY task_order ASC`,
      [userId, subject.trim(), topic.trim()]
    );

    if (existing.rows.length > 0) {
      return res.json({ tasks: existing.rows });
    }

    // 2. Generate new tasks using OpenAI
    const openai = getOpenAIClient();
    if (!openai) {
      return res.status(503).json({ message: 'OpenAI client not configured' });
    }

    const prompt = `You are an expert programming instructor. Generate exactly 10 progressive coding challenges for the subject "${subject.trim()}" and topic: "${topic.trim()}".
Since these will be executed in a pure JS browser environment via new Function(), do NOT ask the user to spin up an actual HTTP server or use 'require()'. Instead, ask them to write pure functions that *simulate* or represent concepts (e.g. write an Express middleware function 'function logger(req, res, next)', write a routing logic function, etc.).

Return the response STRICTLY as a JSON object with a single key 'tasks' containing an array of exactly 10 objects.
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
    const parsed = JSON.parse(aiResponse);
    const generatedTasks = parsed.tasks;

    const savedTasks = [];
    for (let i = 0; i < generatedTasks.length; i++) {
      const task = generatedTasks[i];
      const insertRes = await db.query(
        `INSERT INTO clover_study_ide_tasks 
         (user_id, subject, topic, title, description, starter_code, test_code, task_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
         RETURNING id, subject, topic, title, description, 
                   starter_code as "starterCode", 
                   test_code as "testCode", 
                   user_code as "userCode", 
                   is_completed as "isCompleted", 
                   task_order as "taskOrder"`,
        [userId, subject.trim(), topic.trim(), task.title, task.description, task.starterCode, task.testCode, i]
      );
      savedTasks.push(insertRes.rows[0]);
    }

    res.json({ tasks: savedTasks });
  } catch (err) {
    console.error('Error generating study tasks:', err.message);
    res.status(500).json({ message: 'Failed to generate study tasks' });
  }
};

exports.saveTaskCode = async (req, res) => {
  const userId = req.user.id;
  const taskId = req.params.id;
  const { user_code } = req.body;

  try {
    const result = await db.query(
      `UPDATE clover_study_ide_tasks
       SET user_code = $1
       WHERE id = $2 AND user_id = $3
       RETURNING id, user_code as "userCode"`,
      [user_code, taskId, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Task not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error saving task code:', err.message);
    res.status(500).json({ message: 'Server error saving code' });
  }
};

exports.completeTask = async (req, res) => {
  const userId = req.user.id;
  const taskId = req.params.id;
  const { user_code } = req.body;

  try {
    const result = await db.query(
      `UPDATE clover_study_ide_tasks
       SET is_completed = true, completed_at = CURRENT_TIMESTAMP, user_code = COALESCE($1, user_code)
       WHERE id = $2 AND user_id = $3
       RETURNING id, is_completed as "isCompleted", user_code as "userCode"`,
      [user_code || null, taskId, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Task not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error completing task:', err.message);
    res.status(500).json({ message: 'Server error marking task complete' });
  }
};
