const db = require('../db');
const { recalculateAttendance } = require('./attendanceController');
const { OpenAI } = require('openai');

// ─── Timestamps and Chapters Parser ──────────────────────────────────────────
const parseTimestamps = (description, videoId, totalDuration = 1800) => {
  if (!description) return [];
  const lines = description.split('\n');
  const chapters = [];
  
  // Regex to match timestamps like 00:00, 06:23, 01:10:29, or [06:23], (01:10:29)
  const timestampRegex = /(?:^|\s|\(|\[)(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*[-–—:]?\s*)(.*)/;

  for (let i = 0; i < lines.length; i++) {
    const cleanLine = lines[i].trim();
    const match = cleanLine.match(timestampRegex);
    if (match) {
      const timeStr = match[1];
      let title = match[2].trim();
      
      // Remove trailing brackets/parentheses from title if any
      title = title.replace(/[\]\)]\s*$/, '').trim();
      // Remove leading hyphens/colons
      title = title.replace(/^[-–—:\s]+/, '').trim();

      // If title is empty after cleaning (meaning timestamp is standalone on a line), look at previous line
      if (!title && i > 0) {
        title = lines[i - 1].trim();
        // optionally remove numbering like "1. " or "1) "
        title = title.replace(/^\d+[\.\)]\s*/, '').trim();
      }
      
      // Parse timeStr to seconds
      const parts = timeStr.split(':').map(Number);
      let seconds = 0;
      if (parts.length === 3) {
        seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
      } else if (parts.length === 2) {
        seconds = parts[0] * 60 + parts[1];
      }
      
      chapters.push({
        video_id: videoId,
        title: title || `Chapter at ${timeStr}`,
        start_seconds: seconds
      });
    }
  }

  // Filter out any duplicate timestamps
  const uniqueChapters = [];
  const seenTimes = new Set();
  for (const c of chapters) {
    if (!seenTimes.has(c.start_seconds)) {
      seenTimes.add(c.start_seconds);
      uniqueChapters.push(c);
    }
  }

  // Sort uniqueChapters by start time
  uniqueChapters.sort((a, b) => a.start_seconds - b.start_seconds);

  if (uniqueChapters.length < 2) return [];

  // Calculate durations for each chapter
  for (let i = 0; i < uniqueChapters.length; i++) {
    uniqueChapters[i].position = i + 1;
    if (i < uniqueChapters.length - 1) {
      uniqueChapters[i].duration_seconds = uniqueChapters[i+1].start_seconds - uniqueChapters[i].start_seconds;
    } else {
      uniqueChapters[i].duration_seconds = Math.max(900, totalDuration - uniqueChapters[i].start_seconds);
    }
    
    if (uniqueChapters[i].duration_seconds <= 0) {
      uniqueChapters[i].duration_seconds = 900;
    }
  }

  return uniqueChapters;
};

// ─── Auto Upgrade Existing Monolithic single-video courses with parsed timestamps ─
const upgradeExistingSingleVideoCourses = async () => {
  try {
    // Find all courses with total_videos <= 1
    const coursesRes = await db.query(
      `SELECT c.id, c.title, c.description, c.user_id, c.subject, v.video_id, v.duration_seconds
       FROM clover_courses c
       JOIN clover_course_videos v ON v.course_id = c.id
       WHERE c.total_videos <= 1`
    );

    for (const course of coursesRes.rows) {
      const chapters = parseTimestamps(course.description, course.video_id, course.duration_seconds);
      if (chapters.length >= 2) {
        console.log(`🍀 [Db Upgrade] Upgrading existing course: "${course.title}" with ${chapters.length} chapters.`);
        
        // 1. Get the existing single video ID
        const singleVidRes = await db.query(
          'SELECT id FROM clover_course_videos WHERE course_id = $1 LIMIT 1',
          [course.id]
        );
        if (singleVidRes.rows.length === 0) continue;
        const oldVideoId = singleVidRes.rows[0].id;

        // 2. Delete the old single video (cascades to progress)
        await db.query('DELETE FROM clover_course_videos WHERE id = $1', [oldVideoId]);

        // 3. Delete existing roadmap items for this course's roadmaps and sync subject
        const roadmapsRes = await db.query('SELECT id FROM clover_roadmaps WHERE title LIKE $1', [`%${course.title}%`]);
        for (const rm of roadmapsRes.rows) {
          await db.query('DELETE FROM clover_roadmap_items WHERE roadmap_id = $1', [rm.id]);
          await db.query('UPDATE clover_roadmaps SET subject = $1 WHERE id = $2', [course.subject || 'General', rm.id]);
        }

        // 4. Insert new chapter videos
        const newVideos = [];
        for (const ch of chapters) {
          const videoRes = await db.query(
            `INSERT INTO clover_course_videos (course_id, video_id, title, duration_seconds, position, start_seconds)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [course.id, ch.video_id, ch.title, ch.duration_seconds, ch.position, ch.start_seconds]
          );
          const video = videoRes.rows[0];
          newVideos.push(video);

          // Insert default progress for user
          await db.query(
            `INSERT INTO clover_user_video_progress (user_id, video_id, watched_seconds, notes, is_completed)
             VALUES ($1, $2, 0, '', false) ON CONFLICT DO NOTHING`,
            [course.user_id, video.id]
          );
        }

        // 5. Update course total_videos count
        await db.query(
          'UPDATE clover_courses SET total_videos = $1 WHERE id = $2',
          [newVideos.length, course.id]
        );

        // 6. Insert new roadmap items
        for (const rm of roadmapsRes.rows) {
          for (let i = 0; i < newVideos.length; i++) {
            const nv = newVideos[i];
            await db.query(
              `INSERT INTO clover_roadmap_items (roadmap_id, title, status, associated_video_id, position)
               VALUES ($1, $2, 'Not Started', $3, $4)`,
              [rm.id, nv.title, nv.id, i + 1]
            );
          }
        }
      }
    }
  } catch (err) {
    console.error('❌ [Db Upgrade] Error upgrading existing courses:', err.message);
  }
};

const migrateRoadmapSubjects = async () => {
  try {
    await db.query("ALTER TABLE clover_roadmaps ADD COLUMN IF NOT EXISTS subject VARCHAR(50) DEFAULT 'General';");
    console.log('🍀 [Db Upgrade] Checked/Added subject column to clover_roadmaps.');

    await db.query(`
      UPDATE clover_roadmaps r
      SET subject = c.subject
      FROM clover_roadmap_items i
      JOIN clover_course_videos v ON v.id = i.associated_video_id
      JOIN clover_courses c ON c.id = v.course_id
      WHERE i.roadmap_id = r.id AND (r.subject IS NULL OR r.subject = 'General');
    `);

    await db.query(`
      UPDATE clover_roadmaps r
      SET subject = c.subject
      FROM clover_courses c
      WHERE r.title LIKE '%' || c.title || '%' AND (r.subject IS NULL OR r.subject = 'General');
    `);

    console.log('🍀 [Db Upgrade] Migrated roadmap subject fields.');
  } catch (err) {
    console.error('❌ [Db Upgrade] Failed to migrate roadmap subjects:', err.message);
  }
};

// Ensure database is upgraded with start_seconds and subject columns
db.query('ALTER TABLE clover_course_videos ADD COLUMN IF NOT EXISTS start_seconds INTEGER DEFAULT 0;')
  .then(() => {
    console.log('🍀 [Db Upgrade] Checked/Added start_seconds column.');
    migrateRoadmapSubjects().then(() => {
      upgradeExistingSingleVideoCourses();
    });
  })
  .catch(err => console.error('❌ [Db Upgrade] start_seconds column check failed:', err.message));

// Initialize OpenAI client if key is configured
const getOpenAIClient = () => {
  if (process.env.OPENAI_API_KEY) {
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return null;
};

// ─── Scraper to parse YouTube playlist without API key ────────────────────────
const scrapeYouTubePlaylist = async (playlistId) => {
  try {
    const url = `https://www.youtube.com/playlist?list=${playlistId}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': 'CONSENT=YES+cb.20210328-17-p0.en+FX+478;'
      }
    });

    if (!response.ok) throw new Error('Failed to fetch playlist page');

    const html = await response.text();
    const match = html.match(/ytInitialData\s*=\s*({.+?});/);
    if (!match) throw new Error('Could not find ytInitialData in YouTube response');

    const ytData = JSON.parse(match[1]);
    
    // Extract playlist title
    let title = 'Imported YouTube Playlist';
    try {
      title = ytData.metadata.playlistMetadataRenderer.title || title;
    } catch (e) {
      try {
        title = ytData.header.playlistHeaderRenderer.title.simpleText || title;
      } catch (err) {}
    }

    // Extract videos
    let rawVideos = [];
    try {
      const tabs = ytData.contents.twoColumnBrowseResultsRenderer.tabs;
      const tabContent = tabs[0].tabRenderer.content;
      const sectionContents = tabContent.sectionListRenderer.contents[0].itemSectionRenderer.contents[0];
      rawVideos = sectionContents.playlistVideoListRenderer.contents || [];
    } catch (e) {
      console.warn('Scraper: standard video extraction failed, checking sidebar/alternative JSON nodes', e.message);
    }

    const videos = [];
    rawVideos.forEach((item, index) => {
      const v = item.playlistVideoRenderer;
      if (!v) return;

      let vTitle = '';
      try {
        vTitle = v.title.runs[0].text || v.title.simpleText || 'Untitled Episode';
      } catch (err) {
        vTitle = `Episode ${index + 1}`;
      }

      let vId = v.videoId;
      
      let durationSeconds = 900; // Default fallback to 15 mins
      try {
        durationSeconds = parseInt(v.lengthSeconds || '900', 10);
      } catch (err) {}

      if (vId) {
        videos.push({
          video_id: vId,
          title: vTitle,
          duration_seconds: durationSeconds,
          position: index + 1
        });
      }
    });

    if (videos.length === 0) {
      throw new Error('Scraper extracted 0 videos');
    }

    // Extract thumbnail
    let thumbnail = null;
    try {
      thumbnail = ytData.header.playlistHeaderRenderer.playlistHeaderBanner.heroPlaylistThumbnailRenderer.thumbnail.thumbnails[0].url;
    } catch (e) {
      if (videos.length > 0) {
        thumbnail = `https://img.youtube.com/vi/${videos[0].video_id}/hqdefault.jpg`;
      }
    }

    return {
      title,
      description: `Imported playlist containing ${videos.length} videos.`,
      thumbnail_url: thumbnail,
      videos
    };
  } catch (err) {
    console.error('YouTube Scraper Error:', err.message);
    throw err;
  }
};

// ─── Official YouTube Data API Fallback ───────────────────────────────────────
const fetchPlaylistFromAPI = async (playlistId, apiKey) => {
  try {
    const playlistUrl = `https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${playlistId}&key=${apiKey}`;
    const pRes = await fetch(playlistUrl);
    if (!pRes.ok) throw new Error('API failed fetching playlist details');
    const pData = await pRes.json();
    
    if (!pData.items || pData.items.length === 0) {
      throw new Error('Playlist not found via API');
    }

    const snippet = pData.items[0].snippet;
    const title = snippet.title;
    const description = snippet.description;
    const thumbnail = snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url;

    // Fetch playlist items (videos)
    const itemsUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${playlistId}&maxResults=50&key=${apiKey}`;
    const iRes = await fetch(itemsUrl);
    if (!iRes.ok) throw new Error('API failed fetching playlist items');
    const iData = await iRes.json();

    const videos = (iData.items || []).map((item, index) => {
      // Parse a standard mock/api fallback duration or call videos API if needed.
      // Since playlistItems API doesn't return duration, we default to 15 mins (900 seconds) 
      // or standard video duration templates to avoid heavy extra API requests.
      return {
        video_id: item.snippet.resourceId.videoId,
        title: item.snippet.title,
        duration_seconds: 1200, // Default 20 mins
        position: index + 1
      };
    });

    return {
      title,
      description,
      thumbnail_url: thumbnail,
      videos
    };
  } catch (err) {
    console.error('YouTube API Error:', err.message);
    throw err;
  }
};

// ─── Mock learning course content fallback ─────────────────────────────────────
const generateMockPlaylist = (playlistUrl) => {
  let title = 'Fullstack Developer Masterclass 🍀';
  let category = 'Node.js';
  
  const urlLower = playlistUrl.toLowerCase();
  if (urlLower.includes('react') || urlLower.includes('frontend')) {
    title = 'React Frontend Course';
    category = 'React';
  } else if (urlLower.includes('python')) {
    title = 'Python & Django Backend Core';
    category = 'Python';
  } else if (urlLower.includes('dsa') || urlLower.includes('leetcode') || urlLower.includes('algo')) {
    title = 'Data Structures & Algorithms Prep';
    category = 'DSA';
  } else if (urlLower.includes('ai') || urlLower.includes('ml') || urlLower.includes('data')) {
    title = 'AI & Deep Learning Fundamentals';
    category = 'AI';
  }

  // Pre-configured structured chapters
  const mockVideoTemplates = {
    'Node.js': [
      { title: 'Express & API Basics', duration_seconds: 1200 },
      { title: 'Understanding Express Middleware', duration_seconds: 1800 },
      { title: 'Token Authentication with JWT', duration_seconds: 2400 },
      { title: 'Connecting to PostgreSQL Database', duration_seconds: 2700 },
      { title: 'Caching with Redis Cache', duration_seconds: 1500 },
      { title: 'Introduction to Microservices Architecture', duration_seconds: 3000 },
      { title: 'Writing Integration Tests in Jest', duration_seconds: 1800 },
      { title: 'Deploying Node APIs to Cloud Hosting', duration_seconds: 2100 }
    ],
    'React': [
      { title: 'React JSX & Virtual DOM Introduction', duration_seconds: 1000 },
      { title: 'React Hooks: State & Side Effects', duration_seconds: 1800 },
      { title: 'Routing with React Router', duration_seconds: 1200 },
      { title: 'Context API and State Managers', duration_seconds: 2000 },
      { title: 'Styling with Tailwind CSS UI', duration_seconds: 1500 },
      { title: 'HTTP Fetching & Axios Services', duration_seconds: 2200 }
    ],
    'Python': [
      { title: 'Python Syntax & Dynamic Typing', duration_seconds: 900 },
      { title: 'Object-Oriented Programming (OOP) in Python', duration_seconds: 1500 },
      { title: 'Virtual Environments & PIP Packages', duration_seconds: 800 },
      { title: 'Django Web Framework Fundamentals', duration_seconds: 2400 },
      { title: 'Pandas Dataframes Data Manipulation', duration_seconds: 1800 }
    ],
    'DSA': [
      { title: 'Introduction to Big O Notation & Time Complexity', duration_seconds: 1200 },
      { title: 'Arrays & Dynamic Strings Manipulations', duration_seconds: 1500 },
      { title: 'Linked Lists & Pointer Operations', duration_seconds: 1800 },
      { title: 'Binary Trees & Graph Traversals (DFS/BFS)', duration_seconds: 2400 },
      { title: 'Recursion vs Iteration Algorithms', duration_seconds: 1600 }
    ],
    'AI': [
      { title: 'Machine Learning Models & Overfitting', duration_seconds: 1800 },
      { title: 'Neural Networks & Deep Learning Intro', duration_seconds: 2400 },
      { title: 'Natural Language Processing & Word Embeddings', duration_seconds: 2000 },
      { title: 'Fine-Tuning Generative AI Models', duration_seconds: 2800 }
    ]
  };

  const selectedVideos = mockVideoTemplates[category] || mockVideoTemplates['Node.js'];
  const videoIds = [
    'dQw4w9WgXcQ', 'L_LUpnjgPso', 'Ke90Tje7VS0', 'y881t8ilMyc',
    '3PHXvlpOkf4', 'SqcY0GlETPk', 'W6NZfCO5SIk', 's2mDy0NDQfg'
  ];

  const videos = selectedVideos.map((video, idx) => ({
    video_id: videoIds[idx % videoIds.length],
    title: video.title,
    duration_seconds: video.duration_seconds,
    position: idx + 1
  }));

  return {
    title,
    description: `A simulated course for "${category}" learning. Generated dynamically from URL link fallback.`,
    thumbnail_url: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=500',
    videos
  };
};

// Duplicate parser signature removed cleanly.

// ─── Single Video Metadata Ingest helper ─────────────────────────────────────
const findValInObject = (obj, key) => {
  if (!obj || typeof obj !== 'object') return null;
  if (obj[key] !== undefined) return obj[key];
  for (const k in obj) {
    if (obj.hasOwnProperty(k)) {
      const result = findValInObject(obj[k], key);
      if (result) return result;
    }
  }
  return null;
};

const extractDescriptionFromYtData = (ytData) => {
  if (!ytData) return '';
  let bestMatch = '';
  
  // Recursively search the entire JSON tree for the longest text block containing newlines/timestamps
  const search = (o) => {
    if (!o || typeof o !== 'object') return;
    
    // Check if there is a 'content' string
    if (o.content && typeof o.content === 'string') {
      if (o.content.length > bestMatch.length) {
        bestMatch = o.content;
      }
    }
    
    for (let key in o) {
      // Check if there is a 'runs' array
      if (key === 'runs' && Array.isArray(o[key])) {
        const text = o[key].map(r => r.text || '').join('');
        if (text.length > bestMatch.length) {
          bestMatch = text;
        }
      }
      
      // Keep searching deeper
      if (typeof o[key] === 'object') {
        search(o[key]);
      }
    }
  };
  
  search(ytData);

  if (bestMatch) {
    return bestMatch;
  }

  // Last resort: shortDescription
  if (ytData.videoDetails && ytData.videoDetails.shortDescription) {
    return ytData.videoDetails.shortDescription;
  }
  return '';
};

const generateChaptersWithAI = async (title, description, videoId, totalDuration) => {
  const openai = getOpenAIClient();
  if (!openai) return null;

  try {
    const prompt = `
You are an expert learning curriculum designer. 
I will provide you with a YouTube video title and its full description.
Your task is to parse out all timestamps and topics, and construct a structured learning roadmap.
Merge closely related micro-topics into broader cohesive chapters if necessary, but keep the exact start times for the major topics.
Ensure the output is ONLY a raw JSON array of objects.
Do not wrap it in markdown block quotes like \`\`\`json. Just the raw array.

Each object must have:
- "title": A clean, professional chapter title (e.g., "Introduction to Node.js", "Express.js Middleware")
- "start_seconds": The integer start time in seconds.

Video Title: ${title}

Video Description:
${description.substring(0, 4000)}
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    });

    let content = response.choices[0].message.content.trim();
    if (content.startsWith('\`\`\`json')) {
      content = content.replace(/^\`\`\`json/, '').replace(/\`\`\`$/, '').trim();
    } else if (content.startsWith('\`\`\`')) {
      content = content.replace(/^\`\`\`/, '').replace(/\`\`\`$/, '').trim();
    }

    const aiChapters = JSON.parse(content);
    
    if (!Array.isArray(aiChapters) || aiChapters.length < 2) {
      return null;
    }

    const chapters = aiChapters.map(ch => ({
      video_id: videoId,
      title: ch.title,
      start_seconds: parseInt(ch.start_seconds, 10) || 0
    }));

    chapters.sort((a, b) => a.start_seconds - b.start_seconds);

    const uniqueChapters = [];
    const seenTimes = new Set();
    for (const c of chapters) {
      if (!seenTimes.has(c.start_seconds)) {
        seenTimes.add(c.start_seconds);
        uniqueChapters.push(c);
      }
    }

    for (let i = 0; i < uniqueChapters.length; i++) {
      uniqueChapters[i].position = i + 1;
      if (i < uniqueChapters.length - 1) {
        uniqueChapters[i].duration_seconds = uniqueChapters[i+1].start_seconds - uniqueChapters[i].start_seconds;
      } else {
        uniqueChapters[i].duration_seconds = Math.max(900, totalDuration - uniqueChapters[i].start_seconds);
      }
      if (uniqueChapters[i].duration_seconds <= 0) {
        uniqueChapters[i].duration_seconds = 900;
      }
    }

    return uniqueChapters;
  } catch (err) {
    console.error("AI Chapter Generation failed with error:", err);
    return null;
  }
};

// ─── Single Video Metadata Ingest helper ─────────────────────────────────────
const fetchSingleVideoMetadata = async (videoId, apiKey) => {
  let title = 'YouTube Video Lesson';
  let description = 'Self-paced learning lesson.';
  let totalDuration = 1800; // 30 mins default
  
  if (apiKey) {
    try {
      const url = `https://youtube.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}&key=${apiKey}`;
      const response = await fetch(url);
      const data = await response.json();
      if (data.items && data.items.length > 0) {
        const item = data.items[0];
        title = item.snippet.title || title;
        description = item.snippet.description || description;
        if (item.contentDetails && item.contentDetails.duration) {
          totalDuration = parseISO8601Duration(item.contentDetails.duration);
        }
      }
    } catch (apiErr) {
      console.warn('Single video API call failed, falling back to Scraper', apiErr.message);
    }
  }

  // Fallback scraper if no API key or API failed
  if (!apiKey) {
    try {
      const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cookie': 'CONSENT=YES+cb.20210328-17-p0.en+FX+478;'
        }
      });
      if (response.ok) {
        const html = await response.text();
        
        const titleMatch = html.match(/<title>(.*?)<\/title>/i);
        if (titleMatch) {
          title = titleMatch[1].replace(' - YouTube', '');
        }
        const descMatch = html.match(/<meta\s+name="description"\s+content="(.*?)"/i) || html.match(/<meta\s+property="og:description"\s+content="(.*?)"/i);
        if (descMatch) {
          description = descMatch[1];
        }
      }
    } catch (err) {
      console.error('Single video scraper error:', err.message);
    }
  }

  const videos = [{
    video_id: videoId,
    title,
    duration_seconds: totalDuration,
    position: 1,
    start_seconds: 0
  }];

  return {
    title,
    description: description ? description.substring(0, 200) : '',
    thumbnail_url: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    videos
  };
};

// ─── Controller Methods ──────────────────────────────────────────────────────

exports.importPlaylist = async (req, res) => {
  const { playlistUrl, subject } = req.body;
  const userId = req.user.id;

  if (!playlistUrl) {
    return res.status(400).json({ message: 'Playlist URL is required' });
  }

  // Parse playlist ID or single video ID from URL
  let playlistId = null;
  let videoId = null;
  try {
    const listMatch = playlistUrl.match(/[&?]list=([^&]+)/);
    if (listMatch) {
      playlistId = listMatch[1];
    } else {
      const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=|shorts\/)([^#\&\?]*).*/;
      const match = playlistUrl.match(regExp);
      if (match && match[2].length === 11) {
        videoId = match[2];
      }
    }
  } catch (err) {
    console.warn('Could not parse playlist URL query params.');
  }

  try {
    let playlistData = null;
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (playlistId) {
      if (apiKey) {
        try {
          playlistData = await fetchPlaylistFromAPI(playlistId, apiKey);
          console.log('Successfully fetched playlist via YouTube Data API');
        } catch (apiErr) {
          console.warn('YouTube API call failed, falling back to Scraper', apiErr.message);
        }
      }

      if (!playlistData) {
        try {
          playlistData = await scrapeYouTubePlaylist(playlistId);
          console.log('Successfully fetched playlist via HTML Scraper');
        } catch (scrapErr) {
          console.warn('YouTube Scraper failed, falling back to Mock Course Generator', scrapErr.message);
        }
      }
    } else if (videoId) {
      playlistData = await fetchSingleVideoMetadata(videoId, apiKey);
      console.log('Successfully fetched single video metadata');
    }

    // Fail if parsing failed completely (no dummy fallbacks)
    if (!playlistData) {
      return res.status(400).json({ 
        message: 'Could not retrieve YouTube playlist or video details. Make sure the URL is valid and the content is public.' 
      });
    }

    // 1. Insert course
    const courseRes = await db.query(
      `INSERT INTO clover_courses (user_id, playlist_id, title, description, thumbnail_url, total_videos, subject)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [userId, playlistId, playlistData.title, playlistData.description, playlistData.thumbnail_url, playlistData.videos.length, subject || 'General']
    );
    const course = courseRes.rows[0];

    // 2. Insert videos
    const videosPromises = playlistData.videos.map(async (v) => {
      const videoRes = await db.query(
        `INSERT INTO clover_course_videos (course_id, video_id, title, duration_seconds, position, start_seconds)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [course.id, v.video_id, v.title, v.duration_seconds, v.position, v.start_seconds || 0]
      );
      const video = videoRes.rows[0];

      // Create default progress tracking
      await db.query(
        `INSERT INTO clover_user_video_progress (user_id, video_id, watched_seconds, notes, is_completed)
         VALUES ($1, $2, 0, '', false) ON CONFLICT DO NOTHING`,
        [userId, video.id]
      );
      return video;
    });

    const videos = await Promise.all(videosPromises);

    res.status(201).json({
      message: 'Course imported successfully!',
      course,
      videos
    });
  } catch (err) {
    console.error('Import Playlist Error:', err.message);
    res.status(500).json({ message: 'Server error importing course playlist' });
  }
};

exports.getCourses = async (req, res) => {
  const userId = req.user.id;
  try {
    const result = await db.query(
      `SELECT c.*, 
       COALESCE(COUNT(CASE WHEN p.is_completed = true THEN 1 END), 0) as completed_videos
       FROM clover_courses c
       LEFT JOIN clover_course_videos v ON v.course_id = c.id
       LEFT JOIN clover_user_video_progress p ON p.video_id = v.id AND p.user_id = $1
       WHERE c.user_id = $1
       GROUP BY c.id
       ORDER BY c.created_at ASC`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Get Courses Error:', err.message);
    res.status(500).json({ message: 'Server error retrieving courses list' });
  }
};

exports.getCourseDetails = async (req, res) => {
  const userId = req.user.id;
  const courseId = req.params.id;

  try {
    const courseRes = await db.query(
      `SELECT * FROM clover_courses WHERE id = $1 AND user_id = $2`,
      [courseId, userId]
    );

    if (courseRes.rows.length === 0) {
      return res.status(404).json({ message: 'Course not found' });
    }

    const course = courseRes.rows[0];

    const videosRes = await db.query(
      `SELECT v.*, p.watched_seconds, p.notes, p.is_completed, p.completed_at
       FROM clover_course_videos v
       LEFT JOIN clover_user_video_progress p ON p.video_id = v.id AND p.user_id = $1
       WHERE v.course_id = $2
       ORDER BY v.position ASC`,
      [userId, courseId]
    );

    res.json({
      course,
      videos: videosRes.rows
    });
  } catch (err) {
    console.error('Get Course Details Error:', err.message);
    res.status(500).json({ message: 'Server error retrieving course details' });
  }
};

exports.updateVideoProgress = async (req, res) => {
  const userId = req.user.id;
  const videoId = req.params.id;
  const { watched_seconds, notes } = req.body;

  try {
    const currentProgress = await db.query(
      `SELECT * FROM clover_user_video_progress WHERE user_id = $1 AND video_id = $2`,
      [userId, videoId]
    );

    let result;
    if (currentProgress.rows.length === 0) {
      result = await db.query(
        `INSERT INTO clover_user_video_progress (user_id, video_id, watched_seconds, notes, is_completed)
         VALUES ($1, $2, $3, $4, false) RETURNING *`,
        [userId, videoId, watched_seconds || 0, notes || '']
      );
    } else {
      result = await db.query(
        `UPDATE clover_user_video_progress
         SET watched_seconds = $1, notes = COALESCE($2, notes)
         WHERE user_id = $3 AND video_id = $4 RETURNING *`,
        [watched_seconds || 0, notes, userId, videoId]
      );
    }

    res.json({
      message: 'Video progress auto-saved',
      progress: result.rows[0]
    });
  } catch (err) {
    console.error('Update Video Progress Error:', err.message);
    res.status(500).json({ message: 'Server error saving progress' });
  }
};

exports.completeVideo = async (req, res) => {
  const userId = req.user.id;
  const videoId = req.params.id;

  try {
    // 1. Get video details
    const videoRes = await db.query(
      `SELECT v.*, c.title as course_title 
       FROM clover_course_videos v
       JOIN clover_courses c ON c.id = v.course_id
       WHERE v.id = $1`,
      [videoId]
    );

    if (videoRes.rows.length === 0) {
      return res.status(404).json({ message: 'Video record not found' });
    }

    const video = videoRes.rows[0];
    const durationHours = Number((video.duration_seconds / 3600).toFixed(2));

    // 2. Mark progress as completed
    await db.query(
      `UPDATE clover_user_video_progress
       SET is_completed = true, completed_at = CURRENT_TIMESTAMP, watched_seconds = duration_seconds
       FROM clover_course_videos
       WHERE clover_user_video_progress.video_id = clover_course_videos.id
         AND clover_user_video_progress.user_id = $1
         AND clover_user_video_progress.video_id = $2`,
      [userId, videoId]
    );

    // 3. Sync study hours with clover_attendance for today
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const attRes = await db.query(
      'SELECT id, study_hours, daily_notes FROM clover_attendance WHERE user_id = $1 AND date = $2',
      [userId, todayStr]
    );

    if (attRes.rows.length === 0) {
      // Create new attendance log for today
      const notes = `[Video Complete] Watched "${video.title}" (${Math.round(video.duration_seconds / 60)} mins) in course: "${video.course_title}".`;
      await db.query(
        `INSERT INTO clover_attendance (user_id, date, status, study_hours, daily_notes)
         VALUES ($1, $2, 'Absent', $3, $4)`,
        [userId, todayStr, durationHours, notes]
      );
    } else {
      // Increment existing study hours and append to notes
      const attendance = attRes.rows[0];
      const newHours = Number((Number(attendance.study_hours) + durationHours).toFixed(2));
      const newNotes = attendance.daily_notes 
        ? `${attendance.daily_notes} | Watched "${video.title}".` 
        : `Watched "${video.title}".`;
      
      await db.query(
        `UPDATE clover_attendance 
         SET study_hours = $1, daily_notes = $2
         WHERE id = $3`,
        [newHours, newNotes, attendance.id]
      );
    }

    // 4. Recalculate attendance stats (checks Present/Half Day/Absent thresholds and handles goal points)
    await recalculateAttendance(userId, todayStr);

    // 5. Complete matching todo checklist items
    const videoKeyword = video.title.trim().toLowerCase();
    // Complete todos that match the title of this video or "Watch [video title]"
    await db.query(
      `UPDATE clover_todos 
       SET is_completed = true, completed_at = CURRENT_TIMESTAMP 
       WHERE user_id = $1 AND is_completed = false
       AND (LOWER(title) LIKE $2 OR $3 LIKE '%' || LOWER(title) || '%')`,
      [userId, `%${videoKeyword}%`, `watch ${videoKeyword}`]
    );

    // 6. Complete matching roadmap items
    await db.query(
      `UPDATE clover_roadmap_items
       SET status = 'Completed', completed_at = CURRENT_TIMESTAMP
       WHERE associated_video_id = $1 OR title ILIKE $2`,
      [videoId, `%${videoKeyword}%`]
    );

    // 7. Generate AI Summary for concepts covered in the video
    const openai = getOpenAIClient();
    let aiSummary = '';

    if (openai) {
      try {
        const prompt = `Provide a concise concept review for a student who finished studying: "${video.title}" from the course "${video.course_title}".
        Provide a JSON response containing:
        1. "concepts": array of 3 core technical topics covered (e.g. ['Request Lifecycle', 'Next() Callback', 'Custom Error Handlers']).
        2. "summary": a markdown list of 3-4 bullet points highlighting key implementation rules.`;

        const response = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' }
        });

        const data = JSON.parse(response.choices[0].message.content);
        aiSummary = `### AI Summary: ${video.title}\n\n**Key Concepts Covered:**\n${data.concepts.map(c => `- \`${c}\``).join('\n')}\n\n**Takeaways:**\n${data.summary}`;
      } catch (aiErr) {
        console.warn('AI video summary failed, falling back to local template');
      }
    }

    if (!aiSummary) {
      // Local fallback rule-based summaries
      let keyConcepts = ['Study Session Complete', 'Video Lessons Integration'];
      let notesSummary = `*   **Self-paced learning:** Watched the video session successfully.\n*   **Progress Saved:** The duration of ${Math.round(video.duration_seconds / 60)} minutes has been credited directly to study hours.\n*   **Consistency:** Continue keeping a focused schedule to maintain study streaks.`;
      
      const titleLower = videoKeyword;
      if (titleLower.includes('middleware')) {
        keyConcepts = ['Express Middleware', 'Request-Response Cycle', 'next() Handler'];
        notesSummary = `*   **Definition:** Middleware functions execute during the lifecycle of a request to the Express server.\n*   **Execution:** Always call \`next()\` to pass control to subsequent handlers, or terminate the pipeline by sending a response.\n*   **Use Cases:** Logging, JWT token verification, CORS management, and data validators.`;
      } else if (titleLower.includes('jwt') || titleLower.includes('token') || titleLower.includes('auth')) {
        keyConcepts = ['JWT Authentication', 'Token Cryptography', 'Authorization Headers'];
        notesSummary = `*   **Token Structure:** Contains Header (algorithm), Payload (non-sensitive user claims), and Signature (secret validation key).\n*   **Transport:** Shared between client and server inside the HTTP \`Authorization\` headers in the format \`Bearer <token>\`.\n*   **Security:** Keep secrets in \`.env\` configurations and sign payloads with secure token expiration times (e.g. 1 hour).`;
      } else if (titleLower.includes('postgres') || titleLower.includes('db') || titleLower.includes('database')) {
        keyConcepts = ['PostgreSQL Connection Pool', 'SQL Relations', 'Data Constraints'];
        notesSummary = `*   **Client Pool:** Use \`pg.Pool\` to queue connection states without exhausting server memory.\n*   **Safe Insertion:** Utilize parameterized queries (e.g., \`$1, $2\`) to block SQL injection vulnerability vectors.\n*   **Relationships:** Enforce referential integrity using \`FOREIGN KEY\` mappings and handle deletions cascadingly (\`ON DELETE CASCADE\`).`;
      }

      aiSummary = `### Concept Review: ${video.title}\n\n**Key Concepts Covered:**\n${keyConcepts.map(c => `- \`${c}\``).join('\n')}\n\n**Takeaways:**\n${notesSummary}`;
    }

    // Save summary directly as the AI Summary field of today's attendance record (appends to it)
    await db.query(
      `UPDATE clover_attendance
       SET ai_summary = COALESCE(ai_summary, '') || $1
       WHERE user_id = $2 AND date = $3`,
      [`\n\n${aiSummary}`, userId, todayStr]
    );

    res.json({
      message: 'Video completed successfully! Attendance and tasks synced.',
      durationHours,
      aiSummary
    });

  } catch (err) {
    console.error('Complete Video Error:', err.message);
    res.status(500).json({ message: 'Server error registering video completion' });
  }
};

// ─── Roadmaps Feature Controllers ─────────────────────────────────────────────

// Delete Course/Classroom
exports.deleteCourse = async (req, res) => {
  const userId = req.user.id;
  const courseId = req.params.id;

  try {
    const result = await db.query(
      'DELETE FROM clover_courses WHERE id = $1 AND user_id = $2 RETURNING *',
      [courseId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Course not found or unauthorized' });
    }

    res.json({ message: 'Course deleted successfully!' });
  } catch (err) {
    console.error('Delete Course Error:', err.message);
    res.status(500).json({ message: 'Server error deleting course' });
  }
};

// ─── Custom Roadmaps Controllers ─────────────────────────────────────────────

exports.getRoadmaps = async (req, res) => {
  const userId = req.user.id;
  try {
    // Fetch user roadmaps
    const roadmapRes = await db.query(
      'SELECT * FROM clover_roadmaps WHERE user_id = $1 ORDER BY created_at ASC',
      [userId]
    );

    const roadmaps = roadmapRes.rows;

    // For each roadmap, fetch items
    const roadmapsWithItems = await Promise.all(roadmaps.map(async (rm) => {
      const itemsRes = await db.query(
        `SELECT r.*, v.title as video_title, c.title as course_title
         FROM clover_roadmap_items r
         LEFT JOIN clover_course_videos v ON v.id = r.associated_video_id
         LEFT JOIN clover_courses c ON c.id = v.course_id
         WHERE r.roadmap_id = $1
         ORDER BY r.position ASC`,
        [rm.id]
      );
      return {
        ...rm,
        items: itemsRes.rows
      };
    }));

    res.json(roadmapsWithItems);
  } catch (err) {
    console.error('Get Roadmaps Error:', err.message);
    res.status(500).json({ message: 'Server error retrieving roadmaps' });
  }
};

exports.createRoadmap = async (req, res) => {
  const userId = req.user.id;
  const { title, subject } = req.body;

  if (!title) {
    return res.status(400).json({ message: 'Roadmap title is required' });
  }

  try {
    const result = await db.query(
      'INSERT INTO clover_roadmaps (user_id, title, subject) VALUES ($1, $2, $3) RETURNING *',
      [userId, title, subject || 'General']
    );
    res.status(201).json({ ...result.rows[0], items: [] });
  } catch (err) {
    console.error('Create Roadmap Error:', err.message);
    res.status(500).json({ message: 'Server error creating roadmap' });
  }
};

exports.deleteRoadmap = async (req, res) => {
  const userId = req.user.id;
  const roadmapId = req.params.id;

  try {
    const result = await db.query(
      'DELETE FROM clover_roadmaps WHERE id = $1 AND user_id = $2 RETURNING *',
      [roadmapId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Roadmap not found or unauthorized' });
    }

    res.json({ message: 'Roadmap deleted successfully' });
  } catch (err) {
    console.error('Delete Roadmap Error:', err.message);
    res.status(500).json({ message: 'Server error deleting roadmap' });
  }
};

exports.createRoadmapItem = async (req, res) => {
  const { roadmapId, title, associatedVideoId } = req.body;

  if (!roadmapId || !title) {
    return res.status(400).json({ message: 'Roadmap ID and item title are required' });
  }

  try {
    // Enforce ownership
    const rmRes = await db.query('SELECT 1 FROM clover_roadmaps WHERE id = $1 AND user_id = $2', [roadmapId, req.user.id]);
    if (rmRes.rows.length === 0) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Get position
    const posRes = await db.query('SELECT COALESCE(MAX(position), 0) as max FROM clover_roadmap_items WHERE roadmap_id = $1', [roadmapId]);
    const nextPos = parseInt(posRes.rows[0].max) + 1;

    let status = 'Not Started';
    if (associatedVideoId) {
      const progressRes = await db.query(
        'SELECT is_completed FROM clover_user_video_progress WHERE user_id = $1 AND video_id = $2',
        [req.user.id, associatedVideoId]
      );
      if (progressRes.rows.length > 0 && progressRes.rows[0].is_completed) {
        status = 'Completed';
      } else if (progressRes.rows.length > 0) {
        status = 'In Progress';
      }
    }

    const result = await db.query(
      `INSERT INTO clover_roadmap_items (roadmap_id, title, status, associated_video_id, position)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [roadmapId, title, status, associatedVideoId || null, nextPos]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create Roadmap Item Error:', err.message);
    res.status(500).json({ message: 'Server error creating roadmap item' });
  }
};

exports.deleteRoadmapItem = async (req, res) => {
  const itemId = req.params.id;

  try {
    // Validate ownership
    const itemRes = await db.query(
      `SELECT i.id FROM clover_roadmap_items i 
       JOIN clover_roadmaps r ON r.id = i.roadmap_id 
       WHERE i.id = $1 AND r.user_id = $2`,
      [itemId, req.user.id]
    );

    if (itemRes.rows.length === 0) {
      return res.status(404).json({ message: 'Roadmap item not found or unauthorized' });
    }

    await db.query('DELETE FROM clover_roadmap_items WHERE id = $1', [itemId]);
    res.json({ message: 'Roadmap item deleted' });
  } catch (err) {
    console.error('Delete Roadmap Item Error:', err.message);
    res.status(500).json({ message: 'Server error deleting roadmap item' });
  }
};

exports.autoLinkRoadmaps = async (userId) => {
  try {
    // Get all roadmap items for this user that are not yet marked Completed
    const itemsRes = await db.query(
      `SELECT r.id, r.title, r.status, r.associated_video_id, rm.id as roadmap_id
       FROM clover_roadmap_items r
       JOIN clover_roadmaps rm ON rm.id = r.roadmap_id
       WHERE rm.user_id = $1 AND r.status != 'Completed'`,
      [userId]
    );

    const items = itemsRes.rows;
    for (const item of items) {
      const keyword = item.title.trim().toLowerCase();
      let status = item.status;
      let associatedVideoId = item.associated_video_id;

      // 1. Look for a course video matching this keyword
      const videoRes = await db.query(
        `SELECT v.id, p.is_completed
         FROM clover_course_videos v
         JOIN clover_courses c ON c.id = v.course_id
         LEFT JOIN clover_user_video_progress p ON p.video_id = v.id AND p.user_id = $1
         WHERE c.user_id = $1 AND LOWER(v.title) LIKE $2
         LIMIT 1`,
        [userId, `%${keyword}%`]
      );

      if (videoRes.rows.length > 0) {
        const video = videoRes.rows[0];
        associatedVideoId = video.id;
        if (video.is_completed) {
          status = 'Completed';
        } else {
          status = 'In Progress';
        }
      }

      // 2. Check GitHub commits cache for this keyword (e.g. commit messages containing 'jwt', 'middleware', etc.)
      try {
        const { githubCache } = require('./githubController');
        if (githubCache) {
          const cached = githubCache.get(userId);
          if (cached && cached.data && cached.data.commits) {
            const matchingCommit = cached.data.commits.find(c => 
              c.message.toLowerCase().includes(keyword)
            );
            if (matchingCommit) {
              status = 'Completed';
              console.log(`🍀 [Roadmap Auto-Complete] Marked "${item.title}" Completed via commit: "${matchingCommit.message}"`);
            }
          }
        }
      } catch (gitErr) {
        console.warn('Commit matching check failed:', gitErr.message);
      }

      // Update database status
      await db.query(
        `UPDATE clover_roadmap_items
         SET associated_video_id = $1, status = $2
         WHERE id = $3`,
        [associatedVideoId, status, item.id]
      );
    }
  } catch (err) {
    console.error('Auto Link Roadmaps Error:', err.message);
  }
};

exports.toggleRoadmapItem = async (req, res) => {
  const userId = req.user.id;
  const itemId = req.params.id;

  try {
    // 1. Fetch item and verify ownership
    const itemRes = await db.query(
      `SELECT i.*, r.user_id 
       FROM clover_roadmap_items i
       JOIN clover_roadmaps r ON r.id = i.roadmap_id
       WHERE i.id = $1 AND r.user_id = $2`,
      [itemId, userId]
    );

    if (itemRes.rows.length === 0) {
      return res.status(404).json({ message: 'Roadmap item not found or unauthorized' });
    }

    const item = itemRes.rows[0];
    const nextStatus = item.status === 'Completed' ? 'Not Started' : 'Completed';

    // 2. Update roadmap item status
    const completedAt = nextStatus === 'Completed' ? new Date() : null;
    await db.query(
      'UPDATE clover_roadmap_items SET status = $1, completed_at = $2 WHERE id = $3',
      [nextStatus, completedAt, itemId]
    );

    // 3. If there is an associated video, update its progress
    if (item.associated_video_id) {
      if (nextStatus === 'Completed') {
        // Complete the video (using the same cascading logic as completeVideo)
        
        // Mark video progress as completed
        await db.query(
          `UPDATE clover_user_video_progress
           SET is_completed = true, completed_at = CURRENT_TIMESTAMP, watched_seconds = (
             SELECT duration_seconds FROM clover_course_videos WHERE id = $1
           )
           WHERE user_id = $2 AND video_id = $1`,
          [item.associated_video_id, userId]
        );

        // Fetch video details to log study hours
        const videoRes = await db.query(
          `SELECT v.*, c.title as course_title 
           FROM clover_course_videos v
           JOIN clover_courses c ON c.id = v.course_id
           WHERE v.id = $1`,
          [item.associated_video_id]
        );

        if (videoRes.rows.length > 0) {
          const video = videoRes.rows[0];
          const durationHours = Number((video.duration_seconds / 3600).toFixed(2));
          const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

          const attRes = await db.query(
            'SELECT id, study_hours, daily_notes FROM clover_attendance WHERE user_id = $1 AND date = $2',
            [userId, todayStr]
          );

          if (attRes.rows.length === 0) {
            const notes = `[Roadmap Sync] Completed "${video.title}" in "${video.course_title}".`;
            await db.query(
              `INSERT INTO clover_attendance (user_id, date, status, study_hours, daily_notes)
               VALUES ($1, $2, 'Absent', $3, $4)`,
              [userId, todayStr, durationHours, notes]
            );
          } else {
            const attendance = attRes.rows[0];
            const newHours = Number((Number(attendance.study_hours) + durationHours).toFixed(2));
            const newNotes = attendance.daily_notes 
              ? `${attendance.daily_notes} | Completed "${video.title}" via Roadmap Sync.` 
              : `Completed "${video.title}".`;
            
            await db.query(
              `UPDATE clover_attendance SET study_hours = $1, daily_notes = $2 WHERE id = $3`,
              [newHours, newNotes, attendance.id]
            );
          }
        }
      } else {
        // Unmark video completion
        await db.query(
          `UPDATE clover_user_video_progress
           SET is_completed = false, completed_at = NULL, watched_seconds = 0
           WHERE user_id = $1 AND video_id = $2`,
          [userId, item.associated_video_id]
        );
      }
    }

    // Always recalculate attendance status for today
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    await recalculateAttendance(userId, todayStr);

    res.json({ message: 'Roadmap step status updated successfully!', status: nextStatus });
  } catch (err) {
    console.error('Toggle Roadmap Item Error:', err.message);
    res.status(500).json({ message: 'Server error updating roadmap step status' });
  }
};

exports.generateRoadmapWithAI = async (req, res) => {
  const { prompt, subject } = req.body;
  const userId = req.user.id;

  if (!prompt) {
    return res.status(400).json({ message: 'A prompt or syllabus is required.' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ message: 'OpenAI API key is not configured on the server.' });
  }

  try {
    const openai = new OpenAI({ apiKey });

    const systemMessage = `
You are an expert curriculum designer and developer roadmap builder.
The user will provide a study subject, a syllabus, or a course description.
Your job is to generate a comprehensive, structured roadmap.
Return ONLY a valid JSON object matching this schema exactly:
{
  "title": "A short, catchy title for the roadmap (e.g. Master Node.js in 30 Days)",
  "subject": "The overarching subject (e.g. Node.js, React, Python, DSA, AI/Data Science, General)",
  "steps": [
    "Generate the actual first step to learn here (e.g. Learn JavaScript Basics)",
    "Generate the actual second step here (e.g. Understand Async/Await)",
    "Generate the actual third step here... (add as many real steps as needed to make a comprehensive roadmap)"
  ]
}
Do not include any markdown formatting, backticks, or extra text. Generate REAL, HIGH-QUALITY educational steps, do not use generic placeholder text.
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
    });

    const aiText = response.choices[0].message.content.trim();
    let roadmapData;
    try {
      roadmapData = JSON.parse(aiText.replace(/```json/i, '').replace(/```/g, ''));
    } catch (parseErr) {
      console.error('Failed to parse AI JSON:', aiText);
      return res.status(500).json({ message: 'AI returned an invalid roadmap format.' });
    }

    if (!roadmapData.title || !roadmapData.steps || !Array.isArray(roadmapData.steps)) {
      return res.status(500).json({ message: 'AI returned an incomplete roadmap structure.' });
    }

    // 1. Create Roadmap
    const rmRes = await db.query(
      `INSERT INTO clover_roadmaps (user_id, title, subject)
       VALUES ($1, $2, $3) RETURNING id`,
      [userId, roadmapData.title, roadmapData.subject || subject || 'General']
    );
    const roadmapId = rmRes.rows[0].id;

    // 2. Insert steps
    for (let i = 0; i < roadmapData.steps.length; i++) {
      const stepTitle = roadmapData.steps[i];
      await db.query(
        `INSERT INTO clover_roadmap_items (roadmap_id, title, position)
         VALUES ($1, $2, $3)`,
        [roadmapId, stepTitle, i + 1]
      );
    }

    res.json({ message: 'AI Roadmap generated successfully!', roadmapId });
  } catch (err) {
    console.error('AI Roadmap Generation Error:', err.message);
    res.status(500).json({ message: 'Server error generating roadmap.' });
  }
};
