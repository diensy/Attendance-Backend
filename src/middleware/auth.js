const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'code_clover_secret_green_leaf_lucky_strike_9988';

const authMiddleware = (req, res, next) => {
  let token = null;

  // 1. Check Authorization Header
  const authHeader = req.header('Authorization');
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      token = parts[1];
    } else {
      return res.status(401).json({ message: 'Token format is invalid. Use Bearer <token>' });
    }
  }

  // 2. Fallback to query parameter (often used for browser file downloads like Excel/PDF)
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ message: 'No token, authorization denied' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Token is not valid' });
  }
};

module.exports = authMiddleware;
