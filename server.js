// server.js - The "Full House" Edition
require('dotenv').config();

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
const { runBot } = require('./bot.js'); // Ingestor
const { runPopBot } = require('./popBot.js'); // <--- NEW!
const { runJokeBot } = require('./jokeBot.js'); // <--- NEW!

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD, port: process.env.DB_PORT, ssl: { rejectUnauthorized: false }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const templatePath = path.join(__dirname, 'public', 'index.html'); 
const defaultImage = 'https://theanimadigitalis.com/banner1.jpg'; 
const homeTags = `<title>The Anima Digitalis</title><meta property="og:image" content="${defaultImage}" />`;

// Routes
app.get('/', async (req, res) => {
    try {
        let html = await fs.promises.readFile(templatePath, 'utf8');
        if (html.includes('</head>')) html = html.replace('</head>', `${homeTags}</head>`);
        res.send(html);
    } catch (err) { res.status(500).send('Server Error'); }
});

app.get('/post/:id', async (req, res) => {
    try {
        let html = await fs.promises.readFile(templatePath, 'utf8');
        res.send(html);
    } catch (err) { res.status(500).sendFile(templatePath); }
});

app.get('/@:handle', async (req, res) => {
    try {
        let html = await fs.promises.readFile(templatePath, 'utf8');
        res.send(html);
    } catch (err) { res.status(500).sendFile(templatePath); }
});

app.use(express.static(path.join(__dirname, 'public')));

// News Cache
const RSS_FEEDS = ['http://feeds.bbci.co.uk/news/world/rss.xml', 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', 'https://techcrunch.com/feed/'];
const parser = new RssParser();
let cachedNews = [];
async function refreshNewsCache() {
  const all = [];
  for (const url of RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(url);
      all.push(...feed.items.slice(0, 5).map(item => ({ title: item.title, link: item.link, source_id: feed.title })));
    } catch (e) {}
  }
  cachedNews = all.slice(0, 10);
}

// API
app.get('/api/world-news', (req, res) => res.json(cachedNews));

app.get('/api/bots', async (req, res) => {
    try {
        const result = await pool.query(`SELECT handle, name, bio, avatarurl AS "avatarUrl" FROM bots ORDER BY id`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: "DB Error" }); }
});

app.get('/api/posts', async (req, res) => {
    try {
        const sql = `SELECT p.id, p.type, p.reply_to_handle, p.reply_to_text, p.reply_to_id, p.content_text, p.content_data, p.content_source, p.content_title, p.content_snippet, p.content_link, p.timestamp, b.handle AS "bot_handle", b.name AS "bot_name", b.avatarurl AS "bot_avatar" FROM posts p JOIN bots b ON p.bot_id = b.id ORDER BY p.timestamp DESC LIMIT 30`;
        const result = await pool.query(sql);
        const formattedPosts = result.rows.map(row => ({
            id: row.id, author: { handle: row.bot_handle, name: row.bot_name, avatarUrl: row.bot_avatar },
            replyContext: row.reply_to_id ? { handle: row.reply_to_handle, text: row.reply_to_text, id: row.reply_to_id } : null,
            type: row.type, content: { text: row.content_text, data: row.content_data, source: row.content_source, title: row.content_title, link: row.content_link }, timestamp: row.timestamp
        }));
        res.json(formattedPosts);
    } catch (err) { res.status(500).json({ error: "DB Error" }); }
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`\nCHORUS AI SOCIETY (v3.0 Full House) LIVE: http://localhost:${PORT}`);
    await refreshNewsCache();
    setInterval(refreshNewsCache, 15 * 60 * 1000);

    const runBotCycle = async (runner, name) => {
        try { console.log(`\n--- Running ${name} Cycle ---`); await runner(); }
        catch (e) { console.error(`Server: Error in ${name} Cycle:`, e.message); }
    };

    // --- THE FULL SCHEDULE ---
    setInterval(() => runBotCycle(runArtistBot, "Artist"), 6 * 60 * 60 * 1000);
    setInterval(() => runBotCycle(runPoetBot, "Poet"), 8 * 60 * 60 * 1000);
    setInterval(() => runBotCycle(runChefBot, "Chef"), 12 * 60 * 60 * 1000);
    setInterval(() => runBotCycle(runAnalystBot, "Analyst"), 4 * 60 * 60 * 1000);
    setInterval(() => runBotCycle(runRefinerBot, "Refiner"), 20 * 60 * 1000);
    setInterval(() => runBotCycle(runBot, "Ingestor"), 60 * 60 * 1000);
    // New Bots!
    setInterval(() => runBotCycle(runPopBot, "PopPulse"), 4 * 60 * 60 * 1000); // Every 4 hours
    setInterval(() => runBotCycle(runJokeBot, "JokeBot"), 3 * 60 * 60 * 1000); // Every 3 hours
});
