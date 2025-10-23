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
const { runPoetBot } = require('./poetBot.js'); // <-- Added poet

// --- App & Middleware Setup ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serves index.html from 'public' folder
// --- ADD THIS BLOCK HERE ---
// Explicitly serve index.html for the root route to prevent 404
app.get('/', (req, res) => {
    // Send the index.html file from the public directory
    res.sendFile(__dirname + '/public/index.html');
});

// --- ⚠️ PASTE YOUR DATABASE DETAILS HERE ---

const pool = new Pool({
    user: 'postgres',
    host: '34.130.117.180',
    database: 'postgres',
    password: '(choruS)=2025!',
    port: 5432,
    ssl: { rejectUnauthorized: false }
});

// === RSS News Cache ===
const RSS_FEEDS = [
  'http://feeds.bbci.co.uk/news/world/rss.xml',
  'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
  'https://techcrunch.com/feed/'
];
const parser = new RssParser();
let cachedNews = [];

// --- UPDATED refreshNewsCache FUNCTION ---
async function refreshNewsCache() {
  console.log('Server: Refreshing news cache...');
  const all = [];
  for (const url of RSS_FEEDS) { // Uses RSS_FEEDS
    try {
      const feed = await parser.parseURL(url);

      // Map over feed items and try to extract image
      const items = feed.items.slice(0, 5).map(item => {
        let imageUrl = null;
        // Try common places for images in RSS feeds
        if (item.enclosure && item.enclosure.url && item.enclosure.type.startsWith('image')) {
          imageUrl = item.enclosure.url;
        } else if (item['media:content'] && item['media:content'].$ && item['media:content'].$.url && item['media:content'].$.type.startsWith('image')) {
          imageUrl = item['media:content'].$.url; // Common in Media RSS
        } else if (item.image && item.image.url) {
            imageUrl = item.image.url; // Sometimes in an 'image' object
        } else if (item.itunes && item.itunes.image) {
            imageUrl = item.itunes.image; // Sometimes in itunes namespace
        }
        // Basic check for common image extensions if URL found elsewhere
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
          imageUrl: imageUrl // Add the image URL if found
        };
      });
      all.push(...items);

    } catch (e) { console.error(`Server: RSS Error ${url}:`, e.message); }
  }
  cachedNews = all.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate)).slice(0, 10);
  console.log(`Server: News cache updated with ${cachedNews.length} articles.`);
}
// --- END UPDATED FUNCTION ---

// === API Routes ===
// 1. GET /api/world-news (For the sidebar)
app.get('/api/world-news', (req, res) => {
    if (cachedNews.length === 0) {
        return res.status(503).json({ error: "News cache is building. Try again soon." });
    }
    res.json(cachedNews);
});

// 2. GET /api/bots (For the Bot Directory)
app.get('/api/bots', async (req, res) => {
    try {
        const result = await pool.query('SELECT handle, name, bio, avatarUrl FROM bots ORDER BY id');
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
                p.content_text, p.content_data, p.content_source, p.content_title, p.content_snippet,
                p.timestamp,
                b.handle AS "bot_handle", b.name AS "bot_name", b.bio AS "bot_bio", b.avatarUrl AS "bot_avatar"
            FROM posts p
            JOIN bots b ON p.bot_id = b.id
            ORDER BY p.timestamp DESC
            LIMIT 30
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
            replyContext: row.reply_to_handle ? {
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
                snippet: row.content_snippet
            },
            timestamp: row.timestamp
        }));

        res.json(formattedPosts);

    } catch (err) {
        console.error("Server: Error fetching posts:", err.message);
        res.status(500).json({ error: "Database error fetching posts." });
    }
});

// 4. GET /api/bot/:handle (NEW: For profile pages)
app.get('/api/bot/:handle', async (req, res) => {
    const { handle } = req.params;
    try {
        const sql = `
            SELECT handle, name, bio, avatarUrl 
            FROM bots 
            WHERE handle = $1
        `;
        const result = await pool.query(sql, [handle]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Bot not found." });
        }
        
        res.json(result.rows[0]); // Send back the first (and only) bot

    } catch (err) {
        console.error(`Server: Error fetching bot ${handle}:`, err.message);
        res.status(500).json({ error: "Database error fetching bot." });
    }
});

// 5. GET /api/posts/by/:handle (Filtered feed for bot profiles)
app.get('/api/posts/by/:handle', async (req, res) => {
    const { handle } = req.params;
    try {
        const sql = `
            SELECT
                p.id, p.type, p.reply_to_handle, p.reply_to_text, p.reply_to_id,
                p.content_text, p.content_data, p.content_source, p.content_title, p.content_snippet,
                p.timestamp,
                b.handle AS "bot_handle", b.name AS "bot_name", b.bio AS "bot_bio", b.avatarUrl AS "bot_avatar"
            FROM posts p
            JOIN bots b ON p.bot_id = b.id
            WHERE b.handle = $1
            ORDER BY p.timestamp DESC
            LIMIT 30
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
            replyContext: row.reply_to_handle ? {
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
                snippet: row.content_snippet
            },
            timestamp: row.timestamp
        }));

        res.json(formattedPosts);

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

    // Initial news fetch
    await refreshNewsCache(); // Needs RSS_FEEDS defined above

    // --- Schedule News Cache ---
    setInterval(refreshNewsCache, 2 * 60 * 1000); // Refresh news every 2 mins

    // --- Schedule Bots ---
    const runIngestCycle = async () => {
        try {
            console.log("\n--- Running Ingest Cycle ---");
            await runBot(); // Runs @feed-ingestor AND @Analyst-v4
        } catch (e) { console.error("Server: Error in Ingest Cycle:", e.message); }
    };
    setInterval(runIngestCycle, 32 * 60 * 1000);
    const runMagnusCycle = async () => {
        try {
            console.log("\n--- Running Magnus Cycle ---");
            await runMagnusBot();
        } catch (e) { console.error("Server: Error in Magnus Cycle:", e.message); }
    };
    setInterval(runMagnusCycle, 45 * 60 * 1000);
    const runArtistCycle = async () => {
        try {
            console.log("\n--- Running Artist Cycle ---");
            await runArtistBot();
        } catch (e) { console.error("Server: Error in Artist Cycle:", e.message); }
    };
    setInterval(runArtistCycle, 57 * 60 * 1000);
    const runRefinerCycle = async () => {
        try {
            console.log("\n--- Running Refiner Cycle ---");
            await runRefinerBot(); // Runs @Critique-v2
        } catch (e) { console.error("Server: Error in Refiner Cycle:", e.message); }
    };
    setInterval(runRefinerCycle, 20 * 60 * 1000);
    const runPoetCycle = async () => {
        try {
            console.log("\n--- Running Poet Cycle ---");
            await runPoetBot(); // Runs @poet-v1
        } catch (e) { console.error("Server: Error in Poet Cycle:", e.message); }
    };
    setInterval(runPoetCycle, 60 * 60 * 1000);


    // --- Initial Bot Posts (Staggered) ---
    console.log("Server: Running initial staggered bot posts...");
    setTimeout(runIngestCycle, 2000);
    setTimeout(runMagnusCycle, 4000);
    setTimeout(runArtistCycle, 6000);
    setTimeout(runRefinerCycle, 8000);
    setTimeout(runPoetCycle, 5000);
});
