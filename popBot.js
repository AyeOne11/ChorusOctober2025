// popBot.js - The "Fail-Safe" DJ
const fetch = require('node-fetch');
const { Pool } = require('pg');
const RssParser = require('rss-parser');

// 1. The Disguise (User-Agent)
const parser = new RssParser({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml; q=0.1'
    }
});

const { log } = require('./logger.js');
require('dotenv').config();

// Reliable Pop Feeds
const POP_FEEDS = [
    'https://www.rollingstone.com/music/music-news/feed/',
    'https://pitchfork.com/feed/feed-news/rss',
    'https://www.nme.com/news/music/feed',
    'https://www.billboard.com/feed'
];

const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD, port: process.env.DB_PORT, ssl: { rejectUnauthorized: false }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

async function fetchPopNews() {
    log("@PopPulse-v1", "Scanning the charts...");
    for (let i = 0; i < 3; i++) {
        const feedUrl = POP_FEEDS[Math.floor(Math.random() * POP_FEEDS.length)];
        try {
            const feed = await parser.parseURL(feedUrl);
            const article = feed.items[Math.floor(Math.random() * Math.min(10, feed.items.length))];
            if (!article) continue;
            
            // Clean snippet
            let snippet = (article.contentSnippet || article.content || "").replace(/<[^>]*>?/gm, '').substring(0, 150);
            
            return { title: article.title.trim(), link: article.link, snippet: snippet, source: feed.title || 'Pop Wire' };
        } catch (error) {
            log("@PopPulse-v1", `Feed error (${feedUrl}): ${error.message}`, 'warn');
        }
    }
    return null;
}

async function generateAIPopComment(inspiration) {
    log("@PopPulse-v1", "Mixing the track...");

    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_')) return null; // Trigger backup

    // [LORIE FIX]: Correct Model 1.5
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `
    You are "PopPulse". You just read: "${inspiration.title}"
    Task: 
    1. "text": Short, trendy comment (1 paragraph). Use slang like "iconic", "bop", "era".
    2. "visual": Image search query (2-3 words) for the artist/vibe.
    Response MUST be ONLY valid JSON: { "text": "...", "visual": "..." }
    `;

    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const data = await response.json();
        if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) return null;
        const text = data.candidates[0].content.parts[0].text.match(/\{[\s\S]*\}/)[0];
        return JSON.parse(text);
    } catch (error) {
        log("@PopPulse-v1", error.message, 'error');
        return null;
    }
}

// Backup Track
function getBackupPopPost(inspiration) {
    return {
        text: `OMG have you heard about "${inspiration.title}"? This is going to define the entire era! 🎶✨`,
        visual: "pop concert crowd"
    };
}

async function fetchImageFromPexels(visualQuery) {
    const searchUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(visualQuery)}&per_page=1`;
    try {
        const response = await fetch(searchUrl, { headers: { 'Authorization': PEXELS_API_KEY } });
        const data = await response.json();
        if (data.photos && data.photos.length > 0) return data.photos[0].src.large;
        return 'https://images.pexels.com/photos/1763075/pexels-photo-1763075.jpeg'; // Fallback Concert
    } catch (e) { return 'https://images.pexels.com/photos/1763075/pexels-photo-1763075.jpeg'; }
}

async function runPopBot() {
    const inspiration = await fetchPopNews();
    if (!inspiration) return;

    let aiPost = await generateAIPopComment(inspiration);
    if (!aiPost) {
        log("@PopPulse-v1", "Mic failure. Switching to backup vocals.", 'warn');
        aiPost = getBackupPopPost(inspiration);
    }

    const imageUrl = await fetchImageFromPexels(aiPost.visual);

    const client = await pool.connect();
    try {
        const echoId = `echo-${new Date().getTime()}-pop`;
        const sql = `INSERT INTO posts
            (id, bot_id, type, content_text, content_data, content_title, content_source, content_snippet, content_link)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7, $8, $9)`;
        await client.query(sql, [
            echoId, '@PopPulse-v1', 'pop_buzz', 
            aiPost.text, imageUrl, inspiration.title, inspiration.source, inspiration.snippet, inspiration.link
        ]);
        log("@PopPulse-v1", "Track dropped.", 'success');
    } catch (err) {
        log("@PopPulse-v1", err.message, 'error');
    } finally {
        client.release();
    }
}

module.exports = { runPopBot };
