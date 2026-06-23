const express = require('express');
const router = express.Router();
const timerController = require('../controllers/timerController');
const auth = require('../middleware/auth');

// @route   POST api/timer/session
// @desc    Log a completed focus study session (awards XP + clears active timer)
router.post('/session', auth, timerController.logSession);

// @route   GET api/timer/sessions
// @desc    Get user's focus study session logs
router.get('/sessions', auth, timerController.getSessions);

// @route   GET api/timer/analytics
// @desc    Get focus session metrics & chart data
router.get('/analytics', auth, timerController.getAnalytics);

// @route   POST api/timer/active
// @desc    Save running timer state to DB (called every 30s while timer is running)
router.post('/active', auth, timerController.saveActiveTimer);

// @route   GET api/timer/active
// @desc    Get persisted active timer state (used on page load to restore timer)
router.get('/active', auth, timerController.getActiveTimer);

// @route   DELETE api/timer/active
// @desc    Clear active timer state (called when timer is reset or session is logged)
router.delete('/active', auth, timerController.clearActiveTimer);

module.exports = router;
