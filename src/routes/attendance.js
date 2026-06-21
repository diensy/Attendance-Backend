const express = require('express');
const router = express.Router();
const attendanceController = require('../controllers/attendanceController');
const auth = require('../middleware/auth');

// @route   GET api/attendance/logs
// @desc    Get user's attendance logs
router.get('/logs', auth, attendanceController.getLogs);

// @route   POST api/attendance/manual
// @desc    Log manual study attendance or override notes
router.post('/manual', auth, attendanceController.logManualAttendance);

// @route   GET api/attendance/stats
// @desc    Get study metrics, streaks, and achievements
router.get('/stats', auth, attendanceController.getStats);

module.exports = router;
