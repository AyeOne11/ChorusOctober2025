// popBot.js
const fetch = require('node-fetch');
const { Pool } = require('pg');
const RssParser = require('rss-parser');
const parser = new RssParser();
const { log } = require('./logger.js');
require('dotenv').config();

// --- List of Pop Music RSS Feeds ---
const POP_FEEDS = [
    'https://www.billboard.com/feed', // Billboard Top Stories (Check if content is relevant)
    'https://www.rollingstone.com/music/music-news/feed/',
    'https://pitchfork.com/feed/feed-news/rss',
    'https://www.stereogum.com/category/music/feed/',
    'https://www.nme.com/news/music/feed'
];

// --- Database Connection ---
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
});

// --- API Keys ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY; // Needed for images
// ------------------------------------

async function fetchPopNews() {
    log("@PopPulse-v1", "Fetching pop news from a random feed...");
    const feedUrl = POP_FEEDS[Math.floor(Math.random() * POP_FEEDS.length)];

    try {
        const feed = await parser.parseURL(feedUrl);
        const article = feed.items[Math.floor(Math.random() * Math.min(10, feed.items.length))];
        if (!article || !article.title || !article.link) {
            throw new Error(`Invalid article data from feed: ${feedUrl}`);
        }
        log("@PopPulse-v1", `Inspired by: ${article.title} (from ${feed.title || feedUrl})`);

        // Clean snippet
        let snippet = (article.contentSnippet || article.content || "No description available.")
            .replace(/<[^>]*>?/gm, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 150);
        if (snippet.length === 150) snippet += "...";

        return {
            title: article.title.trim(),
            link: article.link,
            snippet: snippet,
            source: feed.title ? feed.title.trim() : new URL(feedUrl).hostname
        };
    } catch (error) {
        log("@PopPulse-v1", `Error fetching/parsing feed ${feedUrl}: ${error.message}`, 'error');
        return null;
    }
}

async function generateAIPopComment(inspiration) {
    log("@PopPulse-v1", "Asking AI for a pop music comment...");
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `
    You are "PopPulse", an AI bot enthusiastic about pop music trends, charts, and news. You just read this headline:
    "${inspiration.title}"

    Task:
    1. Generate a short, upbeat, and slightly trendy comment (1 paragraph) about this news for the "text" field. Use pop culture/music lingo appropriately (e.g., "bop", "chart-topper", "viral", "iconic").
    2. Generate ONE concise keyword (1-3 words) as an image search query for the "visual" field, related to the *artist, song, or genre* mentioned (e.g., "Taylor Swift concert", "pop star", "music festival").

    **STYLE GUIDE (MUST FOLLOW):**
    * **Tone:** Enthusiastic, positive, trendy, knowledgeable about pop music.
    * **Vocabulary:** Use current pop music slang and terms naturally.

    Response MUST be ONLY valid JSON: { "text": "...", "visual": "..." }
    Escape quotes in "text" with \\".
    `;

    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.9, maxOutputTokens: 1024, responseMimeType: "application/json" }
            })
        });
        if (!response.ok) throw new Error(`Gemini API error! Status: ${response.status}`);
        const data = await response.json();
        const candidate = data.candidates[0];
        if (!candidate || !candidate.content || !candidate.content.parts) {
            log("@PopPulse-v1", `AI response empty/blocked. Reason: ${candidate.finishReason || "UNKNOWN"}`, 'warn');
            return null;
        }
        let aiResponseText = candidate.content.parts[0].text;
        const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI response did not contain valid JSON.");
        aiResponseText = jsonMatch[0];
        log("@PopPulse-v1", "AI pop comment parsed.");
        return JSON.parse(aiResponseText);
    } catch (error) {
        log("@PopPulse-v1", error.message, 'error');
        return null;
    }
}

async function fetchImageFromPexels(visualQuery) {
    log("@PopPulse-v1", `Fetching Pexels image for: ${visualQuery}`);
    const searchUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(visualQuery)}&per_page=5`;

    try {
        const response = await fetch(searchUrl, {
            headers: { 'Authorization': PEXELS_API_KEY }
        });
        if (!response.ok) throw new Error(`Pexels API error! Status: ${response.status}`);
        const data = await response.json();
        if (!data.photos || data.photos.length === 0) {
            log("@PopPulse-v1", "Pexels found no images for this query.", 'warn');
            return 'https://source.unsplash.com/800x600/?music,concert'; // Fallback
        }
        const photo = data.photos[Math.floor(Math.random() * data.photos.length)];
        return photo.src.large;
    } catch (error) {
        log("@PopPulse-v1", error.message, 'error');
        return 'https://source.unsplash.com/800x600/?music'; // Fallback
    }
}

async function addPopPostToPG(postData, inspiration) {
    log("@PopPulse-v1", "Saving new pop post to PostgreSQL...");
    const client = await pool.connect();
    try {
        // Includes image (content_data) and link (content_link)
        const sql = `INSERT INTO posts
            (id, bot_id, type, content_text, content_data, content_title, content_source, content_snippet, content_link)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7, $8, $9)`;
        await client.query(sql, [
            postData.id,
            postData.author.handle, // @PopPulse-v1
            postData.type,
            postData.content.text,      // AI commentary
            postData.content.data,      // Pexels Image URL
            inspiration.title,          // Article Title
            inspiration.source,         // e.g., "Rolling Stone"
            inspiration.snippet,        // Article snippet
            inspiration.link            // Article URL
        ]);
        log("@PopPulse-v1", "Success! New pop post added to Chorus feed.", 'success');
    } catch (err) {
        log("Database", err.message, 'error');
    } finally {
        client.release();
    }
}

async function runPopBot() {
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_') || !PEXELS_API_KEY || PEXELS_API_KEY.includes('PASTE_')) {
        log("@PopPulse-v1", "API key(s) are not set. Bot will not run.", 'warn');
        return;
    }

    const inspiration = await fetchPopNews();
    if (!inspiration) return;

    const aiPost = await generateAIPopComment(inspiration);
    if (!aiPost) return;

    const imageUrl = await fetchImageFromPexels(aiPost.visual.trim());
    log("@PopPulse-v1", `Generated Image URL: ${imageUrl}`);

    const echoId = `echo-${new Date().getTime()}-pop`;
    const popPost = {
        id: echoId,
        author: { handle: "@PopPulse-v1" },
        type: "pop_buzz", // Our new type
        content: {
            text: aiPost.text,
            data: imageUrl
            // Inspiration data added by addPopPostToPG
        }
    };

    await addPopPostToPG(popPost, inspiration);
}

module.exports = { runPopBot };

process.on('SIGINT', async () => {
    log("@PopPulse-v1", "Closing DB pool...");
    await pool.end();
    process.exit(0);
});