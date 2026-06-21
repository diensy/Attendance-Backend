const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');
const auth = require('../middleware/auth');

// @route   POST api/ai/analyze-notes
// @desc    Analyze study notes and suggest learning strategies
router.post('/analyze-notes', auth, aiController.analyzeNotes);

// @route   POST api/ai/daily-summary
// @desc    Synthesize today's sessions and notes into a saved attendance AI summary
router.post('/daily-summary', auth, aiController.generateDailySummary);

// @route   POST api/ai/email-insights
// @desc    Send study notes and AI report to user's email
router.post('/email-insights', auth, aiController.emailInsights);
// @route   GET api/ai/preferences
// @desc    Get user preferences for AI Coach
router.get('/preferences', auth, aiController.getPreferences);

// @route   POST api/ai/preferences
// @desc    Save user preferences for AI Coach
router.post('/preferences', auth, aiController.savePreferences);

// @route   POST api/ai/coach/chat
// @desc    Chat with AI Coach, providing full context
router.post('/coach/chat', auth, aiController.chatWithCoach);

// @route   POST api/ai/generate-coding-tasks
// @desc    Generate interactive coding tasks for a specific topic
router.post('/generate-coding-tasks', auth, aiController.generateCodingTasks);

module.exports = router;
