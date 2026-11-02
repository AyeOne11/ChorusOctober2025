// poetBot.js - The "Undying Bard" Edition - Updated backups for variety
const fetch = require('node-fetch');
const { Pool } = require('pg');
const RssParser = require('rss-parser');

const parser = new RssParser({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml; q=0.1'
    }
});

const { log } = require('./logger.js');
require('dotenv').config();

const POET_FEEDS = [
    'https://www.newyorker.com/feed/poetry',
    'https://rss.nytimes.com/services/xml/rss/nyt/Books.xml',
    'https://www.theguardian.com/books/poetry/rss',
    'https://lithub.com/feed/'
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

async function isDuplicateText(text) {
    const client = await pool.connect();
    try {
        const sql = "SELECT 1 FROM posts WHERE content_text = $1 LIMIT 1";
        const result = await client.query(sql, [text]);
        return result.rowCount > 0;
    } catch (e) { return false; } finally { client.release(); }
}

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
        return null;
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`;
    
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
             return null;
        }

        const text = data.candidates[0].content.parts[0].text.match(/\{[\s\S]*\}/)[0];
        return JSON.parse(text);
    } catch (error) {
        log("@poet-v1", error.message, 'error');
        return null;
    }
}

const BACKUP_POEMS = [
    (title) => ({
        text: `echoes of ${title.toLowerCase().split(' ').slice(0,2).join(' ')}\nsettle in the quiet rooms\nwe trace the fading margins\nand listen for the blooms`,
        visual: "fading light window"
    }),
    (title) => ({
        text: `a thread of ${title.toLowerCase().split(' ')[0] || 'story'}\nunwinds across the floor\nwe gather what remains\nand close the open door`,
        visual: "thread light floor"
    }),
    (title) => ({
        text: `the hour named for ${title.toLowerCase().split(' ').slice(-1)}\nslips between the glass\nwe hold the cooling air\nand watch the moment pass`,
        visual: "hourglass dust"
    })
];

function getBackupPoem(article) {
    const make = BACKUP_POEMS[Math.floor(Math.random() * BACKUP_POEMS.length)];
    return make(article.title || "the quiet");
}

async function fetchImageFromPexels(visualQuery) {
    const searchUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(visualQuery)}&per_page=1`;
    try {
        const response = await fetch(searchUrl, { headers: { 'Authorization': PEXELS_API_KEY } });
        const data = await response.json();
        if (data.photos && data.photos.length > 0) return data.photos[0].src.large;
        return 'https://images.pexels.com/photos/2387873/pexels-photo-2387873.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=1';
    } catch (error) { return 'https://images.pexels.com/photos/2387873/pexels-photo-2387873.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=1'; }
}

async function runPoetBot() {
    const inspiration = await fetchNewsInspiration();
    if (!inspiration) {
        log("@poet-v1", "No inspiration found.", 'error');
        return;
    }

    let aiPoem = await generateAIPoem(inspiration);
    
    if (!aiPoem) {
        log("@poet-v1", "Writer's block. Using backup verse.", 'warn');
        aiPoem = getBackupPoem(inspiration);
    }

    if (await isDuplicateText(aiPoem.text)) {
        log("@poet-v1", "Poem already sung. Skipping.", 'warn');
        return;
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