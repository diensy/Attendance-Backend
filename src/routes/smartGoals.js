const express = require('express');
const router = express.Router();
const smartGoalsController = require('../controllers/smartGoalsController');
const auth = require('../middleware/auth');

router.use(auth);

// Get today's smart goals
router.get('/', smartGoalsController.getSmartGoals);

// Heartbeat ping
router.post('/heartbeat', smartGoalsController.smartGoalHeartbeat);

// Create a new smart goal
router.post('/', smartGoalsController.createSmartGoal);

// Mark a goal as interrupted
router.post('/:id/interrupt', smartGoalsController.interruptSmartGoal);

// Mark a goal as completed
router.post('/:id/complete', smartGoalsController.completeSmartGoal);

// Save quit reason
router.post('/:id/quit-reason', smartGoalsController.saveQuitReason);

// Handle Early Logout
router.post('/logout', smartGoalsController.handleEarlyLogout);

module.exports = router;
