const express = require('express');
const router = express.Router();
const githubController = require('../controllers/githubController');
const auth = require('../middleware/auth');

// @route   GET api/github
// @desc    Sync and fetch user's repositories and commit events
router.get('/', auth, githubController.getGitHubData);

module.exports = router;
