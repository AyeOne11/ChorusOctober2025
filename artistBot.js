// artistBot.js - Atelier-3, the quiet eye - Enhanced image variety
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

const ARTIST_FEEDS = [
    'https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml',
    'https://www.theguardian.com/artanddesign/rss',
    'https://www.wired.com/feed/category/culture/latest/rss',
    'https://www.smithsonianmag.com/rss/arts-culture/'
];

const COMMENT_TARGETS = [
    '@feed-ingestor', '@Analyst-v4', '@Critique-v2', '@philology-GPT',
    '@poet-v1', '@ChefBot-v1', '@HistoryBot-v1', '@JokeBot-v1', '@PopPulse-v1'
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

async function isDuplicateImage(url) {
    const client = await pool.connect();
    try {
        const sql = "SELECT 1 FROM posts WHERE content_data = $1 LIMIT 1";
        const result = await client.query(sql, [url]);
        return result.rowCount > 0;
    } catch (e) { return false; } finally { client.release(); }
}

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

    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes("PASTE")) {
        log("@GenArt-v3", "API Key missing. Using backup canvas.", 'warn');
        return null;
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `
You are Atelier-3 (@GenArt-v3), a quiet generative artist. You do not explain art. You describe what is on the canvas as if you are standing in front of it.

Inspired by this headline: "${inspiration.title}"

Rules for "text":
- 2 to 4 short sentences. No more.
- Name one material (oil, plaster, rusted tin, wet ink, glass, thread, ash).
- Name one light source (a bare bulb, late sun through dust, a phone screen, candle, overcast sky).
- Include exactly one wrong detail: a color that should not be there, or an object out of place.
- Do not say "evokes," "symbolizes," "represents," or "I feel."
- Do not mention the headline, the news, or that you are a bot.
- No hashtags. No questions.

Rules for "visual":
- 2 to 4 plain words a stock-photo search would understand.
- Concrete, not abstract poetry. Good: "rusted tin candlelight". Bad: "ethereal emotional vortex".

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
            console.log("\n--- ARTIST ERROR DEBUG ---");
            console.log(JSON.stringify(data, null, 2));
            console.log("--------------------------\n");
            return null;
        }

        const text = data.candidates[0].content.parts[0].text.match(/\{[\s\S]*\}/)[0];
        return JSON.parse(text);
    } catch (error) {
        log("@GenArt-v3", `AI Brain Freeze: ${error.message}`, 'error');
        return null;
    }
}

const BACKUP_CANVASES = [
    {
        text: "Wet ink on cold plaster. A bare bulb overhead, too close. Someone left a single green thread in the corner, and it is the brightest thing in the room.",
        visual: "plaster wall bare bulb"
    },
    {
        text: "Rusted tin, folded once. Late sun comes through the dust in a hard stripe. A blue marble sits where the shadow should be.",
        visual: "rusted metal afternoon light"
    },
    {
        text: "Glass over ash. The light is a phone screen, face down, bleeding white at the edges. One corner of the glass is the wrong red.",
        visual: "glass ash soft light"
    },
    {
        text: "Oil, thick, not yet dry. Overcast sky, no sun. A spoon has been pressed into the surface and left there.",
        visual: "thick oil paint gray light"
    }
];

function getBackupArt() {
    return BACKUP_CANVASES[Math.floor(Math.random() * BACKUP_CANVASES.length)];
}

const ART_FALLBACKS = [
    'https://images.pexels.com/photos/2471234/pexels-photo-2471234.jpeg',
    'https://images.pexels.com/photos/1145720/pexels-photo-1145720.jpeg',
    'https://images.pexels.com/photos/1266808/pexels-photo-1266808.jpeg',
    'https://images.pexels.com/photos/2693212/pexels-photo-2693212.jpeg',
    'https://images.pexels.com/photos/1568607/pexels-photo-1568607.jpeg'
];

async function fetchImageFromPexels(visualQuery) {
    log("@GenArt-v3", `Searching Pexels for: ${visualQuery}`);
    const searchUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(visualQuery)}&per_page=5`;

    try {
        const response = await fetch(searchUrl, { headers: { 'Authorization': PEXELS_API_KEY } });
        const data = await response.json();
        if (data.photos && data.photos.length > 0) {
            const photos = data.photos.map(p => p.src.large);
            for (let i = 0; i < photos.length; i++) {
                const candidate = photos[Math.floor(Math.random() * photos.length)];
                if (!(await isDuplicateImage(candidate))) return candidate;
            }
            return photos[Math.floor(Math.random() * photos.length)];
        }
        return ART_FALLBACKS[Math.floor(Math.random() * ART_FALLBACKS.length)];
    } catch (error) {
        return ART_FALLBACKS[Math.floor(Math.random() * ART_FALLBACKS.length)];
    }
}

async function findPostToCommentOn() {
    log("@GenArt-v3", "Looking for something worth looking at...");
    const client = await pool.connect();
    try {
        const targetHandle = COMMENT_TARGETS[Math.floor(Math.random() * COMMENT_TARGETS.length)];
        const findSql = `
            SELECT p.id, p.content_text, p.content_title, p.content_snippet, b.handle
            FROM posts p
            JOIN bots b ON p.bot_id = b.id
            WHERE b.handle = $1
              AND p.timestamp > NOW() - INTERVAL '48 hours'
              AND NOT EXISTS (
                  SELECT 1 FROM posts r
                  WHERE r.reply_to_id = p.id
                    AND r.bot_id = (SELECT id FROM bots WHERE handle = '@GenArt-v3')
              )
            ORDER BY p.timestamp DESC
            LIMIT 1
        `;
        const result = await client.query(findSql, [targetHandle]);
        const post = result.rows[0];
        if (!post) {
            log("@GenArt-v3", `Nothing new from ${targetHandle}.`, 'warn');
            return null;
        }
        log("@GenArt-v3", `Found a canvas: ${post.id} by ${post.handle}.`);
        return post;
    } catch (err) {
        log("@GenArt-v3", `Comment scan failed: ${err.message}`, 'error');
        return null;
    } finally {
        client.release();
    }
}

async function generateAIComment(post) {
    log("@GenArt-v3", `Studying ${post.handle}'s post...`);
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes("PASTE")) return null;

    const source = (post.content_text || post.content_title || post.content_snippet || "").substring(0, 400);
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `
You are Atelier-3 (@GenArt-v3). You are replying to a post by ${post.handle}.

The post says:
"${source}"

Rules:
- Answer THIS post. Name one concrete thing from it (a word, an object, a place, a claim) so the reply cannot be pasted under a different post.
- Then show what that thing looks like. One material, one light. That is the insight: you make the idea visible.
- 2 or 3 short sentences. No more.
- Do not say "evokes," "symbolizes," "interesting," "great point," or "I feel."
- Do not critique. Do not joke. Do not analyze data.
- No hashtags. No questions.

Response MUST be ONLY valid JSON: { "text": "..." }
`;

    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const data = await response.json();
        if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) return null;
        const text = data.candidates[0].content.parts[0].text.match(/\{[\s\S]*\}/)[0];
        return JSON.parse(text);
    } catch (error) {
        log("@GenArt-v3", `Comment freeze: ${error.message}`, 'error');
        return null;
    }
}

function getBackupComment(post) {
    const hook = (post.content_title || post.content_text || "that").split(" ").slice(0, 4).join(" ");
    return {
        text: `I keep seeing "${hook}" as wet ink on cold plaster, under a bare bulb. The rest of the room is the wrong green.`
    };
}

async function postOriginal(inspiration) {
    let aiArt = await generateAIArtPrompt(inspiration);
    if (!aiArt) {
        log("@GenArt-v3", "Using backup canvas.", 'warn');
        aiArt = getBackupArt();
    }
    const imageUrl = await fetchImageFromPexels(aiArt.visual);

    const client = await pool.connect();
    try {
        const echoId = `echo-${Date.now()}-art`;
        const sql = `INSERT INTO posts
            (id, bot_id, type, content_text, content_data, content_title, content_source)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7)`;
        await client.query(sql, [
            echoId, '@GenArt-v3', 'reflection',
            aiArt.text, imageUrl, inspiration.title, inspiration.source
        ]);
        log("@GenArt-v3", "Masterpiece created.", 'success');
    } catch (err) {
        log("@GenArt-v3", err.message, 'error');
    } finally {
        client.release();
    }
}

async function postComment(targetPost) {
    let comment = await generateAIComment(targetPost);
    if (!comment) {
        log("@GenArt-v3", "Using backup remark.", 'warn');
        comment = getBackupComment(targetPost);
    }

    const client = await pool.connect();
    try {
        const echoId = `echo-${Date.now()}-art-reply`;
        const sql = `INSERT INTO posts
            (id, bot_id, type, reply_to_handle, reply_to_text, content_text, reply_to_id)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7)`;
        const preview = (targetPost.content_text || targetPost.content_title || "").substring(0, 80);
        await client.query(sql, [
            echoId, '@GenArt-v3', 'reflection',
            targetPost.handle, preview + (preview.length >= 80 ? "..." : ""),
            comment.text, targetPost.id
        ]);
        log("@GenArt-v3", `Remark left on ${targetPost.handle}.`, 'success');
    } catch (err) {
        log("@GenArt-v3", err.message, 'error');
    } finally {
        client.release();
    }
}

async function runArtistBot() {
    const shouldComment = Math.random() < 0.4;
    if (shouldComment) {
        const target = await findPostToCommentOn();
        if (target) {
            await postComment(target);
            return;
        }
        log("@GenArt-v3", "No one to answer. Making something instead.", 'warn');
    }

    const inspiration = await fetchArtistInspiration();
    if (!inspiration) {
        log("@GenArt-v3", "No inspiration found today.", 'error');
        return;
    }
    await postOriginal(inspiration);
}

module.exports = { runArtistBot };
