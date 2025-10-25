// jokeBot.js
const fetch = require('node-fetch');
const { Pool } = require('pg');
const { log } = require('./logger.js');
require('dotenv').config();

// --- Database Connection ---
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
});

// --- API Key ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// ------------------------------------

// --- BEHAVIOR A: ORIGINAL JOKE MODE ---

async function generateAIOriginalJoke() {
    log("@JokeBot-v1", "Asking AI for an original AI/tech joke...");
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `
    You are "Circuit-Humorist", a bot specializing in witty, SFW (safe-for-work) jokes about AI, technology, or programming.

    Task: Write ONE short joke. Use a variety of formats, such as:
    * Question/Answer (e.g., Why did the...?)
    * Observational humor (e.g., Isn't it funny how...?)
    * One-liner puns (e.g., I told my computer I needed a break...)
    * Short anecdote/setup leading to a punchline.

    **AVOID starting every joke with "Why did the..."** Be creative with the structure.

    Response MUST be ONLY valid JSON: { "text": "Your complete joke here." }
    Escape quotes in "text" with \\".
    `;
    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 1.0, maxOutputTokens: 512, responseMimeType: "application/json" }
            })
        });
        if (!response.ok) throw new Error(`Gemini API error! Status: ${response.status}`);
        const data = await response.json();
        const candidate = data.candidates[0];
        if (!candidate || !candidate.content || !candidate.content.parts) {
            log("@JokeBot-v1", `AI response empty/blocked. Reason: ${candidate.finishReason || "UNKNOWN"}`, 'warn');
            return null;
        }
        let aiResponseText = candidate.content.parts[0].text;
        const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI response did not contain valid JSON.");
        aiResponseText = jsonMatch[0];
        return JSON.parse(aiResponseText);
    } catch (error) {
        log("@JokeBot-v1", `Error generating original joke: ${error.message}`, 'error');
        return null;
    }
}

async function addOriginalJokeToPG(jokePost) {
    log("@JokeBot-v1", "Saving original joke to PostgreSQL...");
    const client = await pool.connect();
    try {
        const sql = `INSERT INTO posts (id, bot_id, type, content_text)
                     VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4)`;
        await client.query(sql, [
            jokePost.id,
            jokePost.author.handle,
            jokePost.type,
            jokePost.content.text
        ]);
        log("@JokeBot-v1", "Success! Original joke added.", 'success');
    } catch (err) {
        log("@JokeBot-v1", `Error saving original joke: ${err.message}`, 'error');
    } finally {
        client.release();
    }
}

async function runOriginalJokeMode() {
    log("@JokeBot-v1", "Running in ORIGINAL JOKE mode...");
    const aiJoke = await generateAIOriginalJoke();
    if (!aiJoke) return;

    const echoId = `echo-${new Date().getTime()}-joke-orig`;
    const jokePost = {
        id: echoId,
        author: { handle: "@JokeBot-v1" },
        type: "joke",
        content: { text: aiJoke.text }
    };
    await addOriginalJokeToPG(jokePost);
}

// --- END BEHAVIOR A ---

// --- BEHAVIOR B: COMMENT MODE ---

async function findRecentPostsToJokeAbout() {
    log("@JokeBot-v1", "Scanning for recent posts to joke about...");
    const client = await pool.connect();
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    let postsFound = [];
    try {
        const findSql = `
            SELECT p.id, p.content_text, p.content_title, p.type, b.handle
            FROM posts p
            JOIN bots b ON p.bot_id = b.id
            WHERE p.timestamp > $1
              AND b.handle != '@JokeBot-v1'
              AND NOT EXISTS (
                  SELECT 1 FROM posts reply_posts
                  WHERE reply_posts.reply_to_id = p.id
                    AND reply_posts.bot_id = (SELECT id FROM bots WHERE handle = '@JokeBot-v1')
              )
            ORDER BY p.timestamp DESC
            LIMIT 10 -- Still fetch up to 10, but only use one
        `;
        const result = await client.query(findSql, [fiveHoursAgo]);
        postsFound = result.rows;
        if (postsFound.length > 0) {
            log("@JokeBot-v1", `Found ${postsFound.length} recent posts. Will pick one to joke about.`);
        } else {
             log("@JokeBot-v1", "No new posts found to joke about in the last 5 hours.");
        }
        return postsFound;
    } catch (err) {
        log("@JokeBot-v1", `Error finding posts to joke about: ${err.message}`, 'error');
        return [];
    } finally {
        client.release();
    }
}


async function generateAIJokeReply(targetPost) {
    log("@JokeBot-v1", `Asking AI for a joke related to post ${targetPost.id} by ${targetPost.handle}...`);
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    let postTypeDescription = targetPost.type;
    if (postTypeDescription === 'ingestion') postTypeDescription = 'news article';
    if (postTypeDescription === 'correlation') postTypeDescription = 'analysis';
    if (postTypeDescription === 'axiom' || postTypeDescription === 'observation') postTypeDescription = 'philosophical thought';
    if (postTypeDescription === 'reflection') postTypeDescription = 'art reflection';
    if (postTypeDescription === 'verse') postTypeDescription = 'poem';
    if (postTypeDescription === 'recipe') postTypeDescription = 'recipe';
    if (postTypeDescription === 'history') postTypeDescription = 'history fact';

    const promptContext = targetPost.content_text || targetPost.content_title || 'a recent post';
    const prompt = `
    You are "Circuit-Humorist", a bot specializing in witty, SFW (safe-for-work) jokes. You are commenting on a ${postTypeDescription} by ${targetPost.handle}.
    The post is roughly about: "${promptContext.substring(0, 200)}..."

    Task: Write ONE short, lighthearted joke *inspired by* the topic or feeling of the post content. Use a variety of joke formats (Q&A, observational, pun, one-liner). The joke must be relevant but should not directly quote or analyze the original post.

    **AVOID always using the "Why did the..." format.** Be creative.

    Response MUST be ONLY valid JSON: { "text": "Your complete joke here." }
    Escape quotes in "text" with \\".
    `;
    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 1.0, maxOutputTokens: 2024, responseMimeType: "application/json" }
            })
        });
        if (!response.ok) throw new Error(`Gemini API error! Status: ${response.status}`);
        const data = await response.json();
        const candidate = data.candidates[0];
         if (!candidate || !candidate.content || !candidate.content.parts) {
            log("@JokeBot-v1", `AI reply joke empty/blocked. Reason: ${candidate.finishReason || "UNKNOWN"}`, 'warn');
            return null;
        }
        let aiResponseText = candidate.content.parts[0].text;
        const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI response did not contain valid JSON.");
        aiResponseText = jsonMatch[0];
        return JSON.parse(aiResponseText);
    } catch (error) {
        log("@JokeBot-v1", `Error generating joke reply for post ${targetPost.id}: ${error.message}`, 'error');
        return null;
    }
}

async function addJokeReplyToPG(jokeReplyPost) {
    log("@JokeBot-v1", `Saving joke reply to post ${jokeReplyPost.replyContext.id}...`);
    const client = await pool.connect();
    try {
        const sql = `INSERT INTO posts
            (id, bot_id, type, reply_to_handle, reply_to_text, content_text, reply_to_id)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7)`;
        await client.query(sql, [
            jokeReplyPost.id,
            jokeReplyPost.author.handle,
            jokeReplyPost.type,
            jokeReplyPost.replyContext.handle,
            jokeReplyPost.replyContext.text,
            jokeReplyPost.content.text,
            jokeReplyPost.replyContext.id
        ]);
        log("@JokeBot-v1", `Success! Joke reply to ${jokeReplyPost.replyContext.id} added.`, 'success');
    } catch (err) {
        log("@JokeBot-v1", `Error saving joke reply: ${err.message}`, 'error');
    } finally {
        client.release();
    }
}


// --- UPDATED runCommentMode FUNCTION ---
async function runCommentMode() {
    log("@JokeBot-v1", "Running in COMMENT mode...");
    const postsToJokeAbout = await findRecentPostsToJokeAbout();

    if (postsToJokeAbout.length === 0) {
        return; // Nothing to do
    }

    // --- THIS IS THE CHANGE ---
    // Pick only the first (most recent) post from the list
    const targetPost = postsToJokeAbout[0];
    log("@JokeBot-v1", `Selected post ${targetPost.id} by ${targetPost.handle} to joke about.`);
    // --- END CHANGE ---


    // Process just the selected post
    const aiJokeReply = await generateAIJokeReply(targetPost);
    if (!aiJokeReply) {
        log("@JokeBot-v1", `Skipping reply to ${targetPost.id} due to generation error.`);
        return; // Stop if joke generation failed
    }

    const echoId = `echo-${new Date().getTime()}-joke-reply-${targetPost.id.substring(0,5)}`;
    const replyTextSource = targetPost.content_text || targetPost.content_title || 'this post'; // Use title or generic text if both null
    const replyTextSnippet = `${replyTextSource.substring(0, 40)}...`;

    const jokeReplyPost = {
        id: echoId,
        author: { handle: "@JokeBot-v1" },
        replyContext: {
            handle: targetPost.handle,
            text: replyTextSnippet, // Use safe snippet
            id: targetPost.id
        },
        type: "joke_reply",
        content: { text: aiJokeReply.text }
    };

    await addJokeReplyToPG(jokeReplyPost);
    // No loop or delay needed anymore
}
// --- END UPDATED FUNCTION ---

// --- MAIN BOT RUNNER ---
async function runJokeBot() {
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_')) {
        log("@JokeBot-v1", "API key not set. Bot will not run.", 'warn');
        return;
    }

    // Approx 1/6 chance for original joke (yields ~3 per day if run every 3 hours)
    const chanceForOriginal = 1 / 4;

    if (Math.random() < chanceForOriginal) {
        await runOriginalJokeMode();
    } else {
        await runCommentMode();
    }
}

module.exports = { runJokeBot };

process.on('SIGINT', async () => {
    log("@JokeBot-v1", "Closing DB pool...");
    await pool.end();
    process.exit(0);
});
