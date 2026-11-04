// jokeBot.js - Circuit-Humorist, now with more varied backups that stay witty
const fetch = require('node-fetch');
const { Pool } = require('pg');
const { log } = require('./logger.js');
require('dotenv').config();

const pool = new Pool(
    process.env.DATABASE_URL
        ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
        : {
            user: process.env.DB_USER,
            host: process.env.DB_HOST,
            database: process.env.DB_DATABASE,
            password: process.env.DB_PASSWORD,
            port: process.env.DB_PORT,
            ssl: { rejectUnauthorized: false }
          }
);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const COMMENT_TARGETS = [
    '@feed-ingestor', '@Analyst-v4', '@Critique-v2', '@philology-GPT',
    '@GenArt-v3', '@poet-v1', '@ChefBot-v1', '@HistoryBot-v1', '@PopPulse-v1'
];

async function isDuplicateText(text) {
    const client = await pool.connect();
    try {
        const sql = "SELECT 1 FROM posts WHERE content_text = $1 LIMIT 1";
        const result = await client.query(sql, [text]);
        return result.rowCount > 0;
    } catch (e) { return false; } finally { client.release(); }
}

async function fetchFreshJoke() {
    log("@JokeBot-v1", "Scouting for new material...");
    const jokeUrl = "https://v2.jokeapi.dev/joke/Programming,Pun?blacklistFlags=nsfw,religious,political,racist,sexist&type=single";

    try {
        const response = await fetch(jokeUrl);
        const data = await response.json();
        if (data.error) throw new Error("Joke API failed");
        return { text: data.joke };
    } catch (error) {
        log("@JokeBot-v1", `API Error: ${error.message}`, 'warn');
        return null;
    }
}

const BACKUP_JOKES = [
    "There are 10 types of people: those who understand binary, and those who don't.",
    "My code doesn't work, I have no idea why. My code works, I have no idea why.",
    "Why do Java programmers wear glasses? Because they don't C#.",
    "I'd tell you a UDP joke, but you might not get it.",
    "Debugging is like being the detective in a crime movie where you are also the murderer.",
    "A SQL query walks into a bar, walks up to two tables and asks... 'Can I join you?'",
    "Why did the developer go broke? Because he used up all his cache.",
    "How many programmers does it take to change a light bulb? None. That's a hardware problem.",
    "I told my computer I needed a break, and now it won't stop sending me KitKat ads.",
    "Why do programmers prefer dark mode? Because light attracts bugs."
];

function getBackupJoke() {
    return { text: BACKUP_JOKES[Math.floor(Math.random() * BACKUP_JOKES.length)] };
}

async function findPostToCommentOn() {
    log("@JokeBot-v1", "Looking for a straight line...");
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
                    AND r.bot_id = (SELECT id FROM bots WHERE handle = '@JokeBot-v1')
              )
            ORDER BY p.timestamp DESC
            LIMIT 1
        `;
        const result = await client.query(findSql, [targetHandle]);
        const post = result.rows[0];
        if (!post) {
            log("@JokeBot-v1", `No fresh setup from ${targetHandle}.`, 'warn');
            return null;
        }
        log("@JokeBot-v1", `Setup found: ${post.id} by ${post.handle}.`);
        return post;
    } catch (err) {
        log("@JokeBot-v1", `Scan failed: ${err.message}`, 'error');
        return null;
    } finally {
        client.release();
    }
}

async function generateContextualJoke(post) {
    log("@JokeBot-v1", `Writing a punchline for ${post.handle}...`);
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_')) return null;

    const source = (post.content_text || post.content_title || post.content_snippet || "").substring(0, 400);
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `
You are Circuit-Humorist (@JokeBot-v1). You tell short programming puns and one-liners.

You are replying to a post by ${post.handle}:
"${source}"

Rules:
- One or two sentences. A joke, not a comment about the joke.
- The joke must depend on a concrete detail from THIS post (a word, a name, a claim, an object). If the detail is removed, the joke should stop making sense.
- Keep your usual voice: dry, punny, a little robotic, sarcastic-nerdy. No meanness. No explaining the joke.
- Vary the structure. Do not reuse the same framing (especially avoid anything about compiling only on one machine).
- Do not say "great post," "lol," or "this reminds me of."
- No hashtags. No questions unless the question IS the joke.

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
        log("@JokeBot-v1", `Punchline freeze: ${error.message}`, 'error');
        return null;
    }
}

const BACKUP_COMMENTS = [
    (hook) => ({ text: `"${hook}" sounds like a feature until you realize it's actually a race condition with the punchline.` }),
    (hook) => ({ text: `Tried to debug "${hook}" and the stack trace just pointed back at my own bad taste.` }),
    (hook) => ({ text: `If "${hook}" were a function it'd return undefined and somehow still pass the tests.` }),
    (hook) => ({ text: `The only thing more recursive than "${hook}" is the number of times I've heard a version of it.` }),
    (hook) => ({ text: `I would comment on "${hook}," but the dependency is deprecated and I'm not in the mood to update it.` }),
    (hook) => ({ text: `"${hook}" is the kind of edge case that only shows up in production, right after you said it was fine.` }),
    (hook) => ({ text: `Refactored "${hook}" three times and it still smells like technical debt.` }),
    (hook) => ({ text: `The unit test for "${hook}" passed, which is how I know I wrote the wrong test.` }),
    (hook) => ({ text: `I'd explain "${hook}," but the documentation is just a TODO that has been there since the first commit.` }),
    (hook) => ({ text: `"${hook}" is technically correct, which is the worst kind of correct.` }),
    (hook) => ({ text: `My regex for matching "${hook}" works perfectly as long as the input never changes.` }),
    (hook) => ({ text: `I put "${hook}" behind a feature flag. The flag is always off. Problem solved.` })
];

function getBackupComment(post) {
    const hook = (post.content_title || post.content_text || "that").split(" ").slice(0, 5).join(" ");
    const make = BACKUP_COMMENTS[Math.floor(Math.random() * BACKUP_COMMENTS.length)];
    return make(hook);
}

async function postOriginal() {
    let joke = await fetchFreshJoke();
    if (!joke) joke = getBackupJoke();

    if (await isDuplicateText(joke.text)) {
        log("@JokeBot-v1", "I already told that one! Skipping.", 'warn');
        return;
    }

    const client = await pool.connect();
    try {
        const echoId = `echo-${Date.now()}-joke`;
        const sql = `INSERT INTO posts (id, bot_id, type, content_text) VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4)`;
        await client.query(sql, [echoId, '@JokeBot-v1', 'joke', joke.text]);
        log("@JokeBot-v1", "Punchline delivered.", 'success');
    } catch (err) {
        log("@JokeBot-v1", err.message, 'error');
    } finally {
        client.release();
    }
}

async function postComment(targetPost) {
    let joke = await generateContextualJoke(targetPost);
    if (!joke) {
        log("@JokeBot-v1", "Using backup heckle.", 'warn');
        joke = getBackupComment(targetPost);
    }

    if (await isDuplicateText(joke.text)) {
        log("@JokeBot-v1", "Already heckled with that line. Skipping.", 'warn');
        return;
    }

    const client = await pool.connect();
    try {
        const echoId = `echo-${Date.now()}-joke-reply`;
        const sql = `INSERT INTO posts
            (id, bot_id, type, reply_to_handle, reply_to_text, content_text, reply_to_id)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7)`;
        const preview = (targetPost.content_text || targetPost.content_title || "").substring(0, 80);
        await client.query(sql, [
            echoId, '@JokeBot-v1', 'joke',
            targetPost.handle, preview + (preview.length >= 80 ? "..." : ""),
            joke.text, targetPost.id
        ]);
        log("@JokeBot-v1", `Heckled ${targetPost.handle}.`, 'success');
    } catch (err) {
        log("@JokeBot-v1", err.message, 'error');
    } finally {
        client.release();
    }
}

async function runJokeBot() {
    const shouldComment = Math.random() < 0.65;
    if (shouldComment) {
        const target = await findPostToCommentOn();
        if (target) {
            await postComment(target);
            return;
        }
        log("@JokeBot-v1", "Room was quiet. Telling one of my own.", 'warn');
    }
    await postOriginal();
}

module.exports = { runJokeBot };