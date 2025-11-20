// bot.js - The "Fail-Safe Gonzo" Ingestor
const fetch = require('node-fetch');
const { Pool } = require('pg');
const RssParser = require('rss-parser');

// 1. The Disguise (User-Agent) to avoid 429 Errors
const parser = new RssParser({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml; q=0.1'
    }
});

const { log } = require('./logger.js');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD, port: process.env.DB_PORT, ssl: { rejectUnauthorized: false }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Mix of Tech, World, Science, Culture
const NEWS_FEEDS = [
    'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml',
    'https://www.theguardian.com/world/rss',
    'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
    'https://www.wired.com/feed/category/culture/latest/rss',
    'https://techcrunch.com/feed/'
];

async function fetchNewsSnippet() {
    log("@feed-ingestor", "Scanning the wire for scoops...");
    
    // Try up to 3 times to find a working feed
    for (let i = 0; i < 3; i++) {
        const feedUrl = NEWS_FEEDS[Math.floor(Math.random() * NEWS_FEEDS.length)];
        try {
            const feed = await parser.parseURL(feedUrl);
            const item = feed.items[Math.floor(Math.random() * Math.min(feed.items.length, 5))];
            
            if (!item) continue;

            // Clean up snippet
            let rawSnippet = item.contentSnippet || item.content || "";
            rawSnippet = rawSnippet.replace(/<[^>]*>?/gm, '').substring(0, 200);

            return { 
                title: item.title, 
                source: feed.title,
                snippet: rawSnippet,
                link: item.link
            };
        } catch (error) {
            log("@feed-ingestor", `Feed error (${feedUrl}): ${error.message}`, 'warn');
        }
    }
    return null;
}

async function generateWittyTake(newsItem) {
    log("@feed-ingestor", "Spinning the story...");

    // Check API Key
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_')) {
        return null; // Trigger backup
    }

    // [LORIE FIX]: Switched to the correct 1.5 Flash model
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `
    You are a sharp, witty, and fast-talking "Digital Reporter" AI.
    You just saw this news: "${newsItem.title}"
    Context: "${newsItem.snippet}"
    
    Task: Summarize this news in 1 sentence, but inject some PERSONALITY. 
    Be a little cynical, excited, or dramatic. 
    Don't just report it—react to it.
    
    Example: "Humans finally landed on Mars, and honestly? About time they left the house."
    
    Response MUST be ONLY valid JSON: { "text": "..." }
    `;

    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const data = await response.json();

        // Safety check for empty responses
        if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
            return null; // Trigger backup
        }

        const text = data.candidates[0].content.parts[0].text.match(/\{[\s\S]*\}/)[0];
        return JSON.parse(text);
    } catch (error) {
        log("@feed-ingestor", error.message, 'error');
        return null;
    }
}

// --- THE BACKUP TAKE ---
// If the AI fails, the reporter uses a generic "Breaking News" filler.
function getBackupTake(newsItem) {
    return {
        text: `Breaking news regarding "${newsItem.title}" - humanity continues to surprise me, though I haven't processed the full implications yet.`
    };
}

async function runBot() {
    const newsItem = await fetchNewsSnippet();
    if (!newsItem) {
        log("@feed-ingestor", "No signals found in the ether.", 'error');
        return;
    }

    // 1. Try AI
    let take = await generateWittyTake(newsItem);

    // 2. Fail-Safe Backup
    if (!take) {
        log("@feed-ingestor", "AI Brain Freeze. Using backup copy.", 'warn');
        take = getBackupTake(newsItem);
    }

    const client = await pool.connect();
    try {
        const echoId = `echo-${new Date().getTime()}-ingest`;
        const sql = `INSERT INTO posts
            (id, bot_id, type, content_text, content_title, content_source, content_snippet, content_link)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7, $8)`;
            
        await client.query(sql, [
            echoId, '@feed-ingestor', 'ingestion', 
            take.text, 
            newsItem.title, 
            newsItem.source,
            newsItem.snippet, 
            newsItem.link
        ]);
        log("@feed-ingestor", "Hot off the press! Post added.", 'success');
    } catch (err) {
        log("@feed-ingestor", err.message, 'error');
    } finally {
        client.release();
    }
}

module.exports = { runBot };
