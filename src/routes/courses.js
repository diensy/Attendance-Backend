const express = require('express');
const router = express.Router();
const coursesController = require('../controllers/coursesController');
const auth = require('../middleware/auth');

// All routes are protected by JWT auth
router.use(auth);

// Import a new playlist
router.post('/import', coursesController.importPlaylist);

// Get user's imported courses
router.get('/', coursesController.getCourses);

// Get roadmaps with their items
router.get('/roadmaps', coursesController.getRoadmaps);
router.post('/roadmaps', coursesController.createRoadmap);
router.post('/roadmaps/generate', coursesController.generateRoadmapWithAI);
router.delete('/roadmaps/:id', coursesController.deleteRoadmap);
router.post('/roadmaps/items', coursesController.createRoadmapItem);
router.delete('/roadmaps/items/:id', coursesController.deleteRoadmapItem);
router.post('/roadmaps/items/:id/toggle', coursesController.toggleRoadmapItem);

// Get details of a single course including videos and progress
router.get('/:id', coursesController.getCourseDetails);

// Delete an imported course
router.delete('/:id', coursesController.deleteCourse);

// Update/Save progress and notes for a specific video
router.post('/videos/:id/progress', coursesController.updateVideoProgress);

// Complete a video and trigger attendance, todo, and roadmap completions
router.post('/videos/:id/complete', coursesController.completeVideo);

module.exports = router;
