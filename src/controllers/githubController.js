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

// Helper to fetch actual commits for the top 2 pushed repositories (handles Oct 2025 breaking change)
const parseCommitsFromEvents = async (pushEvents) => {
  const commits = [];
  const pushedRepos = Array.from(new Set(pushEvents.map(e => e.repo.name))).slice(0, 2);

  for (const repoFullName of pushedRepos) {
    try {
      const repoCommits = await fetchGitHubAPI(`https://api.github.com/repos/${repoFullName}/commits?per_page=5`);
      const repoName = repoFullName.split('/')[1] || repoFullName;
      
      const matchingPush = pushEvents.find(e => e.repo.name === repoFullName);
      const pushDate = matchingPush ? matchingPush.created_at : new Date().toISOString();

      repoCommits.forEach(c => {
        commits.push({
          sha: c.sha.substring(0, 7),
          message: c.commit.message,
          repo: repoName,
          date: pushDate,
          author: c.author ? c.author.login : c.commit.author.name
        });
      });
    } catch (repoErr) {
      console.warn(`Failed to fetch commits for repo ${repoFullName}:`, repoErr.message);
    }
  }
  return commits;
};

exports.getGitHubData = async (req, res) => {
  const userId = req.user.id;

  try {
    // Get user's github_username and github_data
    const userRes = await db.query(
      'SELECT github_username, github_data FROM clover_users WHERE id = $1',
      [userId]
    );

    const githubUsername = userRes.rows[0]?.github_username;
    const dbGithubData = userRes.rows[0]?.github_data;

    if (!githubUsername) {
      const emptyData = {
        hasUsername: false,
        repos: getMockRepos(),
        commits: getMockCommits()
      };
      return res.json(emptyData);
    }

    // Use database cached data if available
    if (dbGithubData && dbGithubData.username === githubUsername && !dbGithubData.error) {
      return res.json(dbGithubData);
    }

    try {
      // Fetch user repos
      const repos = await fetchGitHubAPI(`https://api.github.com/users/${githubUsername}/repos?sort=updated&per_page=6`);
      
      // Fetch user recent public events
      const events = await fetchGitHubAPI(`https://api.github.com/users/${githubUsername}/events/public?per_page=20`);

      // Filter events to find PushEvents (commits)
      const pushEvents = events.filter(event => event.type === 'PushEvent');
      const commits = await parseCommitsFromEvents(pushEvents);

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

      // Save to Database Cache
      await db.query(
        'UPDATE clover_users SET github_data = $1 WHERE id = $2',
        [responseData, userId]
      );

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

      console.warn(`⚠️ [GitHub] API fetch failed for user "${githubUsername}": ${apiErr.message}.`);
      
      let errorMsg = `GitHub API request failed: ${apiErr.message}.`;
      if (apiErr.status === 403) {
        errorMsg = `GitHub API rate limit exceeded. To prevent this, please add a GITHUB_TOKEN in your backend/.env file.`;
      }

      const errorData = {
        hasUsername: true,
        username: githubUsername,
        isMocked: false,
        repos: [],
        commits: [],
        error: errorMsg
      };

      // In case of error, just return errorData without saving to DB so they can retry later
      res.json(errorData);
    }

  } catch (err) {
    console.error('GitHub Sync Controller Error:', err.message);
    res.status(500).json({ message: 'Server error retrieving GitHub status' });
  }
};

exports.getCommitsCountForDate = async (userId, dateStr) => {
  let gitData = null;
  try {
    const userRes = await db.query('SELECT github_username, github_data FROM clover_users WHERE id = $1', [userId]);
    const githubUsername = userRes.rows[0]?.github_username;
    const dbGithubData = userRes.rows[0]?.github_data;
    
    if (!githubUsername) return 0;

    if (dbGithubData && dbGithubData.username === githubUsername && !dbGithubData.error) {
      gitData = dbGithubData;
    } else {
      let data;
      try {
        const repos = await fetchGitHubAPI(`https://api.github.com/users/${githubUsername}/repos?sort=updated&per_page=6`);
        const events = await fetchGitHubAPI(`https://api.github.com/users/${githubUsername}/events/public?per_page=20`);
        const pushEvents = events.filter(event => event.type === 'PushEvent');
        const commits = await parseCommitsFromEvents(pushEvents);
        
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
          isMocked: false,
          repos: [],
          commits: [],
          error: apiErr.message
        };
      }
      
      // Save data silently to db
      if (data && !data.error) {
        await db.query('UPDATE clover_users SET github_data = $1 WHERE id = $2', [data, userId]);
      }
      gitData = data;
    } // Close the else block
  } catch (err) {
    console.error('Error fetching commits count silently:', err.message);
    return 0;
  }

  if (!gitData || !gitData.commits) return 0;

  const targetCommits = gitData.commits.filter(commit => {
    if (!commit || !commit.date) return false;
    const commitDate = new Date(commit.date);
    if (isNaN(commitDate.getTime())) return false;
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
