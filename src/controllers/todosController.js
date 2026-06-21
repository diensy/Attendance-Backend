const db = require('../db');
const { recalculateAttendance } = require('./attendanceController');

exports.getTodos = async (req, res) => {
  const userId = req.user.id;
  const { date } = req.query; // optional filter by due_date
  
  try {
    let queryStr = 'SELECT * FROM clover_todos WHERE user_id = $1';
    const params = [userId];
    
    if (date) {
      queryStr += ' AND due_date = $2';
      params.push(date);
    }
    
    queryStr += " ORDER BY CASE priority WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 WHEN 'Low' THEN 3 ELSE 4 END, created_at DESC";
    const result = await db.query(queryStr, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Get Todos Error:', err.message);
    res.status(500).json({ message: 'Server error retrieving tasks' });
  }
};

exports.createTodo = async (req, res) => {
  const userId = req.user.id;
  const { title, priority, category, due_date, is_recurring, recurrence_pattern } = req.body;

  if (!title) {
    return res.status(400).json({ message: 'Title is required' });
  }

  try {
    const formattedDueDate = due_date ? new Date(due_date) : new Date();
    const result = await db.query(
      `INSERT INTO clover_todos (user_id, title, priority, category, due_date, is_recurring, recurrence_pattern)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        userId,
        title.trim(),
        priority || 'Medium',
        category || 'General',
        formattedDueDate,
        is_recurring || false,
        recurrence_pattern || null
      ]
    );

    const newTodo = result.rows[0];

    // Trigger attendance status update
    const dateStr = new Date(newTodo.due_date).toISOString().split('T')[0];
    await recalculateAttendance(userId, dateStr);

    res.status(201).json(newTodo);
  } catch (err) {
    console.error('Create Todo Error:', err.message);
    res.status(500).json({ message: 'Server error creating task' });
  }
};

exports.updateTodo = async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;
  const { title, priority, category, due_date, is_completed, is_recurring, recurrence_pattern } = req.body;

  try {
    // Find original todo
    const checkRes = await db.query('SELECT * FROM clover_todos WHERE id = $1 AND user_id = $2', [id, userId]);
    if (checkRes.rows.length === 0) {
      return res.status(404).json({ message: 'Task not found or unauthorized' });
    }

    const original = checkRes.rows[0];

    const updatedTitle = title !== undefined ? title.trim() : original.title;
    const updatedPriority = priority !== undefined ? priority : original.priority;
    const updatedCategory = category !== undefined ? category : original.category;
    const updatedDueDate = due_date !== undefined ? new Date(due_date) : new Date(original.due_date);
    const updatedIsCompleted = is_completed !== undefined ? is_completed : original.is_completed;
    const updatedIsRecurring = is_recurring !== undefined ? is_recurring : original.is_recurring;
    const updatedRecurrence = recurrence_pattern !== undefined ? recurrence_pattern : original.recurrence_pattern;

    let completedAt = original.completed_at;
    if (updatedIsCompleted && !original.is_completed) {
      completedAt = new Date();
    } else if (!updatedIsCompleted) {
      completedAt = null;
    }

    const result = await db.query(
      `UPDATE clover_todos 
       SET title = $1, priority = $2, category = $3, due_date = $4, is_completed = $5, completed_at = $6, is_recurring = $7, recurrence_pattern = $8
       WHERE id = $9 RETURNING *`,
      [
        updatedTitle,
        updatedPriority,
        updatedCategory,
        updatedDueDate,
        updatedIsCompleted,
        completedAt,
        updatedIsRecurring,
        updatedRecurrence,
        id
      ]
    );

    const updatedTodo = result.rows[0];

    // Handle daily/weekly recurrence cloning on complete transition
    if (updatedIsCompleted && !original.is_completed && updatedIsRecurring) {
      const nextDueDate = new Date(updatedDueDate);
      if (updatedRecurrence === 'Daily') {
        nextDueDate.setDate(nextDueDate.getDate() + 1);
      } else if (updatedRecurrence === 'Weekly') {
        nextDueDate.setDate(nextDueDate.getDate() + 7);
      } else {
        nextDueDate.setDate(nextDueDate.getDate() + 1);
      }

      await db.query(
        `INSERT INTO clover_todos (user_id, title, priority, category, due_date, is_recurring, recurrence_pattern)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          userId,
          updatedTitle,
          updatedPriority,
          updatedCategory,
          nextDueDate,
          true,
          updatedRecurrence
        ]
      );
    }

    // Recalculate attendance for the original date
    const origDateStr = new Date(original.due_date).toISOString().split('T')[0];
    await recalculateAttendance(userId, origDateStr);

    // Recalculate attendance for the new date (in case due_date was shifted)
    const newDateStr = new Date(updatedTodo.due_date).toISOString().split('T')[0];
    if (newDateStr !== origDateStr) {
      await recalculateAttendance(userId, newDateStr);
    }

    res.json(updatedTodo);
  } catch (err) {
    console.error('Update Todo Error:', err.message);
    res.status(500).json({ message: 'Server error updating task' });
  }
};

exports.deleteTodo = async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    const checkRes = await db.query('SELECT * FROM clover_todos WHERE id = $1 AND user_id = $2', [id, userId]);
    if (checkRes.rows.length === 0) {
      return res.status(404).json({ message: 'Task not found or unauthorized' });
    }

    const todo = checkRes.rows[0];
    await db.query('DELETE FROM clover_todos WHERE id = $1', [id]);

    // Recalculate attendance
    const dateStr = new Date(todo.due_date).toISOString().split('T')[0];
    await recalculateAttendance(userId, dateStr);

    res.json({ message: 'Task deleted successfully' });
  } catch (err) {
    console.error('Delete Todo Error:', err.message);
    res.status(500).json({ message: 'Server error deleting task' });
  }
};
