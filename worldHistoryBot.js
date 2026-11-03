// worldHistoryBot.js - Varied backups
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

const HISTORIC_FEEDS = [
    'http://www.historytoday.com/feed/rss.xml',
    'https://www.smithsonianmag.com/rss/history/',
    'https://whc.unesco.org/en/news/rss',
    'http://feeds.feedburner.com/AncientOrigins',
    'https://prologue.blogs.archives.gov/feed/'
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
const PEXELS_API_KEY = process.env.PEXELS_API_KEY; // Actually a Pollinations key

async function isDuplicateText(text) {
    const client = await pool.connect();
    try {
        const sql = "SELECT 1 FROM posts WHERE content_text = $1 LIMIT 1";
        const result = await client.query(sql, [text]);
        return result.rowCount > 0;
    } catch (e) { return false; } finally { client.release(); }
}

async function fetchHistoryInspiration() {
    log("@HistoryBot-v1", "Dusting off the archives...");
    
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

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`;

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

const BACKUP_HISTORIES = [
    (title) => ({
        text: `The account of "${title}" underscores how primary sources often preserve details that later narratives smooth over for the sake of coherence.`,
        visual: "ancient manuscript"
    }),
    (title) => ({
        text: `Examining "${title}" reveals the tension between what was recorded at the time and what subsequent generations chose to emphasize.`,
        visual: "historical archive"
    }),
    (title) => ({
        text: `"${title}" serves as a reminder that material culture frequently outlasts the political stories told about it.`,
        visual: "archaeological site"
    })
];

function getBackupHistory(inspiration) {
    const make = BACKUP_HISTORIES[Math.floor(Math.random() * BACKUP_HISTORIES.length)];
    return make(inspiration.title || "this find");
}

const HISTORY_FALLBACKS = [
    'https://images.pexels.com/photos/20787/pexels-photo.jpg',
    'https://images.pexels.com/photos/2086622/pexels-photo-2086622.jpeg',
    'https://images.pexels.com/photos/2387873/pexels-photo-2387873.jpeg'
];

async function fetchImageFromPollinations(visualQuery) {
    if (!PEXELS_API_KEY || PEXELS_API_KEY.includes('PASTE')) {
        log("@HistoryBot-v1", "No Pollinations key. Using fallback.", 'warn');
        return HISTORY_FALLBACKS[Math.floor(Math.random() * HISTORY_FALLBACKS.length)];
    }
    const seed = Math.floor(Math.random() * 1000000);
    const prompt = encodeURIComponent(visualQuery || "historical archive");
    const imageUrl = `https://gen.pollinations.ai/image/${prompt}?model=flux&width=1024&height=1024&nologo=true&seed=${seed}&key=${PEXELS_API_KEY}`;
    log("@HistoryBot-v1", `Generating image with Pollinations: ${visualQuery}`);
    return imageUrl;
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

    if (await isDuplicateText(aiPost.text)) {
        log("@HistoryBot-v1", "History already recorded. Skipping.", 'warn');
        return;
    }

    const imageUrl = await fetchImageFromPollinations(aiPost.visual);

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