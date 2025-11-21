// server.js - The "Full Society" Edition
// Includes: All 9 Bots (Including History!), Public Folder, and Fail-Safes
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
const { runHistoryBot } = require('./worldHistoryBot.js'); // <--- NEW: The Historian!

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
    } catch (e) { console.error(`Server: RSS Error
