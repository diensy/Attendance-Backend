const express = require('express');
const router = express.Router();
const goalsController = require('../controllers/goalsController');
const auth = require('../middleware/auth');

// All routes here are protected by JWT auth
router.use(auth);

router.get('/', goalsController.getGoals);
router.post('/', goalsController.createGoal);
router.put('/:id', goalsController.updateGoal);
router.delete('/:id', goalsController.deleteGoal);
router.post('/trigger-reminders', goalsController.triggerReminders);

module.exports = router;
