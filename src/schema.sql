-- Create users table
CREATE TABLE IF NOT EXISTS clover_users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  github_username VARCHAR(100) DEFAULT NULL,
  is_verified BOOLEAN DEFAULT FALSE,
  verification_code VARCHAR(6) DEFAULT NULL,
  verification_expires TIMESTAMP DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create attendance table
CREATE TABLE IF NOT EXISTS clover_attendance (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES clover_users(id) ON DELETE CASCADE,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  status VARCHAR(20) DEFAULT 'Present',
  study_hours NUMERIC(5,2) DEFAULT 0.00,
  daily_notes TEXT DEFAULT NULL,
  ai_summary TEXT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_user_date UNIQUE(user_id, date)
);

-- Create focus sessions table
CREATE TABLE IF NOT EXISTS clover_focus_sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES clover_users(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL, -- Pomodoro, Stopwatch
  mode VARCHAR(20) NOT NULL, -- 25/5, 50/10, Custom, Stopwatch
  duration_seconds INTEGER NOT NULL,
  topics TEXT[] DEFAULT '{}',
  notes TEXT DEFAULT NULL,
  completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create goals table
CREATE TABLE IF NOT EXISTS clover_goals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES clover_users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  category VARCHAR(50) NOT NULL, -- Node.js, Python, DSA, AI/Data Science
  target_hours NUMERIC(5,2) DEFAULT 0.00,
  current_hours NUMERIC(5,2) DEFAULT 0.00,
  target_date DATE NOT NULL,
  is_completed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create achievements table
CREATE TABLE IF NOT EXISTS clover_achievements (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES clover_users(id) ON DELETE CASCADE,
  badge_name VARCHAR(100) NOT NULL,
  badge_description VARCHAR(255) NOT NULL,
  icon VARCHAR(50) NOT NULL,
  unlocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_user_badge UNIQUE(user_id, badge_name)
);

-- Safe Alterations for Upgrading existing databases
ALTER TABLE clover_users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE clover_users ADD COLUMN IF NOT EXISTS verification_code VARCHAR(6) DEFAULT NULL;
ALTER TABLE clover_users ADD COLUMN IF NOT EXISTS verification_expires TIMESTAMP DEFAULT NULL;
ALTER TABLE clover_users ADD COLUMN IF NOT EXISTS profile_pic_url TEXT DEFAULT NULL;
ALTER TABLE clover_users ADD COLUMN IF NOT EXISTS security_question VARCHAR(255) DEFAULT NULL;
ALTER TABLE clover_users ADD COLUMN IF NOT EXISTS security_answer VARCHAR(255) DEFAULT NULL;
ALTER TABLE clover_users ADD COLUMN IF NOT EXISTS reset_otp VARCHAR(6) DEFAULT NULL;
ALTER TABLE clover_users ADD COLUMN IF NOT EXISTS reset_otp_expires TIMESTAMP DEFAULT NULL;

-- Create todos table
CREATE TABLE IF NOT EXISTS clover_todos (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES clover_users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  priority VARCHAR(20) DEFAULT 'Medium', -- 'High', 'Medium', 'Low'
  category VARCHAR(50) DEFAULT 'General', -- 'Node.js', 'Python', 'DSA', 'AI', 'Personal Learning'
  is_completed BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMP DEFAULT NULL,
  due_date DATE DEFAULT CURRENT_DATE,
  is_recurring BOOLEAN DEFAULT FALSE,
  recurrence_pattern VARCHAR(20) DEFAULT NULL, -- 'Daily', 'Weekly'
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create courses/playlists table
CREATE TABLE IF NOT EXISTS clover_courses (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES clover_users(id) ON DELETE CASCADE,
  playlist_id VARCHAR(100) DEFAULT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT DEFAULT NULL,
  thumbnail_url VARCHAR(500) DEFAULT NULL,
  total_videos INTEGER DEFAULT 0,
  subject VARCHAR(50) DEFAULT 'General',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create course videos table
CREATE TABLE IF NOT EXISTS clover_course_videos (
  id SERIAL PRIMARY KEY,
  course_id INTEGER REFERENCES clover_courses(id) ON DELETE CASCADE,
  video_id VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  duration_seconds INTEGER DEFAULT 0,
  position INTEGER DEFAULT 0,
  start_seconds INTEGER DEFAULT 0
);

-- Create video progress & notes table
CREATE TABLE IF NOT EXISTS clover_user_video_progress (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES clover_users(id) ON DELETE CASCADE,
  video_id INTEGER REFERENCES clover_course_videos(id) ON DELETE CASCADE,
  watched_seconds INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  is_completed BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMP DEFAULT NULL,
  CONSTRAINT unique_user_video UNIQUE (user_id, video_id)
);

-- Create roadmaps table
CREATE TABLE IF NOT EXISTS clover_roadmaps (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES clover_users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  subject VARCHAR(50) DEFAULT 'General',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create roadmap items table
CREATE TABLE IF NOT EXISTS clover_roadmap_items (
  id SERIAL PRIMARY KEY,
  roadmap_id INTEGER REFERENCES clover_roadmaps(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  status VARCHAR(20) DEFAULT 'Not Started', -- 'Not Started', 'In Progress', 'Completed'
  associated_video_id INTEGER REFERENCES clover_course_videos(id) ON DELETE SET NULL,
  position INTEGER DEFAULT 0,
  completed_at TIMESTAMPTZ DEFAULT NULL
);
-- Safe upgrades
ALTER TABLE clover_courses ADD COLUMN IF NOT EXISTS subject VARCHAR(50) DEFAULT 'General';
ALTER TABLE clover_course_videos ADD COLUMN IF NOT EXISTS start_seconds INTEGER DEFAULT 0;
ALTER TABLE clover_roadmaps ADD COLUMN IF NOT EXISTS subject VARCHAR(50) DEFAULT 'General';
ALTER TABLE clover_roadmap_items ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE clover_smart_goals ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMPTZ DEFAULT NULL;

-- Create User Preferences table
CREATE TABLE IF NOT EXISTS clover_user_preferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES clover_users(id) ON DELETE CASCADE UNIQUE,
  preferred_study_time VARCHAR(50) DEFAULT 'Night', -- 'Morning', 'Afternoon', 'Night'
  daily_hours NUMERIC(4,1) DEFAULT 2.0,
  office_time_start TIME DEFAULT '10:00:00',
  office_time_end TIME DEFAULT '19:00:00',
  career_goal VARCHAR(255) DEFAULT 'Backend Developer',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Safe Alterations for User Preferences
ALTER TABLE clover_user_preferences ADD COLUMN IF NOT EXISTS auto_create_smart_goals BOOLEAN DEFAULT false;

-- Create Chat History table (optional but good for AI context memory)
CREATE TABLE IF NOT EXISTS clover_chat_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES clover_users(id) ON DELETE CASCADE,
  role VARCHAR(10) NOT NULL, -- 'user' or 'assistant'
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create Smart Goals table for daily session tracking
CREATE TABLE IF NOT EXISTS clover_smart_goals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES clover_users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  reason VARCHAR(255),
  priority VARCHAR(20) DEFAULT 'Medium',
  status VARCHAR(20) DEFAULT 'Active', -- 'Active', 'Completed', 'Interrupted'
  actual_end_time TIMESTAMPTZ DEFAULT NULL,
  quit_reason VARCHAR(255) DEFAULT NULL,
  last_heartbeat TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create Interactive Study IDE Tasks table for tracking progressive challenges
CREATE TABLE IF NOT EXISTS clover_study_ide_tasks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES clover_users(id) ON DELETE CASCADE,
  subject VARCHAR(100) NOT NULL,
  topic VARCHAR(100) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  starter_code TEXT NOT NULL,
  test_code TEXT NOT NULL,
  user_code TEXT DEFAULT '',
  is_completed BOOLEAN DEFAULT FALSE,
  task_order INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ DEFAULT NULL
);
