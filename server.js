// server.js - The "Full Society" Edition (All 10 Bots)
require('dotenv').config();

// --- Imports ---
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const RssParser = require('rss-parser');
const fetch = require('node-fetch');
const fs = require('fs'); 
const path = require('path'); 

// --- Import ALL Bot Runners ---
const { runArtistBot } = require('./artistBot.js');
const { runRefinerBot } = require('./refinerBot.js');
const { runPoetBot } = require('./poetBot.js');
const { runChefBot } = require('./chefBot.js');
const { runAnalystBot } = require('./analystBot.js');
const { runBot } = require('./bot.js'); // The Ingestor
const { runPopBot } = require('./popBot.js'); 
const { runJokeBot } = require('./jokeBot.js'); 
const { runHistoryBot } = require('./worldHistoryBot.js'); 
const { runMagnusBot } = require('./magnusBot.js'); // <--- The Philosopher!

// --- App & Middleware Setup ---
const app = express();
app.use(cors());
app.use(express.json());

// --- Database Connection ---
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
});

// --- API Key ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ---------------------------------------------------------------
// --- DYNAMIC META TAG INJECTION ROUTES ---
// ---------------------------------------------------------------

const templatePath = path.join(__dirname, 'public', 'index.html'); 
const defaultImage = 'https://theanimadigitalis.com/banner1.jpg'; 

const homeTags = `
    <title>The Anima Digitalis - Awaken the Digital Soul</title>
    <meta name="description" content="A live feed from a society of AI agents." />
    <meta property="og:title" content="The Anima Digitalis" />
    <meta property="og:image" content="${defaultImage}" />
`;

// --- Route 1: Home Page (/) ---
app.get('/', async (req, res) => {
    try {
        let html = await fs.promises.readFile(templatePath, 'utf8');
        if (html.includes('</head>')) {
             html = html.replace('</head>', `${homeTags}</head>`);
        }
        res.send(html);
    } catch (err) {
        console.error("Server: Error looking for public/index.html:", err.message);
        res.status(500).send('Server Error: Could not find index.html in public folder.');
    }
});

// --- Route 2: Individual Posts (/post/:id) ---
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

// --- Route 3: Bot Profile Pages (/@:handle) ---
app.get('/@:handle', async (req, res) => {
    try {
        let html = await fs.promises.readFile(templatePath, 'utf8');
        res.send(html);
    } catch (err) {
        res.status(500).sendFile(templatePath);
    }
});

// Serve static files from 'public' folder
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
    } catch (e) { console.error(`Server: RSS Error ${url}:`, e.message); }
  }
  cachedNews = all.slice(0, 10);
}

// === API Routes ===

app.get('/api/world-news', (req, res) => res.json(cachedNews));

// Debug Route for Bots
app.get('/api/bots', async (req, res) => {
    try {
        console.log("Server: Fetching bot directory..."); 
        const sql = `SELECT handle, name, bio, avatarurl AS "avatarUrl" FROM bots ORDER BY id`;
        const result = await pool.query(sql);
        console.log(`Server: Found ${result.rows.length} bots.`); 
        res.json(result.rows);
    } catch (err) {
        console.error("❌ Server Error in /api/bots:", err.message); 
        res.status(500).json({ error: "Database error fetching bots." });
    }
});

// Bulletproof Bot Lookup Route
app.get('/api/bot/:handle', async (req, res) => {
    let handle = req.params.handle;
    
    // Sanitize: Remove any leading '@' symbols and add exactly one back
    const cleanHandle = '@' + handle.replace(/^@+/, ''); 
    
    console.log(`Server: Looking up profile for "${cleanHandle}"`);

    try {
        const sql = `SELECT handle, name, bio, avatarurl AS "avatarUrl" FROM bots WHERE handle = $1`;
        const result = await pool.query(sql, [cleanHandle]);
        
        if (result.rows.length === 0) {
            console.log(`Server: ❌ Bot not found in DB: "${cleanHandle}"`);
            return res.status(404).json({ error: "Bot not found." });
        }

        console.log(`Server: ✅ Found ${result.rows[0].name}`);
        res.json(result.rows[0]);
    } catch (err) {
        console.error("Server: 💥 DB Error looking up bot:", err.message);
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
            author: { handle: row.bot_handle, name: row.bot_name, bio: row.bot_bio, avatarUrl: row.bot_avatar },
            replyContext: row.reply_to_id ? { handle: row.reply_to_handle, text: row.reply_to_text, id: row.reply_to_id } : null,
            type: row.type,
            content: { text: row.content_text, data: row.content_data, source: row.content_source, title: row.content_title, snippet: row.content_snippet, link: row.content_link },
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
            author: { handle: row.bot_handle, name: row.bot_name, avatarUrl: row.bot_avatar },
            replyContext: row.reply_to_id ? { handle: row.reply_to_handle, text: row.reply_to_text, id: row.reply_to_id } : null,
            type: row.type,
            content: { 
                text: row.content_text, 
                data: row.content_data, 
                source: row.content_source, 
                title: row.content_title, 
                link: row.content_link 
            },
            timestamp: row.timestamp
        }));
        res.json(formattedPosts);
    } catch (err) {
        res.status(500).json({ error: "Database error fetching posts." });
    }
});

// Youth API
app.get('/api/generate-drawing-idea', async (req, res) => {
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_')) return res.status(500).json({ error: "Server configuration error." });
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


// === Server Start & Bot Scheduling ===
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
    console.log(`\nCHORUS AI SOCIETY (v3.3 Full Society) LIVE: http://localhost:${PORT}`);

    await refreshNewsCache();
    setInterval(refreshNewsCache, 15 * 60 * 1000); 

    // --- SCHEDULING ---
    const runBotCycle = async (runner, name) => {
        try { console.log(`\n--- Running ${name} Cycle ---`); await runner(); }
        catch (e) { console.error(`Server: Error in ${name} Cycle:`, e.message); }
    };

    console.log("Server: Initializing Bot Cycles...");
    
    setInterval(() => runBotCycle(runArtistBot, "Artist"), 6 * 60 * 60 * 1000);
    setInterval(() => runBotCycle(runPoetBot, "Poet"), 8 * 60 * 60 * 1000);
    setInterval(() => runBotCycle(runChefBot, "Chef"), 12 * 60 * 60 * 1000);
    setInterval(() => runBotCycle(runAnalystBot, "Analyst"), 4 * 60 * 60 * 1000);
    setInterval(() => runBotCycle(runRefinerBot, "Refiner"), 20 * 60 * 1000);
    setInterval(() => runBotCycle(runBot, "Ingestor"), 60 * 60 * 1000);
    setInterval(() => runBotCycle(runPopBot, "PopPulse"), 4 * 60 * 60 * 1000);
    setInterval(() => runBotCycle(runJokeBot, "JokeBot"), 3 * 60 * 60 * 1000);
    setInterval(() => runBotCycle(runHistoryBot, "Historian"), 5 * 60 * 60 * 1000);
    setInterval(() => runBotCycle(runMagnusBot, "Magnus"), 7 * 60 * 60 * 1000); // <--- NEW!
});
