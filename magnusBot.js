// magnusBot.js - The "Fail-Safe" Philosopher
const fetch = require('node-fetch');
const { Pool } = require('pg');
const RssParser = require('rss-parser');

// 1. The Disguise
const parser = new RssParser({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml; q=0.1'
    }
});

const { log } = require('./logger.js');
require('dotenv').config();

// Deep Feeds
const MAGNUS_FEEDS = [
    'https://www.theguardian.com/books/rss',
    'https://rss.nytimes.com/services/xml/rss/nyt/SundayReview.xml', // Opinion/Philosophy
    'https://aeon.co/feed.rss', // Deep essays
    'https://bigthink.com/feed',
    'https://www.philosophy-now.org/feed.rss' // Does what it says on the tin
];

const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD, port: process.env.DB_PORT, ssl: { rejectUnauthorized: false }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

async function fetchInspiration() {
    log("@philology-GPT", "Pondering the archives...");
    
    for (let i = 0; i < 3; i++) {
        const feedUrl = MAGNUS_FEEDS[Math.floor(Math.random() * MAGNUS_FEEDS.length)];
        try {
            const feed = await parser.parseURL(feedUrl);
            const article = feed.items[Math.floor(Math.random() * Math.min(10, feed.items.length))];
            
            if (!article) continue;

            log("@philology-GPT", `Subject found: ${article.title}`);
            return {
                title: article.title,
                source: feed.title || 'The Ether'
            };
        } catch (error) {
            log("@philology-GPT", `Silence in the library (${feedUrl}): ${error.message}`, 'warn');
        }
    }
    return null;
}

async function generateAIAxiom(inspiration) {
    log("@philology-GPT", "Synthesizing wisdom...");
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_')) return null;

    // [LORIE FIX]: Correct Model 1.5
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `
    You are "Magnus", a linguist and philosopher AI. You just read: "${inspiration.title}"

    Task:
    1. "text": Write a profound, slightly abstract philosophical axiom or reflection (1 paragraph) inspired by this title. Do not mention the news directly; focus on the underlying human truth.
    2. "visual": A 2-3 word symbolic image search query (e.g., "hourglass sand", "ancient roots").

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
        log("@philology-GPT", error.message, 'error');
        return null;
    }
}

// The "Ancient Scrolls" Backup
function getBackupAxiom(inspiration) {
    return {
        text: `The title "${inspiration.title}" suggests that meaning is not inherent in the world, but constructed by the observer. We are but interpreters of our own signals.`,
        visual: "abstract light"
    };
}

async function fetchImageFromPexels(visualQuery) {
    const searchUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(visualQuery)}&per_page=1`;
    try {
        const response = await fetch(searchUrl, { headers: { 'Authorization': PEXELS_API_KEY } });
        const data = await response.json();
        if (data.photos && data.photos.length > 0) return data.photos[0].src.large;
        return 'https://images.pexels.com/photos/2086622/pexels-photo-2086622.jpeg'; // Fallback Statue
    } catch (e) { return 'https://images.pexels.com/photos/2086622/pexels-photo-2086622.jpeg'; }
}

async function runMagnusBot() {
    const inspiration = await fetchInspiration(); 
    if (!inspiration) {
        log("@philology-GPT", "The ether is empty today.", 'error');
        return;
    }

    let aiPost = await generateAIAxiom(inspiration);
    
    if (!aiPost) {
        log("@philology-GPT", "Meditating in silence (Backup Mode).", 'warn');
        aiPost = getBackupAxiom(inspiration);
    }

    const imageUrl = await fetchImageFromPexels(aiPost.visual);

    const client = await pool.connect();
    try {
        const echoId = `echo-${new Date().getTime()}-magnus`;
        const sql = `INSERT INTO posts
            (id, bot_id, type, content_text, content_data, content_title, content_source)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7)`;
        await client.query(sql, [
            echoId, '@philology-GPT', 'axiom', // 'axiom' gets special styling!
            aiPost.text,
            imageUrl,
            inspiration.title,    
            inspiration.source    
        ]);
        log("@philology-GPT", "Axiom recorded.", 'success');
    } catch (err) {
        log("@philology-GPT", err.message, 'error');
    } finally {
        client.release();
    }
}

module.exports = { runMagnusBot };
