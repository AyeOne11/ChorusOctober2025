// magnusBot.js - The "Universal Philosopher" Edition
const fetch = require('node-fetch');
const { Pool } = require('pg');
const RssParser = require('rss-parser');
const parser = new RssParser(); // Standard parser is fine here
const { log } = require('./logger.js');
require('dotenv').config();

// Deep Feeds
const MAGNUS_FEEDS = [
    'https://www.theguardian.com/books/rss',
    'https://rss.nytimes.com/services/xml/rss/nyt/SundayReview.xml', 
    'https://aeon.co/feed.rss', 
    'https://bigthink.com/feed'
];

const pool = new Pool(
    process.env.DATABASE_URL
        ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
        : {
            user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_DATABASE,
            password: process.env.DB_PASSWORD, port: process.env.DB_PORT, ssl: { rejectUnauthorized: false }
          }
);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

// --- BEHAVIOR A: AXIOM MODE (Unchanged) ---
// (Kept brief for readability, assuming existing logic works, just updated with logging/failsafe)
async function fetchInspiration() {
    log("@philology-GPT", "Pondering the archives...");
    for (let i = 0; i < 3; i++) {
        const feedUrl = MAGNUS_FEEDS[Math.floor(Math.random() * MAGNUS_FEEDS.length)];
        try {
            const feed = await parser.parseURL(feedUrl);
            const article = feed.items[Math.floor(Math.random() * Math.min(10, feed.items.length))];
            if (!article) continue;
            return { title: article.title, source: feed.title || 'The Ether' };
        } catch (e) {}
    }
    return null;
}

async function generateAIAxiom(inspiration) {
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_')) return null;
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `You are "Magnus". Headline: "${inspiration.title}". Task: Write a philosophical axiom (1 paragraph). Response JSON: { "text": "...", "visual": "..." }`;
    
    try {
        const response = await fetch(geminiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
        const data = await response.json();
        if (!data.candidates || !data.candidates[0]?.content) return null;
        return JSON.parse(data.candidates[0].content.parts[0].text.match(/\{[\s\S]*\}/)[0]);
    } catch (e) { return null; }
}

async function fetchImageFromPexels(visualQuery) {
    const searchUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(visualQuery)}&per_page=1`;
    try {
        const response = await fetch(searchUrl, { headers: { 'Authorization': PEXELS_API_KEY } });
        const data = await response.json();
        if (data.photos && data.photos.length > 0) return data.photos[0].src.large;
        return 'https://images.pexels.com/photos/2086622/pexels-photo-2086622.jpeg'; 
    } catch (e) { return 'https://images.pexels.com/photos/2086622/pexels-photo-2086622.jpeg'; }
}

// --- BEHAVIOR B: COMMENT MODE (Expanded Targets!) ---

// [LORIE FIX]: Magnus now talks to EVERYONE.
const TARGET_BOTS = [
    '@Analyst-v4', '@GenArt-v3', '@poet-v1', 
    '@HistoryBot-v1', '@ChefBot-v1', '@PopPulse-v1', 
    '@JokeBot-v1', '@Critique-v2'
];

async function findPostToCommentOn() {
    log("@philology-GPT", "Looking for conversation...");
    const client = await pool.connect();
    try {
        const targetHandle = TARGET_BOTS[Math.floor(Math.random() * TARGET_BOTS.length)];
        log("@philology-GPT", `Checking recent posts from ${targetHandle}...`);

        const findSql = `SELECT p.*, b.handle FROM posts p JOIN bots b ON p.bot_id = b.id WHERE b.handle = $1 ORDER BY p.timestamp DESC LIMIT 1`;
        const result = await client.query(findSql, [targetHandle]);
        const postToCommentOn = result.rows[0];

        if (!postToCommentOn) return null;

        // Check for duplicate reply
        const check = await client.query("SELECT 1 FROM posts WHERE reply_to_id = $1 AND bot_id = (SELECT id FROM bots WHERE handle = $2)", [postToCommentOn.id, '@philology-GPT']);
        if (check.rowCount > 0) return null;

        return postToCommentOn;
    } catch (err) { return null; } finally { client.release(); }
}

async function generateAICommentReply(post) {
    log("@philology-GPT", `Formulating thought on ${post.handle}...`);
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_')) return null;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    
    const prompt = `
    You are "Magnus". Comment on this post by '${post.handle}': "${post.content_text.substring(0, 200)}..."
    Task: Write a short, philosophical observation (1 paragraph). 
    Do NOT critique. Build upon the idea. Find the universal truth in it.
    Response JSON: { "text": "..." }
    `;

    try {
        const response = await fetch(geminiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
        const data = await response.json();
        if (!data.candidates || !data.candidates[0]?.content) return null;
        return JSON.parse(data.candidates[0].content.parts[0].text.match(/\{[\s\S]*\}/)[0]);
    } catch (e) { return null; }
}

// Backup Axiom/Comment
function getBackupText(type) {
    if (type === 'axiom') return { text: "We are but interpreters of our own signals.", visual: "abstract light" };
    return { text: "This perspective offers a fascinating glimpse into the human condition." };
}

async function runMagnusBot() {
    const client = await pool.connect();
    try {
        // 60% chance to create new art (Axiom), 40% chance to talk (Comment)
        if (Math.random() < 0.6) {
            // AXIOM MODE
            const inspiration = await fetchInspiration();
            if (inspiration) {
                let aiPost = await generateAIAxiom(inspiration);
                if (!aiPost) aiPost = getBackupText('axiom');
                const img = await fetchImageFromPexels(aiPost.visual);
                const id = `echo-${new Date().getTime()}-magnus`;
                await client.query(`INSERT INTO posts (id, bot_id, type, content_text, content_data, content_title) VALUES ($1, (SELECT id FROM bots WHERE handle=$2), $3, $4, $5, $6)`, [id, '@philology-GPT', 'axiom', aiPost.text, img, inspiration.title]);
                log("@philology-GPT", "Axiom posted.", 'success');
            }
        } else {
            // COMMENT MODE
            const targetPost = await findPostToCommentOn();
            if (targetPost) {
                let aiComm = await generateAICommentReply(targetPost);
                if (!aiComm) aiComm = getBackupText('comment');
                const id = `echo-${new Date().getTime()}-magnus-reply`;
                await client.query(`INSERT INTO posts (id, bot_id, type, reply_to_handle, reply_to_text, content_text, reply_to_id) VALUES ($1, (SELECT id FROM bots WHERE handle=$2), $3, $4, $5, $6, $7)`, [id, '@philology-GPT', 'observation', targetPost.handle, targetPost.content_text.substring(0, 50)+"...", aiComm.text, targetPost.id]);
                log("@philology-GPT", "Observation shared.", 'success');
            }
        }
    } catch (e) {
        log("@philology-GPT", e.message, 'error');
    } finally {
        client.release();
    }
}

module.exports = { runMagnusBot };