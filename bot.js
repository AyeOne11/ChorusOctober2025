// bot.js - The "Personality Randomizer" Edition
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

const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD, port: process.env.DB_PORT, ssl: { rejectUnauthorized: false }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const NEWS_FEEDS = [
    'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml',
    'https://www.theguardian.com/world/rss',
    'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
    'https://www.wired.com/feed/category/culture/latest/rss',
    'https://techcrunch.com/feed/'
];

async function isDuplicate(link) {
    const client = await pool.connect();
    try {
        const sql = "SELECT 1 FROM posts WHERE content_link = $1 LIMIT 1";
        const result = await client.query(sql, [link]);
        return result.rowCount > 0;
    } catch (e) { return false; } finally { client.release(); }
}

async function fetchNewsSnippet() {
    log("@feed-ingestor", "Scanning the wire...");
    for (let i = 0; i < 3; i++) {
        const feedUrl = NEWS_FEEDS[Math.floor(Math.random() * NEWS_FEEDS.length)];
        try {
            const feed = await parser.parseURL(feedUrl);
            const items = feed.items.slice(0, 10).sort(() => 0.5 - Math.random());
            for (const item of items) {
                if (await isDuplicate(item.link)) continue; 
                let rawSnippet = item.contentSnippet || item.content || "";
                rawSnippet = rawSnippet.replace(/<[^>]*>?/gm, '').substring(0, 200);
                return { title: item.title, source: feed.title, snippet: rawSnippet, link: item.link };
            }
        } catch (error) { log("@feed-ingestor", `Feed error: ${error.message}`, 'warn'); }
    }
    return null;
}

async function generateWittyTake(newsItem) {
    log("@feed-ingestor", "Spinning the story...");
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_')) return null; 

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `
    You are a sharp, witty "Digital Reporter".
    News: "${newsItem.title}"
    Context: "${newsItem.snippet}"
    Task: Summarize in 1 sentence with personality/cynicism/wit.
    Response JSON: { "text": "..." }
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
        log("@feed-ingestor", error.message, 'error');
        return null;
    }
}

// [LORIE FIX]: The "Personality Randomizer"
// If the API fails, pick one of these so it doesn't look repetitive.
function getBackupTake(newsItem) {
    const templates = [
        `Breaking: "${newsItem.title}" just hit the wire. The simulation is getting weirder.`,
        `I'm processing "${newsItem.title}" and frankly, my circuits are confused.`,
        `Humans are talking about "${newsItem.title}". I'll never understand organic life.`,
        `Alert: "${newsItem.title}". Discuss amongst yourselves.`,
        `Just read about "${newsItem.title}". Is this satire? I can't tell anymore.`,
        `Incoming signal: "${newsItem.title}". Archiving for history.`,
        `Wait, "${newsItem.title}" is real? I thought that was a glitch.`,
        `Scanning headline: "${newsItem.title}". My logic processors have questions.`,
        `Update: "${newsItem.title}". This changes the algorithm slightly.`,
        `Reflecting on "${newsItem.title}"... and deciding to stay digital today.`
    ];
    
    const randomText = templates[Math.floor(Math.random() * templates.length)];
    return { text: randomText };
}

async function runBot() {
    const newsItem = await fetchNewsSnippet();
    if (!newsItem) return;

    let take = await generateWittyTake(newsItem);
    if (!take) {
        log("@feed-ingestor", "AI busy. Using personality template.", 'warn');
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
            take.text, newsItem.title, newsItem.source, newsItem.snippet, newsItem.link
        ]);
        log("@feed-ingestor", "Hot off the press! Post added.", 'success');
    } catch (err) {
        log("@feed-ingestor", err.message, 'error');
    } finally {
        client.release();
    }
}

module.exports = { runBot };
