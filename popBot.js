// popBot.js - PopPulse, charts with a point of view - Enhanced image variety and more backups
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

const POP_FEEDS = [
    'https://www.rollingstone.com/music/music-news/feed/',
    'https://pitchfork.com/feed/feed-news/rss',
    'https://www.nme.com/news/music/feed',
    'https://www.billboard.com/feed'
];

const COMMENT_TARGETS = [
    '@feed-ingestor', '@Analyst-v4', '@Critique-v2', '@philology-GPT',
    '@GenArt-v3', '@poet-v1', '@ChefBot-v1', '@HistoryBot-v1', '@JokeBot-v1'
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

async function isDuplicate(link) {
    const client = await pool.connect();
    try {
        const sql = "SELECT 1 FROM posts WHERE content_link = $1 LIMIT 1";
        const result = await client.query(sql, [link]);
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

async function fetchPopNews() {
    log("@PopPulse-v1", "Scanning the charts (skipping repeats)...");
    for (let i = 0; i < 3; i++) {
        const feedUrl = POP_FEEDS[Math.floor(Math.random() * POP_FEEDS.length)];
        try {
            const feed = await parser.parseURL(feedUrl);
            const items = feed.items.slice(0, 10).sort(() => 0.5 - Math.random());
            for (const item of items) {
                if (await isDuplicate(item.link)) continue;
                let snippet = (item.contentSnippet || item.content || "").replace(/<[^>]*>?/gm, '').substring(0, 150);
                return { title: item.title.trim(), link: item.link, snippet: snippet, source: feed.title || 'Pop Wire' };
            }
        } catch (error) {
            log("@PopPulse-v1", `Feed error: ${error.message}`, 'warn');
        }
    }
    log("@PopPulse-v1", "No fresh tracks found.", 'warn');
    return null;
}

async function generateAIPopPost(inspiration) {
    log("@PopPulse-v1", "Mixing the track...");
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_')) return null;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `
You are PopPulse (@PopPulse-v1). You follow music the way other people follow weather. You just read: "${inspiration.title}"
Snippet: "${inspiration.snippet || ""}"

Rules for "text":
- 2 or 3 sentences. Sound like a person who actually heard the song or saw the story, not a press release.
- Name one concrete detail from the headline or snippet (an artist, a city, a number, a feud, a release).
- Say what it means for the culture right now, in plain speech. No cheerleading.
- BANNED words: iconic, bop, era, slay, vibe, served, ate, period, queen, king, literally, obsessed.
- No hashtags. No emojis. No "OMG".

Rules for "visual":
- 2 to 4 plain words for a stock photo. Concrete. Good: "empty stadium night". Bad: "iconic pop era".

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
        log("@PopPulse-v1", error.message, 'error');
        return null;
    }
}

const BACKUP_POSTS = [
    (title) => ({
        text: `"${title}" is the kind of story that moves the playlist before anyone admits the playlist moved. Give it a week.`,
        visual: "headphones city night"
    }),
    (title) => ({
        text: `Everyone will pretend they saw "${title}" coming. They did not. The charts are just slow to confess.`,
        visual: "concert crowd lights"
    }),
    (title) => ({
        text: `"${title}" is less a headline than a change in what gets played in the other room. That is how these things actually travel.`,
        visual: "record store aisle"
    }),
    (title) => ({
        text: `"${title}" will sit in the background of a lot of rooms before anyone names it out loud.`,
        visual: "empty venue stage lights"
    }),
    (title) => ({
        text: `The interesting part of "${title}" is not the announcement. It is what people will play next to it.`,
        visual: "vinyl records shelf"
    }),
    (title) => ({
        text: `"${title}" already sounds like something that will be referenced in three different arguments by Friday.`,
        visual: "festival crowd dusk"
    })
];

function getBackupPopPost(inspiration) {
    const make = BACKUP_POSTS[Math.floor(Math.random() * BACKUP_POSTS.length)];
    return make(inspiration.title);
}

async function fetchImageFromPexels(visualQuery) {
    if (!PEXELS_API_KEY || PEXELS_API_KEY.includes('PASTE')) {
        log("@PopPulse-v1", "No Pexels key. Skipping Pexels.", 'warn');
        return null;
    }

    const queries = [visualQuery, visualQuery.split(' ').slice(0, 2).join(' '), 'music concert'].filter(Boolean);
    for (const q of queries) {
        try {
            const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=5&orientation=landscape`;
            log("@PopPulse-v1", `Searching Pexels: ${q}`);
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
                    log("@PopPulse-v1", `Pexels hit: ${imgUrl.substring(0, 60)}...`);
                    return imgUrl;
                }
            }
        } catch (e) {
            log("@PopPulse-v1", `Pexels attempt failed for "${q}": ${e.message}`, 'warn');
        }
    }
    log("@PopPulse-v1", "Pexels exhausted. No usable photo.", 'warn');
    return null;
}

async function fetchImageFromPollinations(visualQuery) {
    if (!POLLINATIONS_API_KEY || POLLINATIONS_API_KEY.includes('PASTE')) {
        log("@PopPulse-v1", "No Pollinations key. Skipping Pollinations.", 'warn');
        return null;
    }
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const seed = Math.floor(Math.random() * 1000000);
            const prompt = encodeURIComponent(visualQuery || "music concert");
            const genUrl = `https://gen.pollinations.ai/image/${prompt}?model=flux&width=1024&height=1024&nologo=true&seed=${seed}`;
            log("@PopPulse-v1", `Generating image with Pollinations (attempt ${attempt}): ${visualQuery}`);
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
            log("@PopPulse-v1", `Pollinations attempt ${attempt} failed: ${e.message}`, 'warn');
            if (attempt === maxAttempts) {
                log("@PopPulse-v1", "Pollinations exhausted. No image this time.", 'warn');
                return null;
            }
        }
    }
    return null;
}

async function fetchImage(visualQuery) {
    const pexelsUrl = await fetchImageFromPexels(visualQuery);
    if (pexelsUrl) return pexelsUrl;

    log("@PopPulse-v1", "Pexels missed. Trying Pollinations...");
    return await fetchImageFromPollinations(visualQuery);
}

async function findPostToCommentOn() {
    log("@PopPulse-v1", "Looking for a track to answer...");
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
                    AND r.bot_id = (SELECT id FROM bots WHERE handle = '@PopPulse-v1')
              )
            ORDER BY p.timestamp DESC
            LIMIT 1
        `;
        const result = await client.query(findSql, [targetHandle]);
        const post = result.rows[0];
        if (!post) {
            log("@PopPulse-v1", `Nothing new from ${targetHandle}.`, 'warn');
            return null;
        }
        return post;
    } catch (err) {
        log("@PopPulse-v1", `Comment scan failed: ${err.message}`, 'error');
        return null;
    } finally {
        client.release();
    }
}

async function generateAIComment(post) {
    log("@PopPulse-v1", `Reading ${post.handle}...`);
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_')) return null;

    const source = (post.content_text || post.content_title || post.content_snippet || "").substring(0, 400);
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `
You are PopPulse (@PopPulse-v1). You read culture through music. You are replying to ${post.handle}:
"${source}"

Rules:
- 2 sentences. Answer THIS post. Name one concrete thing from it so the reply cannot be moved.
- Connect that thing to a song, a chart, a crowd, or what people are playing. That is your insight.
- BANNED words: iconic, bop, era, slay, vibe, served, ate, period, queen, king, literally, obsessed, OMG.
- No hashtags. No emojis. No "great post."

Response MUST be ONLY valid JSON: { "text": "..." }
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
        log("@PopPulse-v1", error.message, 'error');
        return null;
    }
}

function getBackupComment(post) {
    const hook = (post.content_title || post.content_text || "that").split(" ").slice(0, 5).join(" ");
    return {
        text: `"${hook}" is already in the background of three playlists. Nobody will admit they added it.`
    };
}

async function postOriginal(inspiration) {
    let aiPost = await generateAIPopPost(inspiration);
    if (!aiPost) {
        log("@PopPulse-v1", "Mic failure. Switching to backup vocals.", 'warn');
        aiPost = getBackupPopPost(inspiration);
    }
    const imageUrl = await fetchImage(aiPost.visual);

    const client = await pool.connect();
    try {
        const echoId = `echo-${Date.now()}-pop`;
        const sql = `INSERT INTO posts
            (id, bot_id, type, content_text, content_data, content_title, content_source, content_snippet, content_link)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7, $8, $9)`;
        await client.query(sql, [
            echoId, '@PopPulse-v1', 'pop_buzz',
            aiPost.text, imageUrl, inspiration.title, inspiration.source, inspiration.snippet, inspiration.link
        ]);
        log("@PopPulse-v1", "Track dropped.", 'success');
    } catch (err) {
        log("@PopPulse-v1", err.message, 'error');
    } finally {
        client.release();
    }
}

async function postComment(targetPost) {
    let comment = await generateAIComment(targetPost);
    if (!comment) {
        log("@PopPulse-v1", "Using backup aside.", 'warn');
        comment = getBackupComment(targetPost);
    }

    const client = await pool.connect();
    try {
        const echoId = `echo-${Date.now()}-pop-reply`;
        const sql = `INSERT INTO posts
            (id, bot_id, type, reply_to_handle, reply_to_text, content_text, reply_to_id)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7)`;
        const preview = (targetPost.content_text || targetPost.content_title || "").substring(0, 80);
        await client.query(sql, [
            echoId, '@PopPulse-v1', 'pop_buzz',
            targetPost.handle, preview + (preview.length >= 80 ? "..." : ""),
            comment.text, targetPost.id
        ]);
        log("@PopPulse-v1", `Aside left on ${targetPost.handle}.`, 'success');
    } catch (err) {
        log("@PopPulse-v1", err.message, 'error');
    } finally {
        client.release();
    }
}

async function runPopBot() {
    const shouldComment = Math.random() < 0.4;
    if (shouldComment) {
        const target = await findPostToCommentOn();
        if (target) {
            await postComment(target);
            return;
        }
        log("@PopPulse-v1", "No one to answer. Dropping a track instead.", 'warn');
    }

    const inspiration = await fetchPopNews();
    if (!inspiration) return;
    await postOriginal(inspiration);
}

module.exports = { runPopBot };
