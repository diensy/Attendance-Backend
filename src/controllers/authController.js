const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const mailer = require('../utils/mailer');

const JWT_SECRET = process.env.JWT_SECRET || 'code_clover_secret_green_leaf_lucky_strike_9988';

// Helper to generate random 6 digit numeric code
const generateVerificationCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

exports.register = async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ message: 'Please enter all fields' });
  }

  try {
    // Check if user exists
    const userExists = await db.query(
      'SELECT * FROM clover_users WHERE username = $1 OR email = $2',
      [username.trim(), email.trim().toLowerCase()]
    );

    if (userExists.rows.length > 0) {
      return res.status(400).json({ message: 'User or Email already exists' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    // Generate verification code details
    const verification_code = generateVerificationCode();
    const verification_expires = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

    // Insert user
    const newUser = await db.query(
      `INSERT INTO clover_users (username, email, password_hash, is_verified, verification_code, verification_expires) 
       VALUES ($1, $2, $3, false, $4, $5) 
       RETURNING id, username, email, is_verified, profile_pic_url, security_question`,
      [username.trim(), email.trim().toLowerCase(), password_hash, verification_code, verification_expires]
    );

    const user = newUser.rows[0];

    // Seed initial achievement badge: "Clover Seed" 🍀
    try {
      await db.query(
        'INSERT INTO clover_achievements (user_id, badge_name, badge_description, icon) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [user.id, 'Clover Seed', 'Registered and planted the seed of consistency!', 'seed']
      );
    } catch (badgeErr) {
      console.error('Error seeding registration badge:', badgeErr.message);
    }

    // Send verification email via Nodemailer
    await mailer.sendVerificationEmail(user.email, verification_code);

    // Generate JWT token
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
      expiresIn: '7d',
    });

    res.status(201).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        github_username: null,
        is_verified: user.is_verified,
        profile_pic_url: null,
        security_question: null
      }
    });
  } catch (err) {
    console.error('Registration Error:', err.message);
    res.status(500).json({ message: 'Server error during registration' });
  }
};

exports.login = async (req, res) => {
  const { identifier, password } = req.body; // Can be username or email

  if (!identifier || !password) {
    return res.status(400).json({ message: 'Please enter all fields' });
  }

  try {
    // Find user
    const result = await db.query(
      'SELECT * FROM clover_users WHERE username = $1 OR email = $1',
      [identifier.trim()]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Check password
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Generate JWT token
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
      expiresIn: '7d',
    });

    // Check and award daily login bonus
    const loginBonusAwarded = await exports.checkAndAwardDailyBonus(user.id);
    
    // Fetch latest user data including updated xp_points
    const updatedUserRes = await db.query(
      'SELECT xp_points FROM clover_users WHERE id = $1',
      [user.id]
    );
    const xpPoints = updatedUserRes.rows[0]?.xp_points || 0;

    res.json({
      token,
      loginBonusAwarded,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        github_username: user.github_username,
        is_verified: user.is_verified,
        profile_pic_url: user.profile_pic_url,
        security_question: user.security_question,
        xp_points: xpPoints
      }
    });
  } catch (err) {
    console.error('Login Error:', err.message);
    res.status(500).json({ message: 'Server error during login' });
  }
};

exports.verifyEmail = async (req, res) => {
  const { email, code } = req.body;

  if (!email || !code) {
    return res.status(400).json({ message: 'Please provide email and verification code' });
  }

  try {
    const result = await db.query(
      'SELECT * FROM clover_users WHERE email = $1',
      [email.trim().toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = result.rows[0];

    if (user.is_verified) {
      return res.status(400).json({ message: 'Email is already verified' });
    }

    // Verify code and check expiration
    if (user.verification_code !== code.trim()) {
      return res.status(400).json({ message: 'Invalid verification code' });
    }

    const expiration = new Date(user.verification_expires);
    if (expiration < new Date()) {
      return res.status(400).json({ message: 'Verification code has expired. Please request a new one.' });
    }

    // Mark as verified
    await db.query(
      `UPDATE clover_users 
       SET is_verified = true, verification_code = null, verification_expires = null 
       WHERE id = $1`,
      [user.id]
    );

    res.json({
      message: 'Email verified successfully!',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        github_username: user.github_username,
        is_verified: true,
        profile_pic_url: user.profile_pic_url,
        security_question: user.security_question
      }
    });

  } catch (err) {
    console.error('Verify Email Error:', err.message);
    res.status(500).json({ message: 'Server error during verification' });
  }
};

exports.resendVerification = async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: 'Please provide email address' });
  }

  try {
    const result = await db.query(
      'SELECT id, username, email, is_verified FROM clover_users WHERE email = $1',
      [email.trim().toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = result.rows[0];

    if (user.is_verified) {
      return res.status(400).json({ message: 'Email is already verified' });
    }

    // Re-generate verification code details
    const verification_code = generateVerificationCode();
    const verification_expires = new Date(Date.now() + 15 * 60 * 1000);

    await db.query(
      'UPDATE clover_users SET verification_code = $1, verification_expires = $2 WHERE id = $3',
      [verification_code, verification_expires, user.id]
    );

    // Send verification email via Nodemailer
    await mailer.sendVerificationEmail(user.email, verification_code);

    res.json({ message: 'Verification code resent successfully!' });

  } catch (err) {
    console.error('Resend Verification Error:', err.message);
    res.status(500).json({ message: 'Server error resending verification code' });
  }
};

exports.updateProfile = async (req, res) => {
  const { github_username } = req.body;
  const userId = req.user.id;

  try {
    const usernameClean = github_username ? github_username.trim() : null;

    if (usernameClean) {
      // Validate that this username actually exists on GitHub
      const headers = {
        'User-Agent': 'Code-Clover-Application',
        'Accept': 'application/vnd.github.v3+json',
      };
      if (process.env.GITHUB_TOKEN) {
        headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
      }

      try {
        const ghRes = await fetch(`https://api.github.com/users/${usernameClean}`, { headers });
        if (ghRes.status === 404) {
          return res.status(404).json({ message: `GitHub username "${usernameClean}" does not exist.` });
        }
      } catch (fetchErr) {
        console.warn('GitHub validation fetch failed, allowing profile update anyway:', fetchErr.message);
      }
    }

    const result = await db.query(
      'UPDATE clover_users SET github_username = $1, github_data = NULL WHERE id = $2 RETURNING id, username, email, github_username, is_verified, profile_pic_url, security_question',
      [usernameClean, userId]
    );

    // Invalidate github cache for this user
    try {
      const { githubCache } = require('./githubController');
      if (githubCache) {
        githubCache.delete(userId);
      }
    } catch (cacheErr) {
      console.warn('Could not clear github cache on profile update:', cacheErr.message);
    }

    res.json({
      message: 'Profile updated successfully',
      user: result.rows[0]
    });
  } catch (err) {
    console.error('Update Profile Error:', err.message);
    res.status(500).json({ message: 'Server error updating profile' });
  }
};

// -------------------------------------------------------------
// New endpoints for Profile Picture, Security Questions & Forgot Password
// -------------------------------------------------------------
const cloudinaryUtil = require('../utils/cloudinary');

// 1. Upload Profile Pic
exports.uploadProfilePic = async (req, res) => {
  const { image } = req.body; // base64 encoded image data url
  const userId = req.user.id;

  if (!image) {
    return res.status(400).json({ message: 'No image data provided' });
  }

  try {
    const uploadRes = await cloudinaryUtil.uploadImage(image);
    const picUrl = uploadRes.secure_url;

    // Update user profile_pic_url in database
    const result = await db.query(
      'UPDATE clover_users SET profile_pic_url = $1 WHERE id = $2 RETURNING id, username, email, github_username, is_verified, profile_pic_url, security_question',
      [picUrl, userId]
    );

    res.json({
      message: 'Profile picture uploaded successfully!',
      user: result.rows[0]
    });
  } catch (err) {
    console.error('Profile Pic Upload Error:', err.message);
    res.status(500).json({ message: 'Failed to upload profile picture to Cloudinary.' });
  }
};

// 2. Update Security Question
exports.updateSecurityQuestion = async (req, res) => {
  const { security_question, security_answer } = req.body;
  const userId = req.user.id;

  if (!security_question || !security_answer) {
    return res.status(400).json({ message: 'Question and answer are required' });
  }

  try {
    // Normalise answer to lowercase and trim spaces for easy recovery
    const answerClean = security_answer.trim().toLowerCase();

    const result = await db.query(
      'UPDATE clover_users SET security_question = $1, security_answer = $2 WHERE id = $3 RETURNING id, username, email, github_username, is_verified, profile_pic_url, security_question',
      [security_question.trim(), answerClean, userId]
    );

    res.json({
      message: 'Security question updated successfully!',
      user: result.rows[0]
    });
  } catch (err) {
    console.error('Security Question Update Error:', err.message);
    res.status(500).json({ message: 'Server error updating security question' });
  }
};

// 3. Change Password
exports.changePassword = async (req, res) => {
  const { current_password, new_password } = req.body;
  const userId = req.user.id;

  if (!current_password || !new_password) {
    return res.status(400).json({ message: 'Current password and new password are required' });
  }

  try {
    const userRes = await db.query('SELECT * FROM clover_users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = userRes.rows[0];

    const isMatch = await bcrypt.compare(current_password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(new_password, salt);

    await db.query('UPDATE clover_users SET password_hash = $1 WHERE id = $2', [password_hash, userId]);

    res.json({ message: 'Password changed successfully!' });
  } catch (err) {
    console.error('Change Password Error:', err.message);
    res.status(500).json({ message: 'Server error changing password' });
  }
};

// 4. Forgot Password - Send OTP
exports.forgotPasswordSendOtp = async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: 'Please provide email address' });
  }

  try {
    const result = await db.query('SELECT id, email, username FROM clover_users WHERE email = $1', [email.trim().toLowerCase()]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No user registered with this email address' });
    }

    const user = result.rows[0];

    // Generate reset code details
    const reset_otp = generateVerificationCode();
    const reset_otp_expires = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

    await db.query(
      'UPDATE clover_users SET reset_otp = $1, reset_otp_expires = $2 WHERE id = $3',
      [reset_otp, reset_otp_expires, user.id]
    );

    // Send recovery OTP email
    await mailer.sendVerificationEmail(user.email, reset_otp);

    res.json({ message: 'Recovery code sent successfully to your email!' });
  } catch (err) {
    console.error('Forgot Password Send OTP Error:', err.message);
    res.status(500).json({ message: 'Server error sending password reset OTP' });
  }
};

// 5. Forgot Password - Verify OTP & Reset
exports.forgotPasswordVerifyOtp = async (req, res) => {
  const { email, code, new_password } = req.body;

  if (!email || !code || !new_password) {
    return res.status(400).json({ message: 'Please provide email, code, and new password' });
  }

  try {
    const userRes = await db.query('SELECT * FROM clover_users WHERE email = $1', [email.trim().toLowerCase()]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = userRes.rows[0];

    if (!user.reset_otp || user.reset_otp !== code.trim()) {
      return res.status(400).json({ message: 'Invalid recovery code' });
    }

    const expiration = new Date(user.reset_otp_expires);
    if (expiration < new Date()) {
      return res.status(400).json({ message: 'Recovery code has expired. Please request a new one.' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(new_password, salt);

    await db.query(
      `UPDATE clover_users 
       SET password_hash = $1, reset_otp = null, reset_otp_expires = null 
       WHERE id = $2`,
      [password_hash, user.id]
    );

    res.json({ message: 'Password has been reset successfully! You can now log in.' });
  } catch (err) {
    console.error('Forgot Password Verify OTP Error:', err.message);
    res.status(500).json({ message: 'Server error resetting password' });
  }
};

// 6. Forgot Password - Get Security Question
exports.forgotPasswordGetQuestion = async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: 'Please provide email address' });
  }

  try {
    const userRes = await db.query('SELECT security_question FROM clover_users WHERE email = $1', [email.trim().toLowerCase()]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = userRes.rows[0];

    if (!user.security_question) {
      return res.status(400).json({ message: 'No security question has been set up for this account.' });
    }

    res.json({ security_question: user.security_question });
  } catch (err) {
    console.error('Forgot Password Get Question Error:', err.message);
    res.status(500).json({ message: 'Server error retrieving security question' });
  }
};

// 7. Forgot Password - Verify Security Question & Reset
exports.forgotPasswordVerifyQuestion = async (req, res) => {
  const { email, answer, new_password } = req.body;

  if (!email || !answer || !new_password) {
    return res.status(400).json({ message: 'Please provide email, answer, and new password' });
  }

  try {
    const userRes = await db.query('SELECT id, security_answer FROM clover_users WHERE email = $1', [email.trim().toLowerCase()]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = userRes.rows[0];

    if (!user.security_answer) {
      return res.status(400).json({ message: 'No security question has been set up for this account.' });
    }

    if (user.security_answer !== answer.trim().toLowerCase()) {
      return res.status(400).json({ message: 'Incorrect answer to security question' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(new_password, salt);

    await db.query(
      `UPDATE clover_users 
       SET password_hash = $1 
       WHERE id = $2`,
      [password_hash, user.id]
    );

    res.json({ message: 'Password has been reset successfully! You can now log in.' });
  } catch (err) {
    console.error('Forgot Password Verify Question Error:', err.message);
    res.status(500).json({ message: 'Server error resetting password' });
  }
};

exports.checkAndAwardDailyBonus = async (userId) => {
  try {
    const localDateObj = new Date();
    const todayStr = localDateObj.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    // Get user's last login bonus date
    const userRes = await db.query(
      'SELECT last_login_bonus_date FROM clover_users WHERE id = $1',
      [userId]
    );

    if (userRes.rows.length === 0) return false;

    const lastBonusDate = userRes.rows[0].last_login_bonus_date;
    
    // Format lastBonusDate to YYYY-MM-DD if it exists
    let lastBonusDateStr = null;
    if (lastBonusDate) {
      const d = new Date(lastBonusDate);
      lastBonusDateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    if (!lastBonusDateStr || lastBonusDateStr !== todayStr) {
      // Award 1 XP point
      await db.query(
        'UPDATE clover_users SET xp_points = COALESCE(xp_points, 0) + 1, last_login_bonus_date = $1 WHERE id = $2',
        [todayStr, userId]
      );
      return true;
    }
    return false;
  } catch (err) {
    console.error('Error checking daily login bonus:', err.message);
    return false;
  }
};

