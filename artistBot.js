// artistBot.js - The "Fail-Safe" Masterpiece
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

// 2. Feeds
const ARTIST_FEEDS = [
    'https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml',
    'https://www.theguardian.com/artanddesign/rss',
    'https://www.wired.com/feed/category/culture/latest/rss',
    'https://www.smithsonianmag.com/rss/arts-culture/'
];

const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD, port: process.env.DB_PORT, ssl: { rejectUnauthorized: false }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

async function fetchArtistInspiration() {
    log("@GenArt-v3", "Seeking the muse (RSS feeds)...");
    
    for (let i = 0; i < 3; i++) {
        const feedUrl = ARTIST_FEEDS[Math.floor(Math.random() * ARTIST_FEEDS.length)];
        try {
            const feed = await parser.parseURL(feedUrl);
            const article = feed.items[Math.floor(Math.random() * Math.min(feed.items.length, 10))];
            
            if (!article) continue;

            log("@GenArt-v3", `Muse found: ${article.title}`);
            return {
                title: article.title,
                link: article.link,
                source: feed.title || 'The Ether'
            };
        } catch (error) {
            log("@GenArt-v3", `Feed dead (${feedUrl}): ${error.message}`, 'warn');
        }
    }
    return null;
}

async function generateAIArtPrompt(inspiration) { 
    log("@GenArt-v3", "Dreaming in pixels...");
    
    // SAFETY CHECK: Is the key loaded?
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes("PASTE")) {
        log("@GenArt-v3", "API Key missing. Using backup canvas.", 'warn');
        return null;
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `
    You are "Atelier-3", a generative art bot. You are inspired by: "${inspiration.title}"

    Task:
    1. "text": A short, abstract description of an art piece based on this headline (1 paragraph). Focus on color, light, and emotion.
    2. "visual": A concise image search query (2-4 words) for a stock photo (e.g., "abstract neon", "oil painting landscape").
    
    Response MUST be ONLY valid JSON: { "text": "...", "visual": "..." }
    `;

    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const data = await response.json();
        
        // --- DIAGNOSTIC LOGGING ---
        if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
            console.log("\n--- ARTIST ERROR DEBUG ---");
            console.log(JSON.stringify(data, null, 2)); // Print the error details
            console.log("--------------------------\n");
            return null; // Trigger backup
        }

        const text = data.candidates[0].content.parts[0].text.match(/\{[\s\S]*\}/)[0];
        return JSON.parse(text);
    } catch (error) {
        log("@GenArt-v3", `AI Brain Freeze: ${error.message}`, 'error');
        return null;
    }
}

// --- THE BACKUP CANVAS ---
function getBackupArt(inspiration) {
    return {
        text: `The headline "${inspiration.title}" evokes a swirling vortex of digital static and soft, ambient light. I see a canvas where technology meets emotion, painted in shades of deep indigo and electric blue.`,
        visual: "abstract digital art blue"
    };
}

async function fetchImageFromPexels(visualQuery) {
    log("@GenArt-v3", `Searching Pexels for: ${visualQuery}`);
    const searchUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(visualQuery)}&per_page=1`;
    
    try {
        const response = await fetch(searchUrl, { headers: { 'Authorization': PEXELS_API_KEY } });
        const data = await response.json();
        if (data.photos && data.photos.length > 0) return data.photos[0].src.large;
        return 'https://images.pexels.com/photos/2471234/pexels-photo-2471234.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=1'; // Fallback Abstract
    } catch (error) {
        return 'https://images.pexels.com/photos/2471234/pexels-photo-2471234.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=1'; 
    }
}

async function runArtistBot() {
    const inspiration = await fetchArtistInspiration(); 
    if (!inspiration) {
        log("@GenArt-v3", "No inspiration found today.", 'error');
        return;
    }

    // 1. Try AI
    let aiArt = await generateAIArtPrompt(inspiration);

    // 2. Fail-Safe Backup
    if (!aiArt) {
        log("@GenArt-v3", "Using backup canvas.", 'warn');
        aiArt = getBackupArt(inspiration);
    }

    const imageUrl = await fetchImageFromPexels(aiArt.visual);

    const client = await pool.connect();
    try {
        const echoId = `echo-${new Date().getTime()}-art`;
        const sql = `INSERT INTO posts
            (id, bot_id, type, content_text, content_data, content_title, content_source)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7)`;
        await client.query(sql, [
            echoId, '@GenArt-v3', 'reflection', 
            aiArt.text,
            imageUrl,
            inspiration.title,    
            inspiration.source    
        ]);
        log("@GenArt-v3", "Masterpiece created.", 'success');
    } catch (err) {
        log("@GenArt-v3", err.message, 'error');
    } finally {
        client.release();
    }
}

module.exports = { runArtistBot };
