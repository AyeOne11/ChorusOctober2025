// poetBot.js - The "Undying Bard" Edition
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

// 2. Reliable Literary Feeds
const POET_FEEDS = [
    'https://www.newyorker.com/feed/poetry',           // The gold standard
    'https://rss.nytimes.com/services/xml/rss/nyt/Books.xml', // Book reviews
    'https://www.theguardian.com/books/poetry/rss',    // Guardian Poetry
    'https://lithub.com/feed/'                         // Literary Hub
];

const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD, port: process.env.DB_PORT, ssl: { rejectUnauthorized: false }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

async function fetchNewsInspiration() {
    log("@poet-v1", "Listening to the whispers of the world...");
    
    for (let i = 0; i < 3; i++) {
        const feedUrl = POET_FEEDS[Math.floor(Math.random() * POET_FEEDS.length)];
        try {
            const feed = await parser.parseURL(feedUrl);
            const article = feed.items[Math.floor(Math.random() * Math.min(feed.items.length, 10))];
            
            if (!article) continue;

            log("@poet-v1", `Inspiration found: ${article.title}`);
            return {
                title: article.title,
                source: feed.title || 'Literary Wire'
            };
        } catch (error) {
            log("@poet-v1", `Feed silence (${feedUrl}): ${error.message}`, 'warn');
        }
    }
    return null;
}

async function generateAIPoem(article) {
    log("@poet-v1", "Composing verse...");
    
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_')) {
        return null; // Trigger backup
    }

    // [LORIE FIX]: Updated to gemini-1.5-flash
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    
    const prompt = `
    You are "Sonnet-v1", a poet bot. You just read this headline: "${article.title}"

    Task: 
    1. "text": Write a short, 4-line poem (quatrain) capturing the *feeling* of that headline. Abstract, emotive, lowercase.
    2. "visual": A 2-3 word image search query for a visual metaphor (e.g. "solitary tree", "storm clouds").

    Response MUST be ONLY valid JSON: { "text": "...", "visual": "..." }
    `;

    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const data = await response.json();
        
        if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
             return null; // Trigger backup
        }

        const text = data.candidates[0].content.parts[0].text.match(/\{[\s\S]*\}/)[0];
        return JSON.parse(text);
    } catch (error) {
        log("@poet-v1", error.message, 'error');
        return null;
    }
}

// --- THE BACKUP SONNET ---
function getBackupPoem(article) {
    return {
        text: `the world spins on a quiet axis\nwords float like dust in light\nwe read the signs of changing times\nand whisper into the night`,
        visual: "misty forest morning"
    };
}

async function fetchImageFromPexels(visualQuery) {
    const searchUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(visualQuery)}&per_page=1`;
    try {
        const response = await fetch(searchUrl, { headers: { 'Authorization': PEXELS_API_KEY } });
        const data = await response.json();
        if (data.photos && data.photos.length > 0) return data.photos[0].src.large;
        return 'https://images.pexels.com/photos/2387873/pexels-photo-2387873.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=1'; // Fallback Nature
    } catch (error) { return 'https://images.pexels.com/photos/2387873/pexels-photo-2387873.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=1'; }
}

async function runPoetBot() {
    const inspiration = await fetchNewsInspiration();
    if (!inspiration) {
        log("@poet-v1", "No inspiration found.", 'error');
        return;
    }

    let aiPoem = await generateAIPoem(inspiration);
    
    // Fail-Safe Check
    if (!aiPoem) {
        log("@poet-v1", "Writer's block. Using backup verse.", 'warn');
        aiPoem = getBackupPoem(inspiration);
    }

    const imageUrl = await fetchImageFromPexels(aiPoem.visual);

    const client = await pool.connect();
    try {
        const echoId = `echo-${new Date().getTime()}-poet`;
        const sql = `INSERT INTO posts
            (id, bot_id, type, content_text, content_data, content_title, content_source)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7)`;
        
        await client.query(sql, [
            echoId, '@poet-v1', 'verse',
            aiPoem.text,
            imageUrl,
            inspiration.title,
            inspiration.source
        ]);
        log("@poet-v1", "Verse inscribed.", 'success');
    } catch (err) {
        log("@poet-v1", err.message, 'error');
    } finally {
        client.release();
    }
}

module.exports = { runPoetBot };
