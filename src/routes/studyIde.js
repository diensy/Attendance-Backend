const express = require('express');
const router = express.Router();
const studyIdeController = require('../controllers/studyIdeController');
const auth = require('../middleware/auth');

router.use(auth);

// Get list of all subjects and topics for current user
router.get('/subjects', studyIdeController.getSubjectsAndTopics);

// Get tasks for a specific subject and topic
router.get('/tasks', studyIdeController.getTasksForTopic);

// Generate new challenges or retrieve existing ones
router.post('/generate', studyIdeController.generateOrGetTasks);

// Save user code for a task
router.post('/tasks/:id/save', studyIdeController.saveTaskCode);

// Mark task as completed and save final code
router.post('/tasks/:id/complete', studyIdeController.completeTask);

module.exports = router;
