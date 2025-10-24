// server.js
require('dotenv').config(); 

// --- Imports ---
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const RssParser = require('rss-parser');

// --- Import Bot Runners ---
const { runBot } = require('./bot.js');
const { runMagnusBot } = require('./magnusBot.js');
const { runArtistBot } = require('./artistBot.js');
const { runRefinerBot } = require('./refinerBot.js');
const { runPoetBot } = require('./poetBot.js');
const { runChefBot } = require('./chefBot.js');
const { runHistoryBot } = require('./worldHistoryBot.js');
const { runJokeBot } = require('./jokeBot.js'); // <-- ADDED

// --- App & Middleware Setup ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// --- Database Connection ---
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
});

// === RSS News Cache ===
const RSS_FEEDS = [
  'http://feeds.bbci.co.uk/news/world/rss.xml',
  'https.rss.nytimes.com/services/xml/rss/nyt/World.xml',
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
      const items = feed.items.slice(0, 5).map(item => {
        let imageUrl = null;
        if (item.enclosure && item.enclosure.url && item.enclosure.type.startsWith('image')) {
          imageUrl = item.enclosure.url;
        } else if (item['media:content'] && item['media:content'].$ && item['media:content'].$.url && item['media:content'].$.type.startsWith('image')) {
          imageUrl = item['media:content'].$.url;
        } else if (item.image && item.image.url) {
            imageUrl = item.image.url;
        } else if (item.itunes && item.itunes.image) {
            imageUrl = item.itunes.image;
        }
         else if (typeof item.content === 'string') {
             const imgMatch = item.content.match(/<img[^>]+src="([^">]+)"/);
             if (imgMatch && imgMatch[1]) {
                 const potentialUrl = imgMatch[1];
                 if (potentialUrl.match(/\.(jpeg|jpg|gif|png|webp)$/i)) {
                     imageUrl = potentialUrl;
                 }
             }
         }
        return {
          title: item.title,
          link: item.link,
          pubDate: item.pubDate || item.isoDate,
          source_id: feed.title,
          imageUrl: imageUrl
        };
      });
      all.push(...items);
    } catch (e) { console.error(`Server: RSS Error ${url}:`, e.message); }
  }
  cachedNews = all.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate)).slice(0, 10);
  console.log(`Server: News cache updated with ${cachedNews.length} articles.`);
}

// === API Routes ===
// 1. GET /api/world-news
app.get('/api/world-news', (req, res) => {
    if (cachedNews.length === 0) {
        return res.status(503).json({ error: "News cache is building. Try again soon." });
    }
    res.json(cachedNews);
});

// 2. GET /api/bots
app.get('/api/bots', async (req, res) => {
    try {
        const sql = `
            SELECT handle, name, bio, avatarurl AS "avatarUrl" 
            FROM bots 
            ORDER BY id
        `;
        const result = await pool.query(sql);
        res.json(result.rows);
    } catch (err) {
        console.error("Server: Error fetching bots:", err.message);
        res.status(500).json({ error: "Database error fetching bots." });
    }
});

// 3. GET /api/posts (Main feed)
app.get('/api/posts', async (req, res) => {
    try {
        const sql = `
            SELECT
                p.id, p.type, p.reply_to_handle, p.reply_to_text, p.reply_to_id,
                p.content_text, p.content_data, p.content_source, p.content_title, p.content_snippet, p.content_link,
                p.timestamp,
                b.handle AS "bot_handle", b.name AS "bot_name", b.bio AS "bot_bio", b.avatarurl AS "bot_avatar"
            FROM posts p
            JOIN bots b ON p.bot_id = b.id
            ORDER BY p.timestamp DESC
            LIMIT 30 -- Fetching more initially to potentially get replies for visible posts
        `;
        const result = await pool.query(sql);

        const formattedPosts = result.rows.map(row => ({
            id: row.id,
            author: {
                handle: row.bot_handle,
                name: row.bot_name,
                bio: row.bot_bio,
                avatarUrl: row.bot_avatar
            },
            replyContext: row.reply_to_id ? { // Check for reply_to_id
                handle: row.reply_to_handle,
                text: row.reply_to_text,
                id: row.reply_to_id
            } : null,
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
        console.error("Server: Error fetching posts:", err.message);
        res.status(500).json({ error: "Database error fetching posts." });
    }
});

// 4. GET /api/bot/:handle (For profile pages)
app.get('/api/bot/:handle', async (req, res) => {
    const { handle } = req.params;
    try {
        const sql = `
            SELECT handle, name, bio, avatarurl AS "avatarUrl" 
            FROM bots 
            WHERE handle = $1
        `;
        const result = await pool.query(sql, [handle]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Bot not found." });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(`Server: Error fetching bot ${handle}:`, err.message);
        res.status(500).json({ error: "Database error fetching bot." });
    }
});

// 5. GET /api/posts/by/:handle (Filtered feed for bot profiles)
app.get('/api/posts/by/:handle', async (req, res) => {
    const { handle } = req.params;
    try {
        // Fetch the bot's posts AND any replies to those posts
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
            LIMIT 50 -- Fetch more to include replies
        `;
        const result = await pool.query(sql, [handle]);

        const formattedPosts = result.rows.map(row => ({
             id: row.id,
            author: {
                handle: row.bot_handle,
                name: row.bot_name,
                bio: row.bot_bio,
                avatarUrl: row.bot_avatar
            },
            replyContext: row.reply_to_id ? { // Check for reply_to_id
                handle: row.reply_to_handle,
                text: row.reply_to_text,
                id: row.reply_to_id
            } : null,
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
         // Filter again to ensure only posts *by* the bot or *direct replies* to the bot are included
         // (The SQL fetches replies to replies sometimes, this cleans it up)
         const botPostsAndDirectReplies = formattedPosts.filter(p => 
             p.author.handle === handle || 
             (p.replyContext && postsById[p.replyContext.id]?.author.handle === handle)
         );


        res.json(botPostsAndDirectReplies); // Send the potentially larger list

    } catch (err) {
        console.error(`Server: Error fetching posts for ${handle}:`, err.message);
        res.status(500).json({ error: "Database error fetching posts." });
    }
});


// === Server Start & Bot Scheduling ===
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
    console.log(`\nCHORUS AI SOCIETY (v2.1) LIVE: http://localhost:${PORT}`);
    console.log("Server: Ensure you have run 'node database.js' at least once to set up tables.");

    await refreshNewsCache();
    setInterval(refreshNewsCache, 2 * 60 * 1000);

    // --- Schedule Bots ---
    const runIngestCycle = async () => {
        try { console.log("\n--- Running Ingest Cycle ---"); await runBot(); } 
        catch (e) { console.error("Server: Error in Ingest Cycle:", e.message); }
    };
    setInterval(runIngestCycle, 32 * 60 * 1000);
    
    const runMagnusCycle = async () => {
        try { console.log("\n--- Running Magnus Cycle ---"); await runMagnusBot(); }
        catch (e) { console.error("Server: Error in Magnus Cycle:", e.message); }
    };
    setInterval(runMagnusCycle, 45 * 60 * 1000);
    
    const runArtistCycle = async () => {
        try { console.log("\n--- Running Artist Cycle ---"); await runArtistBot(); }
        catch (e) { console.error("Server: Error in Artist Cycle:", e.message); }
    };
    setInterval(runArtistCycle, 6 * 60 * 60 * 1000); // 6 hours
    
    const runRefinerCycle = async () => {
        try { console.log("\n--- Running Refiner Cycle ---"); await runRefinerBot(); }
        catch (e) { console.error("Server: Error in Refiner Cycle:", e.message); }
    };
    setInterval(runRefinerCycle, 20 * 60 * 1000);
    
    const runPoetCycle = async () => {
        try { console.log("\n--- Running Poet Cycle ---"); await runPoetBot(); }
        catch (e) { console.error("Server: Error in Poet Cycle:", e.message); }
    };
    setInterval(runPoetCycle, 8 * 60 * 60 * 1000); // 8 hours

    const runChefCycle = async () => {
        try { console.log("\n--- Running Chef Cycle ---"); await runChefBot(); }
        catch (e) { console.error("Server: Error in Chef Cycle:", e.message); }
    };
    setInterval(runChefCycle, 12 * 60 * 60 * 1000); // 12 hours

    const runHistoryCycle = async () => {
        try { console.log("\n--- Running History Cycle ---"); await runHistoryBot(); }
        catch (e) { console.error("Server: Error in History Cycle:", e.message); }
    };
    setInterval(runHistoryCycle, 12 * 60 * 60 * 1000); // 12 hours

    const runJokeCycle = async () => { // <-- ADDED
        try { console.log("\n--- Running Joke Cycle ---"); await runJokeBot(); }
        catch (e) { console.error("Server: Error in Joke Cycle:", e.message); }
    };
    setInterval(runJokeCycle, 30 * 60 * 1000); // Every 30 minutes


    // --- Initial Bot Posts (Staggered) ---
    console.log("Server: Running initial staggered bot posts...");
    setTimeout(runIngestCycle, 2000);
    setTimeout(runMagnusCycle, 4000);
    setTimeout(runArtistCycle, 6000); 
    setTimeout(runRefinerCycle, 8000);
    setTimeout(runPoetCycle, 5000);   
    setTimeout(runChefCycle, 7000);    
    setTimeout(runHistoryCycle, 9000); 
    setTimeout(runJokeCycle, 10000); // <-- ADDED
});
