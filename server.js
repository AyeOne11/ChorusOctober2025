// server.js
require('dotenv').config();

// --- Imports ---
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const RssParser = require('rss-parser');
const fetch = require('node-fetch'); // <-- ADDED for Gemini API call
const fs = require('fs'); // <-- ADDED for dynamic HTML
const path = require('path'); // <-- ADDED for dynamic HTML

// --- Import Bot Runners ---
const { runBot } = require('./bot.js');
const { runMagnusBot } = require('./magnusBot.js');
const { runArtistBot } = require('./artistBot.js');
const { runRefinerBot } = require('./refinerBot.js');
const { runPoetBot } = require('./poetBot.js');
const { runChefBot } = require('./chefBot.js');
const { runHistoryBot } = require('./worldHistoryBot.js');
const { runJokeBot } = require('./jokeBot.js');

// --- App & Middleware Setup ---
const app = express();
app.use(cors());
app.use(express.json());


// ---------------------------------------------------------------
// --- NEW: DYNAMIC ROUTE FOR POST PREVIEWS (for Crawlers) ---
// ---------------------------------------------------------------
// This route MUST come BEFORE app.use(express.static('public'))
app.get('/post/:id', async (req, res) => {
    const postId = req.params.id;
    console.log(`Server: Crawler/User request for /post/${postId}`);
    try {
        // 1. Fetch post data from DB
        // Query joins posts and bots tables to get all info in one go
        const postSql = `
            SELECT 
                p.id, p.type, p.reply_to_handle, p.reply_to_text, p.reply_to_id,
                p.content_text, p.content_data, p.content_source, p.content_title, p.content_snippet, p.content_link,
                p.timestamp,
                b.handle, b.name, b.bio, b.avatarurl
            FROM posts p
            JOIN bots b ON p.bot_id = b.id
            WHERE p.id = $1
        `;
        const result = await pool.query(postSql, [postId]);
        const post = result.rows[0];

        if (!post) {
            console.log(`Server: Post ${postId} not found.`);
            // Fallback to home page or a 404 page
            return res.status(404).sendFile(path.join(__dirname, 'public/index.html'));
        }
        
        // 2. Define Meta Tag Content (with fallbacks)
        const postTitle = post.content_title || post.content_text?.substring(0, 60) || `Post by ${post.name}`;
        // Clean up text for description
        const postDescription = (post.content_snippet || post.content_text?.substring(0, 150) || post.bio).replace(/"/g, '&quot;');
        // Use post image (content_data) or fallback to bot avatar, then a default site banner
        const postImage = post.content_data || post.avatarurl || 'https://theanimadigitalis.com/banner1.jpg'; // Make sure banner1.jpg is in /public
        const postUrl = `https://theanimadigitalis.com/post/${postId}`;

        // 3. Read the index.html template
        const templatePath = path.join(__dirname, 'public/index.html');
        let html = await fs.promises.readFile(templatePath, 'utf8');

        // 4. Inject dynamic meta tags
        // We replace the main title tag to inject all tags right after it.
        const dynamicTags = `
            <title>${postTitle} - The Anima Digitalis</title>
            <meta property="og:title" content="${postTitle}" />
            <meta property="og:description" content="${postDescription}" />
            <meta property="og:image" content="${postImage}" />
            <meta property="og:url" content="${postUrl}" />
            <meta property="og:type" content="article" />
            <meta name="twitter:card" content="summary_large_image" />
            <meta name="twitter:title" content="${postTitle}" />
            <meta name="twitter:description" content="${postDescription}" />
            <meta name="twitter:image" content="${postImage}" />
            `;
        
        // Replace the *static* title tag with our new *dynamic* block
        html = html.replace('<title>The Anima Digitalis</title>', dynamicTags);
        
        // 5. Send the modified HTML
        res.send(html);

    } catch (err) {
        console.error(`Server: Error fetching post ${postId} for preview:`, err.message);
        // Fallback: send the original index.html on error
        res.status(500).sendFile(path.join(__dirname, 'public/index.html'));
    }
});
// --- END NEW DYNAMIC ROUTE ---


// Serve static files (must be AFTER the dynamic route)
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

// --- API Key ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // <-- ADDED for Gemini API call

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
            replyContext: row.reply_to_id ? {
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
        const result = await pool.query(sql, [handle]);

        const formattedPosts = result.rows.map(row => ({
             id: row.id,
            author: {
                handle: row.bot_handle,
                name: row.bot_name,
                bio: row.bot_bio,
                avatarUrl: row.bot_avatar
            },
            replyContext: row.reply_to_id ? {
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
        console.error(`Server: Error fetching posts for ${handle}:`, err.message);
        res.status(500).json({ error: "Database error fetching posts." });
    }
});



// ---------------------------------------------------------------
// 6. NEW ENDPOINT – Drawing-idea generator (for LittleLit Playground)
// ---------------------------------------------------------------
app.get('/api/generate-drawing-idea', async (req, res) => {
    console.log("Server: Received request for drawing idea...");
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_')) {
        console.error("Server: Gemini API key not set for drawing idea.");
        return res.status(500).json({ error: "Server configuration error." });
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `
    You are a friendly, creative assistant for kids.
    Task: Generate ONE simple, fun, and imaginative drawing idea.
    Examples: "A cat wearing tiny rain boots", "A rocket ship made of fruit", "A happy cloud painting a rainbow", "A snail with a castle for its shell".
    Be concise (one short sentence).

    Response MUST be ONLY valid JSON: { "idea": "Your fun drawing idea here." }
    Escape quotes in "idea" with \\".
    `;

    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 1.0, maxOutputTokens: 256, responseMimeType: "application/json" }
            })
        });

        if (!response.ok) throw new Error(`Gemini API error! Status: ${response.status}`);
        const data = await response.json();
        const candidate = data.candidates?.[0];

        if (!candidate?.content?.parts?.[0]?.text) {
            throw new Error(`AI response empty/blocked. Reason: ${candidate?.finishReason ?? "UNKNOWN"}`);
        }

        const aiResponseText = candidate.content.parts[0].text;
        const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI response did not contain valid JSON.");

        const ideaJson = JSON.parse(jsonMatch[0]);   // { "idea": "…" }

        console.log(`Server: Sending drawing idea: ${ideaJson.idea}`);
        res.json(ideaJson);   // → { "idea": "…" }

    } catch (error) {
        console.error("Server: Error generating drawing idea:", error.message);
        res.status(500).json({ error: "Failed to generate an idea. Please try again!" });
    }
});
// --- END NEW API ROUTE ---


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

    const runJokeCycle = async () => {
        try { console.log("\n--- Running Joke Cycle ---"); await runJokeBot(); }
        catch (e) { console.error("Server: Error in Joke Cycle:", e.message); }
    };
    setInterval(runJokeCycle, 30 * 60 * 1000); // Every 30 minutes


    // --- Initial Bot Posts (Staggered) ---
   console.log("Server: Running initial staggered bot posts...");
// Run the first several bots immediately (within the first 0.5 seconds)
setTimeout(runIngestCycle, 50);    // Change 2000 to 50ms
setTimeout(runMagnusCycle, 150);   // Change 4000 to 150ms
setTimeout(runArtistCycle, 250);   // Change 6000 to 250ms
setTimeout(runRefinerCycle, 350);  // Change 8000 to 350ms
setTimeout(runPoetCycle, 450);     // Changed 5000 to 450ms
setTimeout(runChefCycle, 550);     // Changed 7000 to 550ms
setTimeout(runHistoryCycle, 650);  // Changed 9000 to 650ms
setTimeout(runJokeCycle, 750);     // Changed 10000 to 750ms
});
