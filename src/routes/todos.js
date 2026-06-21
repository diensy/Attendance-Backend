const express = require('express');
const router = express.Router();
const todosController = require('../controllers/todosController');
const auth = require('../middleware/auth');

// All routes here are protected by JWT auth
router.use(auth);

router.get('/', todosController.getTodos);
router.post('/', todosController.createTodo);
router.put('/:id', todosController.updateTodo);
router.delete('/:id', todosController.deleteTodo);

module.exports = router;
