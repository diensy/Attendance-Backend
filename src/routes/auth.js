const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const auth = require('../middleware/auth');
const db = require('../db');

// @route   POST api/auth/register
// @desc    Register user
router.post('/register', authController.register);

// @route   POST api/auth/login
// @desc    Authenticate user & get token
router.post('/login', authController.login);

// @route   POST api/auth/verify
// @desc    Verify email address using 6 digit code
router.post('/verify', authController.verifyEmail);

// @route   POST api/auth/resend-verification
// @desc    Resend confirmation code
router.post('/resend-verification', authController.resendVerification);

// @route   PUT api/auth/profile
// @desc    Update user profile details
router.put('/profile', auth, authController.updateProfile);

// @route   POST api/auth/profile/picture
// @desc    Upload profile picture
router.post('/profile/picture', auth, authController.uploadProfilePic);

// @route   POST api/auth/profile/security-question
// @desc    Set security question
router.post('/profile/security-question', auth, authController.updateSecurityQuestion);

// @route   POST api/auth/profile/change-password
// @desc    Change user password
router.post('/profile/change-password', auth, authController.changePassword);

// @route   POST api/auth/forgot-password/send-otp
// @desc    Send password reset OTP
router.post('/forgot-password/send-otp', authController.forgotPasswordSendOtp);

// @route   POST api/auth/forgot-password/verify-otp
// @desc    Verify reset OTP and change password
router.post('/forgot-password/verify-otp', authController.forgotPasswordVerifyOtp);

// @route   POST api/auth/forgot-password/question
// @desc    Retrieve security question for email
router.post('/forgot-password/question', authController.forgotPasswordGetQuestion);

// @route   POST api/auth/forgot-password/verify-question
// @desc    Verify security question answer and change password
router.post('/forgot-password/verify-question', authController.forgotPasswordVerifyQuestion);

// @route   GET api/auth/me
// @desc    Get user info
router.get('/me', auth, async (req, res) => {
  try {
    const authController = require('../controllers/authController');
    const loginBonusAwarded = await authController.checkAndAwardDailyBonus(req.user.id);

    const user = await db.query(
      'SELECT id, username, email, github_username, is_verified, profile_pic_url, security_question, xp_points, created_at FROM clover_users WHERE id = $1',
      [req.user.id]
    );

    if (user.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const userData = {
      ...user.rows[0],
      loginBonusAwarded
    };
    res.json(userData);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;
