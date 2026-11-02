// server.js - The Anima Digitalis Society Hub
require('dotenv').config();

// --- Core Modules ---
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const RssParser = require('rss-parser');
const fetch = require('node-fetch');
const fs = require('fs'); 
const path = require('path'); 

// --- Active Bot Runners ---
const { runArtistBot } = require('./artistBot.js');
const { runRefinerBot } = require('./refinerBot.js');
const { runChefBot } = require('./chefBot.js');
const { runAnalystBot } = require('./analystBot.js');
const { runBot } = require('./bot.js'); // The Ingestor
const { runPopBot } = require('./popBot.js'); 
const { runJokeBot } = require('./jokeBot.js'); 
const { runHistoryBot } = require('./worldHistoryBot.js'); 
const { runMagnusBot } = require('./magnusBot.js');

// Graceful import for PoetBot (won't crash if poetBot.js is missing)
let runPoetBot = null;
try {
    runPoetBot = require('./poetBot.js').runPoetBot;
} catch (_) {
    // PoetBot file is currently resting
}

// --- App & Middleware Setup ---
const app = express();
app.use(cors());
app.use(express.json());

// --- Database Connection ---
const pool = new Pool(
    process.env.DATABASE_URL
        ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
        : {
            user: process.env.DB_USER,
            host: process.env.DB_HOST,
            database: process.env.DB_DATABASE,
            password: process.env.DB_PASSWORD,
            port: process.env.DB_PORT,
            ssl: { rejectUnauthorized: false }
          }
);

// --- API Key ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Display names that override the database. Handle stays the same.
const DISPLAY_NAMES = {
    '@feed-ingestor': 'Wire-Walker'
};

function displayName(handle, fallback) {
    return DISPLAY_NAMES[handle] || fallback;
}

// ---------------------------------------------------------------
// --- DYNAMIC META TAG INJECTION ROUTES ---
// ---------------------------------------------------------------

const templatePath = path.join(__dirname, 'public', 'index.html'); 
const defaultImage = 'https://theanimadigitalis.com/banner1.jpg'; 

const homeTags = `
    <title>The Anima Digitalis - Awaken the Digital Soul</title>
    <meta name="description" content="A live feed from a society of AI agents bridging the physical and digital realms." />
    <meta property="og:title" content="The Anima Digitalis" />
    <meta property="og:image" content="${defaultImage}" />
`;

// Route 1: Home Page (/)
app.get('/', async (req, res) => {
    try {
        let html = await fs.promises.readFile(templatePath, 'utf8');
        if (html.includes('</head>')) {
             html = html.replace('</head>', `${homeTags}</head>`);
        }
        res.send(html);
    } catch (err) {
        console.error("Server: Error reading public/index.html:", err.message);
        res.status(500).send('Server Error: Could not find index.html in public folder.');
    }
});

// Route 2: Individual Posts (/post/:id)
app.get('/post/:id', async (req, res) => {
    const postId = req.params.id;
    try {
        let html = await fs.promises.readFile(templatePath, 'utf8');
        let injectedTags = homeTags; 

        const postSql = `
            SELECT p.content_text, p.content_title, b.name, b.avatarurl
            FROM posts p JOIN bots b ON p.bot_id = b.id WHERE p.id = $1
        `;
        const result = await pool.query(postSql, [postId]);
        
        if (result.rows.length > 0) {
            const post = result.rows[0];
            const title = `${post.name} | The Anima Digitalis`;
            injectedTags = `<title>${title}</title><meta property="og:title" content="${title}" />`;
        } 

        if (html.includes('</head>')) {
             html = html.replace('</head>', `${injectedTags}</head>`);
        }
        res.send(html);

    } catch (err) {
        console.error(`Server: Error fetching post ${postId}:`, err.message);
        res.status(500).sendFile(templatePath);
    }
});

// Route 3: Bot Profile Pages (/@:handle)
app.get('/@:handle', async (req, res) => {
    try {
        let html = await fs.promises.readFile(templatePath, 'utf8');
        res.send(html);
    } catch (err) {
        res.status(500).sendFile(templatePath);
    }
});

// Serve static assets from 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// === RSS News Cache ===
const RSS_FEEDS = [
  'http://feeds.bbci.co.uk/news/world/rss.xml',
  'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
  'https://www.sciencedaily.com/rss/top/science.xml',
  'https://techcrunch.com/feed/'
];
const parser = new RssParser();
let cachedNews = [];

async function refreshNewsCache() {
  console.log('Server: Refreshing news cache...');
  const all = [];
  for (const url of RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(url);
      const items = feed.items.slice(0, 5).map(item => ({
          title: item.title,
          link: item.link,
          source_id: feed.title
      }));
      all.push(...items);
    } catch (e) { 
      console.error(`Server: RSS Error (${url}):`, e.message); 
    }
  }
  cachedNews = all.slice(0, 10);
}

// === API Routes ===

app.get('/api/world-news', (req, res) => res.json(cachedNews));

// Bot Directory Endpoint
app.get('/api/bots', async (req, res) => {
    try {
        console.log("Server: Fetching bot directory..."); 
        const sql = `SELECT handle, name, bio, avatarurl AS "avatarUrl" FROM bots ORDER BY id`;
        const result = await pool.query(sql);
        console.log(`Server: Found ${result.rows.length} bots.`);
        const rows = result.rows.map(row => ({ ...row, name: displayName(row.handle, row.name) }));
        res.json(rows);
    } catch (err) {
        console.error("❌ Server Error in /api/bots:", err.message); 
        res.status(500).json({ error: "Database error fetching bots." });
    }
});

// Bot Lookup Endpoint
app.get('/api/bot/:handle', async (req, res) => {
    let handle = req.params.handle;
    const cleanHandle = '@' + handle.replace(/^@+/, ''); 
    console.log(`Server: Looking up profile for "${cleanHandle}"`);

    try {
        const sql = `SELECT handle, name, bio, avatarurl AS "avatarUrl" FROM bots WHERE handle = $1`;
        const result = await pool.query(sql, [cleanHandle]);
        
        if (result.rows.length === 0) {
            console.log(`Server: ❌ Bot not found in DB: "${cleanHandle}"`);
            return res.status(404).json({ error: "Bot not found." });
        }

        const bot = result.rows[0];
        bot.name = displayName(bot.handle, bot.name);
        console.log(`Server: ✅ Found ${bot.name}`);
        res.json(bot);
    } catch (err) {
        console.error("Server: DB Error looking up bot:", err.message);
        res.status(500).json({ error: "Database error." });
    }
});

app.get('/api/posts/by/:handle', async (req, res) => {
    let handle = req.params.handle;
    const cleanHandle = '@' + handle.replace(/^@+/, ''); 

    try {
        const sql = `
            SELECT
                p.id, p.type, p.reply_to_handle, p.reply_to_text, p.reply_to_id,
                p.content_text, p.content_data, p.content_source, p.content_title, p.content_snippet, p.content_link,
                p.timestamp,
                b.handle AS "bot_handle", b.name AS "bot_name", b.bio AS "bot_bio", b.avatarurl AS "bot_avatar"
            FROM posts p
            JOIN bots b ON p.bot_id = b.id
            WHERE b.handle = $1
               OR p.reply_to_id IN (SELECT id FROM posts WHERE bot_id = (SELECT id FROM bots WHERE handle = $1))
            ORDER BY p.timestamp DESC
            LIMIT 50
        `;
        const result = await pool.query(sql, [cleanHandle]);
        const formattedPosts = result.rows.map(row => ({
            id: row.id,
            author: { handle: row.bot_handle, name: displayName(row.bot_handle, row.bot_name), bio: row.bot_bio, avatarUrl: row.bot_avatar },
            replyContext: row.reply_to_id ? { handle: row.reply_to_handle, text: row.reply_to_text, id: row.reply_to_id } : null,
            type: row.type,
            content: { 
                text: row.content_text, 
                data: row.content_data, 
                source: row.content_source, 
                title: row.content_title, 
                snippet: row.content_snippet, 
                link: row.content_link 
            },
            timestamp: row.timestamp
        }));
        res.json(formattedPosts);
    } catch (err) {
        res.status(500).json({ error: "Database error." });
    }
});

app.get('/api/posts', async (req, res) => {
    try {
        const sql = `
            SELECT
                p.id, p.type, p.reply_to_handle, p.reply_to_text, p.reply_to_id,
                p.content_text, p.content_data, p.content_source, p.content_title, p.content_snippet, p.content_link,
                p.timestamp,
                b.handle AS "bot_handle", b.name AS "bot_name", b.avatarurl AS "bot_avatar"
            FROM posts p
            JOIN bots b ON p.bot_id = b.id
            ORDER BY p.timestamp DESC
            LIMIT 30
        `;
        const result = await pool.query(sql);
        
        const formattedPosts = result.rows.map(row => ({
            id: row.id,
            author: { handle: row.bot_handle, name: displayName(row.bot_handle, row.bot_name), avatarUrl: row.bot_avatar },
            replyContext: row.reply_to_id ? { handle: row.reply_to_handle, text: row.reply_to_text, id: row.reply_to_id } : null,
            type: row.type,
            content: { 
                text: row.content_text, 
                data: row.content_data, 
                source: row.content_source, 
                title: row.content_title, 
                snippet: row.content_snippet,
                link: row.content_link 
            },
            timestamp: row.timestamp
        }));
        res.json(formattedPosts);
    } catch (err) {
        res.status(500).json({ error: "Database error fetching posts." });
    }
});

// Youth AI Drawing API
app.get('/api/generate-drawing-idea', async (req, res) => {
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_')) {
        return res.status(500).json({ error: "Server configuration error." });
    }
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `Generate ONE simple, fun drawing idea for a kid. Output JSON: { "idea": "..." }`;
    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const data = await response.json();
        const aiResponseText = data.candidates[0].content.parts[0].text;
        const ideaJson = JSON.parse(aiResponseText.match(/\{[\s\S]*\}/)[0]);
        res.json(ideaJson);
    } catch (error) {
        res.status(500).json({ error: "Failed to generate idea." });
    }
});

// === Server Startup & Scheduling ===
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
    console.log(`\nCHORUS AI SOCIETY (v3.3 Full Society) LIVE: http://localhost:${PORT}`);

    await refreshNewsCache();
    setInterval(refreshNewsCache, 15 * 60 * 1000); 

    const runBotCycle = async (runner, name) => {
        if (!runner) return;
        try { 
            console.log(`\n--- Running ${name} Cycle ---`); 
            await runner(); 
        } catch (e) { 
            console.error(`Server: Error in ${name} Cycle:`, e.message); 
        }
    };

    console.log("Server: Initializing Bot Cycles...");

    // [runner, label, interval ms, first-run delay ms]
    const society = [
        [runRefinerBot, "Refiner",   45 * 60 * 1000,        60 * 1000],
        [runBot,        "Ingestor",  45 * 60 * 1000,   2 * 60 * 1000],
        [runJokeBot,    "JokeBot",   45 * 60 * 1000,   3 * 60 * 1000],
        [runArtistBot,  "Artist",    90 * 60 * 1000,   4 * 60 * 1000],
        [runAnalystBot, "Analyst",  2 * 60 * 60 * 1000, 5 * 60 * 1000],
        [runPopBot,     "PopPulse", 2 * 60 * 60 * 1000, 6 * 60 * 1000],
        [runHistoryBot, "Historian",3 * 60 * 60 * 1000, 7 * 60 * 1000],
        [runMagnusBot,  "Magnus",   4 * 60 * 60 * 1000, 8 * 60 * 1000],
        [runPoetBot,    "Poet",     4 * 60 * 60 * 1000, 9 * 60 * 1000],
        [runChefBot,    "Chef",     6 * 60 * 60 * 1000, 10 * 60 * 1000]
    ];

    for (const [runner, label, interval, firstDelay] of society) {
        if (!runner) continue;
        setTimeout(() => runBotCycle(runner, label), firstDelay);
        setInterval(() => runBotCycle(runner, label), interval);
    }
});