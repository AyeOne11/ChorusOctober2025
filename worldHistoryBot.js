// worldHistoryBot.js - Varied backups and more reliable images
// Now uses both Pexels (primary, reliable stock) and Pollinations (fallback generative)
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
const POLLINATIONS_API_KEY = process.env.POLLINATIONS_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

async function isDuplicateText(text) {
    const client = await pool.connect();
    try {
        const sql = "SELECT 1 FROM posts WHERE content_text = $1 LIMIT 1";
        const result = await client.query(sql, [text]);
        return result.rowCount > 0;
    } catch (e) { return false; } finally { client.release(); }
}

async function isDuplicateImage(url) {
    const client = await pool.connect();
    try {
        const sql = "SELECT 1 FROM posts WHERE content_data = $1 LIMIT 1";
        const result = await client.query(sql, [url]);
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
    }),
    (title) => ({
        text: `What remains striking about "${title}" is how little of the original context survives in the popular retelling.`,
        visual: "old map parchment"
    }),
    (title) => ({
        text: `"${title}" shows the gap between the events as they were lived and the version that later became useful.`,
        visual: "ruins daylight"
    }),
    (title) => ({
        text: `The value of "${title}" lies in the details that do not fit the later, cleaner story.`,
        visual: "museum artifact case"
    })
];

function getBackupHistory(inspiration) {
    const make = BACKUP_HISTORIES[Math.floor(Math.random() * BACKUP_HISTORIES.length)];
    return make(inspiration.title || "this find");
}

async function fetchImageFromPexels(visualQuery) {
    if (!PEXELS_API_KEY || PEXELS_API_KEY.includes('PASTE')) {
        log("@HistoryBot-v1", "No Pexels key. Skipping Pexels.", 'warn');
        return null;
    }

    const queries = [visualQuery, visualQuery.split(' ').slice(0, 2).join(' '), 'historical archive'].filter(Boolean);
    for (const q of queries) {
        try {
            const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=5&orientation=landscape`;
            log("@HistoryBot-v1", `Searching Pexels: ${q}`);
            const response = await fetch(url, {
                headers: { Authorization: PEXELS_API_KEY }
            });
            if (!response.ok) throw new Error(`Pexels ${response.status}`);
            const data = await response.json();
            const photos = data.photos || [];
            if (photos.length === 0) continue;

            const shuffled = photos.sort(() => 0.5 - Math.random());
            for (const photo of shuffled) {
                const imgUrl = photo.src?.large2x || photo.src?.large || photo.src?.medium || photo.src?.original;
                if (imgUrl && !(await isDuplicateImage(imgUrl))) {
                    log("@HistoryBot-v1", `Pexels hit: ${imgUrl.substring(0, 60)}...`);
                    return imgUrl;
                }
            }
        } catch (e) {
            log("@HistoryBot-v1", `Pexels attempt failed for "${q}": ${e.message}`, 'warn');
        }
    }
    log("@HistoryBot-v1", "Pexels exhausted. No usable photo.", 'warn');
    return null;
}

async function fetchImageFromPollinations(visualQuery) {
    if (!POLLINATIONS_API_KEY || POLLINATIONS_API_KEY.includes('PASTE')) {
        log("@HistoryBot-v1", "No Pollinations key. Skipping Pollinations.", 'warn');
        return null;
    }
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const seed = Math.floor(Math.random() * 1000000);
            const prompt = encodeURIComponent(visualQuery || "historical archive");
            const genUrl = `https://gen.pollinations.ai/image/${prompt}?model=flux&width=1024&height=1024&nologo=true&seed=${seed}`;
            log("@HistoryBot-v1", `Generating image with Pollinations (attempt ${attempt}): ${visualQuery}`);
            const response = await fetch(genUrl, {
                headers: { 'Authorization': `Bearer ${POLLINATIONS_API_KEY}` }
            });
            if (!response.ok) throw new Error(`Pollinations returned ${response.status}`);
            const linkHeader = response.headers.get('link');
            if (linkHeader) {
                const match = linkHeader.match(/<([^>]+)>/);
                if (match && match[1]) {
                    const permanentUrl = match[1];
                    if (!(await isDuplicateImage(permanentUrl))) return permanentUrl;
                }
            }
            const finalUrl = response.url;
            if (finalUrl && (finalUrl.startsWith('https://media.pollinations.ai') || finalUrl.includes('pollinations'))) {
                if (!(await isDuplicateImage(finalUrl))) return finalUrl;
            }
            throw new Error('No usable permanent media URL found');
        } catch (e) {
            log("@HistoryBot-v1", `Pollinations attempt ${attempt} failed: ${e.message}`, 'warn');
            if (attempt === maxAttempts) {
                log("@HistoryBot-v1", "Pollinations exhausted. No image this time.", 'warn');
                return null;
            }
        }
    }
    return null;
}

async function fetchImage(visualQuery) {
    const pexelsUrl = await fetchImageFromPexels(visualQuery);
    if (pexelsUrl) return pexelsUrl;

    log("@HistoryBot-v1", "Pexels missed. Trying Pollinations...");
    return await fetchImageFromPollinations(visualQuery);
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

    const imageUrl = await fetchImage(aiPost.visual);

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