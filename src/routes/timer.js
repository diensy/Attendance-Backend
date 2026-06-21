const express = require('express');
const router = express.Router();
const timerController = require('../controllers/timerController');
const auth = require('../middleware/auth');

// @route   POST api/timer/session
// @desc    Log a completed focus study session
router.post('/session', auth, timerController.logSession);

// @route   GET api/timer/sessions
// @desc    Get user's focus study sessions logs
router.get('/sessions', auth, timerController.getSessions);

// @route   GET api/timer/analytics
// @desc    Get focus session metrics & chart data
router.get('/analytics', auth, timerController.getAnalytics);

module.exports = router;
