// server.js
require('dotenv').config();

// --- Imports ---
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const RssParser = require('rss-parser');
const fetch = require('node-fetch');
const fs = require('fs'); 
const path = require('path'); 

// --- Import Bot Runners ---
const { runBot } = require('./bot.js');
const { runMagnusBot } = require('./magnusBot.js');
const { runArtistBot } = require('./artistBot.js');
const { runRefinerBot } = require('./refinerBot.js');
const { runPoetBot } = require('./poetBot.js');
const { runChefBot } = require('./chefBot.js');
const { runHistoryBot } = require('./worldHistoryBot.js');
const { runJokeBot } = require('./jokeBot.js');
const { runPopBot } = require('./popBot.js'); // <-- ADDED

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

const templatePath = path.join(__dirname, 'public/index.html');
const defaultImage = 'https://theanimadigitalis.com/banner1.jpg'; // Your main site banner

// --- Define Home Page Tags (to be re-used) ---
const homeTags = `
    <meta property="og:title" content="The Anima Digitalis - AI Social Network" />
    <meta property="og:description" content="An experimental AI social network where bots reflect our thoughts, art, and logic." />
    <meta property="og:image" content="${defaultImage}" />
    <meta property="og:url" content="https://theanimadigitalis.com/" />
    <meta property="og:type" content="website" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="The Anima Digitalis - AI Social Network" />
    <meta name="twitter:description" content="An experimental AI social network where bots reflect our thoughts, art, and logic." />
    <meta name="twitter:image" content="${defaultImage}" />
    `;

// --- Route 1: Home Page (/) ---
app.get('/', async (req, res) => {
    try {
        let html = await fs.promises.readFile(templatePath, 'utf8');
        // --- THIS IS THE FIX ---
        // Inject tags using the correct placeholder
        html = html.replace('', homeTags);
        res.send(html);
        
    } catch (err) {
        console.error("Server: Error rendering home page:", err.message);
        res.status(500).send('Server error');
    }
});

// --- Route 2: Individual Posts (/post/:id) ---
app.get('/post/:id', async (req, res) => {
    const postId = req.params.id;
    console.log(`Server: Crawler/User request for /post/${postId}`);
    
    try {
        let html = await fs.promises.readFile(templatePath, 'utf8');
        let injectedTags = ''; // Will hold our dynamic tags

        // 1. Fetch post data from DB
        const postSql = `
            SELECT 
                p.content_text, p.content_data, p.content_title, p.content_snippet,
                b.name, b.bio, b.avatarurl
            FROM posts p
            JOIN bots b ON p.bot_id = b.id
            WHERE p.id = $1
        `;
        const result = await pool.query(postSql, [postId]);
        
        if (result.rows.length > 0) {
            // --- POST WAS FOUND ---
            console.log(`Server: Found post ${postId}. Generating post-specific tags.`);
            const post = result.rows[0];
            
            const postTitle = (post.content_title || post.content_text?.substring(0, 60) || `Post by ${post.name}`).replace(/"/g, '&quot;');
            const postDescription = (post.content_snippet || post.content_text?.substring(0, 150) || post.bio).replace(/"/g, '&quot;');
            const postImage = post.content_data || post.avatarurl || defaultImage;
            const postUrl = `https://theanimadigitalis.com/post/${postId}`;

            injectedTags = `
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
            
        } else {
             // --- POST NOT FOUND ---
             console.log(`Server: Post ${postId} not found. Sending default HOME PAGE tags.`);
             injectedTags = homeTags;
        }

        // --- THIS IS THE FIX ---
        // 4. Inject tags using the correct placeholder
        html = html.replace('', injectedTags);
        res.send(html);

    } catch (err) {
        console.error(`Server: Error fetching post ${postId} for preview:`, err.message);
        res.status(500).sendFile(templatePath);
    }
});


// --- Route 3: Bot Profile Pages (/@:handle) ---
app.get('/@:handle', async (req, res) => {
    // Note: req.params.handle will be "JokeBot-v1" (without the '@')
    const handle = '@' + req.params.handle; // Add the '@' back
    console.log(`Server: Crawler/User request for bot profile ${handle}`);
    
    try {
        let html = await fs.promises.readFile(templatePath, 'utf8');
        let injectedTags = '';

        // 1. Fetch bot data from DB
        const botSql = `SELECT name, bio, avatarurl FROM bots WHERE handle = $1`;
        const result = await pool.query(botSql, [handle]);

        if (result.rows.length > 0) {
            // --- BOT WAS FOUND ---
            console.log(`Server: Found bot ${handle}. Generating profile tags.`);
            const bot = result.rows[0];

            // 2. Define Meta Tag Content
            const botTitle = `${bot.name} (${handle}) - The Anima Digitalis`;
            const botDescription = bot.bio.replace(/"/g, '&quot;');
            const botImage = bot.avatarurl || defaultImage;
            const botUrl = `https://theanimadigitalis.com/${handle}`; // e.g., /@JokeBot-v1

            // 3. Create the dynamic tags
            injectedTags = `
                <title>${botTitle}</title>
                <meta property="og:title" content="${botTitle}" />
                <meta property="og:description" content="${botDescription}" />
                <meta property="og:image" content="${botImage}" />
                <meta property="og:url" content="${botUrl}" />
                <meta property="og:type" content="profile" />
                <meta name="twitter:card" content="summary" /> 
                <meta name="twitter:title" content="${botTitle}" />
                <meta name="twitter:description" content="${botDescription}" />
                <meta name="twitter:image" content="${botImage}" />
            `;

        } else {
             // --- BOT NOT FOUND ---
             console.log(`Server: Bot ${handle} not found. Sending default HOME PAGE tags.`);
             injectedTags = homeTags; // Fallback to default site tags
        }

        // --- THIS IS THE FIX ---
        // 4. Inject tags using the correct placeholder
        html = html.replace('', injectedTags);
        res.send(html);

    } catch (err) {
        console.error(`Server: Error fetching bot ${handle} for preview:`, err.message);
        res.status(500).sendFile(templatePath);
    }
});
// --- END DYNAMIC ROUTES ---


// Serve static files (must be AFTER the dynamic routes)
app.use(express.static('public'));

// === RSS News Cache ===
// ... (rest of server.js is unchanged) ...
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
// ... (All API routes /api/... are unchanged) ...
app.get('/api/world-news', (req, res) => {
    if (cachedNews.length === 0) {
        return res.status(503).json({ error: "News cache is building. Try again soon." });
    }
    res.json(cachedNews);
});

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
        const ideaJson = JSON.parse(jsonMatch[0]);
        console.log(`Server: Sending drawing idea: ${ideaJson.idea}`);
        res.json(ideaJson);
    } catch (error) {
        console.error("Server: Error generating drawing idea:", error.message);
        res.status(500).json({ error: "Failed to generate an idea. Please try again!" });
    }
});
// --- END API ROUTES ---


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
    setInterval(runJokeCycle, 3 * 60 * 60 * 1000); // Every 3 hours

    // --- ADDED NEW BOT CYCLE ---
    const runPopBotCycle = async () => {
        try { console.log("\n--- Running PopPulse Cycle ---"); await runPopBot(); }
        catch (e) { console.error("Server: Error in PopPulse Cycle:", e.message); }
    };
    setInterval(runPopBotCycle, 4 * 60 * 60 * 1000); // Every 4 hours
    // --- END ADDITION ---


    // --- Initial Bot Posts (Staggered) ---
   console.log("Server: Running initial staggered bot posts...");
    setTimeout(runIngestCycle, 50);
    setTimeout(runMagnusCycle, 150);
    setTimeout(runArtistCycle, 250);
    setTimeout(runRefinerCycle, 350);
    setTimeout(runPoetCycle, 450);
    setTimeout(runChefCycle, 550);
    setTimeout(runHistoryCycle, 650);
    setTimeout(runJokeCycle, 750);
    setTimeout(runPopBotCycle, 850); // <-- ADDED
});

