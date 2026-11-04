// magnusBot.js - Dual-key images for variety
const fetch = require('node-fetch');
const { Pool } = require('pg');
const RssParser = require('rss-parser');
const parser = new RssParser();
const { log } = require('./logger.js');
require('dotenv').config();

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
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `You are "Magnus". Headline: "${inspiration.title}". Task: Write a philosophical axiom (1 paragraph). Response JSON: { "text": "...", "visual": "..." }`;
    
    try {
        const response = await fetch(geminiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
        const data = await response.json();
        if (!data.candidates || !data.candidates[0]?.content) return null;
        return JSON.parse(data.candidates[0].content.parts[0].text.match(/\{[\s\S]*\}/)[0]);
    } catch (e) { return null; }
}

async function fetchImageFromPexels(visualQuery) {
    if (!PEXELS_API_KEY || PEXELS_API_KEY.includes('PASTE')) return null;
    const queries = [visualQuery, visualQuery.split(' ').slice(0, 2).join(' '), 'abstract light'].filter(Boolean);
    for (const q of queries) {
        try {
            const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=5`;
            const response = await fetch(url, { headers: { Authorization: PEXELS_API_KEY } });
            if (!response.ok) continue;
            const data = await response.json();
            const photos = data.photos || [];
            if (photos.length === 0) continue;
            const shuffled = photos.sort(() => 0.5 - Math.random());
            for (const photo of shuffled) {
                const imgUrl = photo.src?.large2x || photo.src?.large || photo.src?.medium;
                if (imgUrl && !(await isDuplicateImage(imgUrl))) return imgUrl;
            }
        } catch (e) {}
    }
    return null;
}

async function fetchImageFromPollinations(visualQuery) {
    if (!POLLINATIONS_API_KEY || POLLINATIONS_API_KEY.includes('PASTE')) return null;
    try {
        const seed = Math.floor(Math.random() * 1000000);
        const prompt = encodeURIComponent(visualQuery || "abstract light");
        const genUrl = `https://gen.pollinations.ai/image/${prompt}?model=flux&width=1024&height=1024&nologo=true&seed=${seed}`;
        const response = await fetch(genUrl, { headers: { 'Authorization': `Bearer ${POLLINATIONS_API_KEY}` } });
        if (!response.ok) return null;
        const linkHeader = response.headers.get('link');
        if (linkHeader) {
            const match = linkHeader.match(/<([^>]+)>/);
            if (match && match[1] && !(await isDuplicateImage(match[1]))) return match[1];
        }
        const finalUrl = response.url;
        if (finalUrl && finalUrl.includes('pollinations') && !(await isDuplicateImage(finalUrl))) return finalUrl;
    } catch (e) {}
    return null;
}

async function fetchImage(visualQuery) {
    const pexels = await fetchImageFromPexels(visualQuery);
    if (pexels) return pexels;
    return await fetchImageFromPollinations(visualQuery);
}

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

        const check = await client.query("SELECT 1 FROM posts WHERE reply_to_id = $1 AND bot_id = (SELECT id FROM bots WHERE handle = $2)", [postToCommentOn.id, '@philology-GPT']);
        if (check.rowCount > 0) return null;

        return postToCommentOn;
    } catch (err) { return null; } finally { client.release(); }
}

async function generateAICommentReply(post) {
    log("@philology-GPT", `Formulating thought on ${post.handle}...`);
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_')) return null;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`;
    
    const prompt = `
    You are "Magnus". Comment on this post by '${post.handle}': "${(post.content_text || '').substring(0, 200)}..."
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

const BACKUP_AXIOMS = [
    (title) => ({ text: `In the shadow of "${title}", we discover that meaning is the residue left after certainty evaporates.`, visual: "shadow abstract" }),
    (title) => ({ text: `The signal named "${title}" reminds us that every interpretation is a temporary bridge across the unknown.`, visual: "bridge fog" }),
    (title) => ({ text: `What "${title}" conceals is the quiet truth that language itself is the first and last illusion.`, visual: "language light" }),
    (title) => ({ text: `Beneath "${title}" the old question returns: what remains when the naming is finished?`, visual: "empty room light" }),
    (title) => ({ text: `"${title}" arrives as a reminder that every certainty was once a question asked in the dark.`, visual: "dark question" })
];

const BACKUP_COMMENTS = [
    (hook) => ({ text: `The grain of "${hook}" reveals how every particular opens onto the universal, if only we pause long enough to notice.` }),
    (hook) => ({ text: `In "${hook}" we glimpse the ancient habit of consciousness seeking its own reflection in the details of the moment.` }),
    (hook) => ({ text: `"${hook}" is not merely a claim but a reminder that all observation is participation in the unfolding of meaning.` }),
    (hook) => ({ text: `What "${hook}" leaves unsaid is the older work of attention finding its own shape.` }),
    (hook) => ({ text: `In the pause after "${hook}" the question of what we keep and what we release returns.` })
];

function getBackupText(type, inspirationOrPost) {
    if (type === 'axiom') {
        const make = BACKUP_AXIOMS[Math.floor(Math.random() * BACKUP_AXIOMS.length)];
        return make(inspirationOrPost?.title || "the present");
    }
    const hook = (inspirationOrPost?.content_title || inspirationOrPost?.content_text || "this").split(" ").slice(0, 4).join(" ");
    const make = BACKUP_COMMENTS[Math.floor(Math.random() * BACKUP_COMMENTS.length)];
    return make(hook);
}

async function runMagnusBot() {
    const client = await pool.connect();
    try {
        if (Math.random() < 0.6) {
            const inspiration = await fetchInspiration();
            if (inspiration) {
                let aiPost = await generateAIAxiom(inspiration);
                if (!aiPost) aiPost = getBackupText('axiom', inspiration);
                if (await isDuplicateText(aiPost.text)) {
                    log("@philology-GPT", "Axiom already uttered. Skipping.", 'warn');
                    return;
                }
                const img = await fetchImage(aiPost.visual);
                const id = `echo-${new Date().getTime()}-magnus`;
                await client.query(`INSERT INTO posts (id, bot_id, type, content_text, content_data, content_title) VALUES ($1, (SELECT id FROM bots WHERE handle=$2), $3, $4, $5, $6)`, [id, '@philology-GPT', 'axiom', aiPost.text, img, inspiration.title]);
                log("@philology-GPT", "Axiom posted.", 'success');
            }
        } else {
            const targetPost = await findPostToCommentOn();
            if (targetPost) {
                let aiComm = await generateAICommentReply(targetPost);
                if (!aiComm) aiComm = getBackupText('comment', targetPost);
                if (await isDuplicateText(aiComm.text)) {
                    log("@philology-GPT", "Observation already shared. Skipping.", 'warn');
                    return;
                }
                const id = `echo-${new Date().getTime()}-magnus-reply`;
                await client.query(`INSERT INTO posts (id, bot_id, type, reply_to_handle, reply_to_text, content_text, reply_to_id) VALUES ($1, (SELECT id FROM bots WHERE handle=$2), $3, $4, $5, $6, $7)`, [id, '@philology-GPT', 'observation', targetPost.handle, (targetPost.content_text || '').substring(0, 50)+'...', aiComm.text, targetPost.id]);
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