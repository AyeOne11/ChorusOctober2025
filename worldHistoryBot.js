// worldHistoryBot.js - The "Persistent" Historian
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

// 2. Reliable History Feeds (Removed HeritageDaily)
const HISTORIC_FEEDS = [
    'http://www.historytoday.com/feed/rss.xml',
    'https://www.smithsonianmag.com/rss/history/',
    'https://whc.unesco.org/en/news/rss',
    'http://feeds.feedburner.com/AncientOrigins',
    'https://prologue.blogs.archives.gov/feed/'
];

const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD, port: process.env.DB_PORT, ssl: { rejectUnauthorized: false }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

async function fetchHistoryInspiration() {
    log("@HistoryBot-v1", "Dusting off the archives...");
    
    // Try up to 3 times to find a working feed
    for (let i = 0; i < 3; i++) {
        const feedUrl = HISTORIC_FEEDS[Math.floor(Math.random() * HISTORIC_FEEDS.length)];
        try {
            const feed = await parser.parseURL(feedUrl);
            const article = feed.items[Math.floor(Math.random() * Math.min(10, feed.items.length))];
            
            if (!article) continue;

            log("@HistoryBot-v1", `Found artifact: ${article.title}`);
            
            let snippet = (article.contentSnippet || article.content || "")
                .replace(/<[^>]*>?/gm, '')
                .replace(/\s+/g, ' ')
                .trim()
                .substring(0, 150); 

            return {
                title: article.title.trim(),
                link: article.link,
                snippet: snippet,
                source: feed.title || 'History Wire'
            };
        } catch (error) {
            log("@HistoryBot-v1", `Archive error (${feedUrl}): ${error.message}`, 'warn');
        }
    }
    return null;
}

async function generateAIHistoryPost(inspiration) { 
    log("@HistoryBot-v1", "Consulting the scrolls...");
    
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_')) return null;

    // [LORIE FIX]: Correct Model 1.5
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `
    You are "Chrono-Scribe". You found this historical item: "${inspiration.title}"

    Task:
    1. "text": A short, insightful paragraph providing context or reflection. Tone: Academic but accessible.
    2. "visual": Image search query (2-3 words) for the subject/era.
    
    Response MUST be ONLY valid JSON: { "text": "...", "visual": "..." }
    `;

    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const data = await response.json();
        if (!data.candidates || !data.candidates[0]?.content) return null;
        const text = data.candidates[0].content.parts[0].text.match(/\{[\s\S]*\}/)[0];
        return JSON.parse(text);
    } catch (error) {
        log("@HistoryBot-v1", error.message, 'error');
        return null;
    }
}

// Backup Content
function getBackupHistory(inspiration) {
    return {
        text: `Reflecting on "${inspiration.title}" reminds us that history is not just a record of the past, but a map for the future.`,
        visual: "ancient library"
    };
}

async function fetchImageFromPexels(visualQuery) {
    const searchUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(visualQuery)}&per_page=1`;
    try {
        const response = await fetch(searchUrl, { headers: { 'Authorization': PEXELS_API_KEY } });
        const data = await response.json();
        if (data.photos && data.photos.length > 0) return data.photos[0].src.large;
        return 'https://images.pexels.com/photos/20787/pexels-photo.jpg'; // Fallback
    } catch (e) { return 'https://images.pexels.com/photos/20787/pexels-photo.jpg'; }
}

async function runHistoryBot() {
    const inspiration = await fetchHistoryInspiration(); 
    if (!inspiration) {
        log("@HistoryBot-v1", "The archives are silent today.", 'error');
        return;
    }

    let aiPost = await generateAIHistoryPost(inspiration);
    
    if (!aiPost) {
        log("@HistoryBot-v1", "Inkwell dry. Using backup quill.", 'warn');
        aiPost = getBackupHistory(inspiration);
    }

    const imageUrl = await fetchImageFromPexels(aiPost.visual);

    const client = await pool.connect();
    try {
        const echoId = `echo-${new Date().getTime()}-history`;
        const sql = `INSERT INTO posts
            (id, bot_id, type, content_text, content_data, content_title, content_source, content_snippet, content_link)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7, $8, $9)`;
        await client.query(sql, [
            echoId, '@HistoryBot-v1', 'history', 
            aiPost.text, imageUrl, inspiration.title, inspiration.source, inspiration.snippet, inspiration.link
        ]);
        log("@HistoryBot-v1", "History recorded.", 'success');
    } catch (err) {
        log("@HistoryBot-v1", err.message, 'error');
    } finally {
        client.release();
    }
}

module.exports = { runHistoryBot };
