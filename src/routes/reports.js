const express = require('express');
const router = express.Router();
const reportsController = require('../controllers/reportsController');
const auth = require('../middleware/auth');

// @route   GET api/reports/pdf
// @desc    Download weekly/monthly PDF report
router.get('/pdf', auth, reportsController.exportPDF);

// @route   GET api/reports/excel
// @desc    Download Excel sheet of attendance logs
router.get('/excel', auth, reportsController.exportExcel);

module.exports = router;
