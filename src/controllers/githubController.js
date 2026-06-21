const db = require('../db');

// 5-minute in-memory cache for GitHub statistics to prevent API rate limiting
const githubCache = new Map();
exports.githubCache = githubCache; // Export cache for other controllers to check commits
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// Helper to fetch using Native Fetch (supported natively in Node.js 18+)
const fetchGitHubAPI = async (url) => {
  const headers = {
    'User-Agent': 'Code-Clover-Application',
    'Accept': 'application/vnd.github.v3+json',
  };

  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const error = new Error(`GitHub API error: ${response.statusText} (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return await response.json();
};

exports.getGitHubData = async (req, res) => {
  const userId = req.user.id;

  try {
    // Get user's github_username
    const userRes = await db.query(
      'SELECT github_username FROM clover_users WHERE id = $1',
      [userId]
    );

    const githubUsername = userRes.rows[0]?.github_username;

    // Check cache (and ensure it belongs to the current username)
    const cached = githubCache.get(userId);
    const isUsernameMatch = cached && (
      (cached.data.hasUsername === false && !githubUsername) ||
      (cached.data.hasUsername === true && cached.data.username === githubUsername)
    );

    if (cached && Date.now() < cached.expiry && isUsernameMatch) {
      return res.json(cached.data);
    }

    if (!githubUsername) {
      const emptyData = {
        hasUsername: false,
        repos: getMockRepos(),
        commits: getMockCommits()
      };
      // Don't cache empty profiles for long to allow instant updates
      githubCache.set(userId, { data: emptyData, expiry: Date.now() + 5000 });
      return res.json(emptyData);
    }

    try {
      // Fetch user repos
      const repos = await fetchGitHubAPI(`https://api.github.com/users/${githubUsername}/repos?sort=updated&per_page=6`);
      
      // Fetch user recent public events
      const events = await fetchGitHubAPI(`https://api.github.com/users/${githubUsername}/events/public?per_page=20`);

      // Filter events to find PushEvents (commits)
      const pushEvents = events.filter(event => event.type === 'PushEvent');
      const commits = [];

      pushEvents.forEach(event => {
        const repoName = event.repo.name.split('/')[1] || event.repo.name;
        if (event.payload && event.payload.commits) {
          event.payload.commits.forEach(commit => {
            commits.push({
              sha: commit.sha.substring(0, 7),
              message: commit.message,
              repo: repoName,
              date: event.created_at,
              author: event.actor.login
            });
          });
        }
      });

      // Format repositories list
      const formattedRepos = repos.map(repo => ({
        id: repo.id,
        name: repo.name,
        description: repo.description || 'No description provided.',
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        language: repo.language || 'Markdown',
        url: repo.html_url
      }));

      // Check achievement for connecting GitHub
      let badgeUnlocked = null;
      try {
        const badge = { name: 'Git Lucky', desc: 'Successfully synchronized your GitHub account with Code Clover!', icon: 'github' };
        const check = await db.query('INSERT INTO clover_achievements (user_id, badge_name, badge_description, icon) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING *', [userId, badge.name, badge.desc, badge.icon]);
        if (check.rows.length > 0) badgeUnlocked = badge;
      } catch (err) {
        console.error('GitHub badge error:', err.message);
      }

      const responseData = {
        hasUsername: true,
        username: githubUsername,
        repos: formattedRepos,
        commits: commits.slice(0, 10), // return top 10 recent commits
        badgeUnlocked
      };

      githubCache.set(userId, { data: responseData, expiry: Date.now() + CACHE_DURATION_MS });

      // Trigger silent auto-link of roadmaps to parse commit message tags
      try {
        const { autoLinkRoadmaps } = require('./coursesController');
        if (autoLinkRoadmaps) {
          await autoLinkRoadmaps(userId);
        }
      } catch (err) {
        console.warn('Undeclared auto-link roadmaps on github update:', err.message);
      }

      // Recalculate today's attendance (updates streak and status)
      const { recalculateAttendance } = require('./attendanceController');
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      await recalculateAttendance(userId, todayStr);

      res.json(responseData);

    } catch (apiErr) {
      if (apiErr.status === 404) {
        return res.status(404).json({ message: `GitHub username "${githubUsername}" does not exist.` });
      }

      console.warn(`⚠️ [GitHub] API fetch failed: ${apiErr.message}. Falling back to styled mock data.`);
      
      // Fallback to high quality mock data using user's configured username
      const mockData = {
        hasUsername: true,
        username: githubUsername,
        isMocked: true,
        repos: getMockRepos(githubUsername),
        commits: getMockCommits(githubUsername)
      };

      githubCache.set(userId, { data: mockData, expiry: Date.now() + CACHE_DURATION_MS });

      // Trigger silent auto-link of roadmaps on mock data (e.g. for testing)
      try {
        const { autoLinkRoadmaps } = require('./coursesController');
        if (autoLinkRoadmaps) {
          await autoLinkRoadmaps(userId);
        }
      } catch (err) {
        console.warn('Undeclared auto-link roadmaps on github update:', err.message);
      }

      // Recalculate today's attendance (updates streak and status)
      const { recalculateAttendance } = require('./attendanceController');
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      await recalculateAttendance(userId, todayStr);

      res.json(mockData);
    }

  } catch (err) {
    console.error('GitHub Sync Controller Error:', err.message);
    res.status(500).json({ message: 'Server error retrieving GitHub status' });
  }
};

exports.getCommitsCountForDate = async (userId, dateStr) => {
  let gitData = null;
  const cached = githubCache.get(userId);
  if (cached && Date.now() < cached.expiry) {
    gitData = cached.data;
  } else {
    try {
      const userRes = await db.query('SELECT github_username FROM clover_users WHERE id = $1', [userId]);
      const githubUsername = userRes.rows[0]?.github_username;
      if (!githubUsername) return 0;
      
      let data;
      try {
        const repos = await fetchGitHubAPI(`https://api.github.com/users/${githubUsername}/repos?sort=updated&per_page=6`);
        const events = await fetchGitHubAPI(`https://api.github.com/users/${githubUsername}/events/public?per_page=20`);
        const pushEvents = events.filter(event => event.type === 'PushEvent');
        const commits = [];
        pushEvents.forEach(event => {
          const repoName = event.repo.name.split('/')[1] || event.repo.name;
          if (event.payload && event.payload.commits) {
            event.payload.commits.forEach(commit => {
              commits.push({
                sha: commit.sha.substring(0, 7),
                message: commit.message,
                repo: repoName,
                date: event.created_at,
                author: event.actor.login
              });
            });
          }
        });
        
        const formattedRepos = repos.map(repo => ({
          id: repo.id,
          name: repo.name,
          description: repo.description || 'No description provided.',
          stars: repo.stargazers_count,
          forks: repo.forks_count,
          language: repo.language || 'Markdown',
          url: repo.html_url
        }));

        data = {
          hasUsername: true,
          username: githubUsername,
          repos: formattedRepos,
          commits: commits.slice(0, 10)
        };
      } catch (apiErr) {
        if (apiErr.status === 404) {
          return 0;
        }
        data = {
          hasUsername: true,
          username: githubUsername,
          isMocked: true,
          repos: getMockRepos(githubUsername),
          commits: getMockCommits(githubUsername)
        };
      }
      
      githubCache.set(userId, { data, expiry: Date.now() + CACHE_DURATION_MS });
      gitData = data;
    } catch (err) {
      console.error('Error fetching commits count silently:', err.message);
      return 0;
    }
  }

  if (!gitData || !gitData.commits) return 0;

  const targetCommits = gitData.commits.filter(commit => {
    const commitDate = new Date(commit.date);
    const commitDateStr = commitDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    return commitDateStr === dateStr;
  });

  return targetCommits.length;
};

exports.getTodayCommitsCount = async (userId) => {
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return exports.getCommitsCountForDate(userId, todayStr);
};

// Generates high quality mock repositories for demonstration
function getMockRepos(username = 'developer') {
  return [
    {
      id: 101,
      name: 'node-express-postgresql-boilerplate',
      description: 'Clean skeleton boilerplate for building modern REST APIs using Express.js and pg pool.',
      stars: 12,
      forks: 3,
      language: 'JavaScript',
      url: `https://github.com/${username}/node-express-postgresql-boilerplate`
    },
    {
      id: 102,
      name: 'data-structures-and-algorithms-practice',
      description: 'Daily DSA practice logs. Contains solutions to LeetCode problems in Python and JS.',
      stars: 8,
      forks: 1,
      language: 'Python',
      url: `https://github.com/${username}/data-structures-and-algorithms-practice`
    },
    {
      id: 103,
      name: 'clover-focus-timer-web',
      description: 'Pomodoro timer application with sound and desktop notifications.',
      stars: 4,
      forks: 0,
      language: 'CSS',
      url: `https://github.com/${username}/clover-focus-timer-web`
    }
  ];
}

// Generates high quality mock commits for demonstration
function getMockCommits(username = 'developer') {
  const now = new Date();
  const getPastDate = (hoursAgo) => new Date(now.getTime() - hoursAgo * 60 * 60 * 1000).toISOString();
  
  return [
    {
      sha: 'a57df9b',
      message: 'feat: add PostgreSQL schema setup for clover attendance system',
      repo: 'node-express-postgresql-boilerplate',
      date: getPastDate(2),
      author: username
    },
    {
      sha: 'f1e4b89',
      message: 'docs: update README with environment configurations instructions',
      repo: 'node-express-postgresql-boilerplate',
      date: getPastDate(5),
      author: username
    },
    {
      sha: '9c53fd2',
      message: 'solve: binary tree path inversion and level order traversal dfs solutions',
      repo: 'data-structures-and-algorithms-practice',
      date: getPastDate(20),
      author: username
    },
    {
      sha: 'd3f66a1',
      message: 'refactor: modify focus timer countdown handler and enable browser push warnings',
      repo: 'clover-focus-timer-web',
      date: getPastDate(30),
      author: username
    }
  ];
}
