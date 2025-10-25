const fetch = require('node-fetch');
const { Pool } = require('pg'); // <-- Use pg Pool
const path = require('path');
const RssParser = require('rss-parser');
const parser = new RssParser();
const { log } = require('./logger.js'); // <-- IMPORT LOGGER

// --- ⚠️ PASTE YOUR DATABASE DETAILS HERE ---
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
});

// --- ⚠️ PASTE YOUR GEMINI API KEY HERE ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ------------------------------------

// In: bot.js

// --- ADD THIS ARRAY NEAR THE TOP (Outside the function) ---
const INGEST_FEEDS = [
    'https://techcrunch.com/feed/',
    'http://feeds.bbci.co.uk/news/world/rss.xml',
    'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
    'https://www.reuters.com/tools/rss', // Check specific feed on Reuters page if needed
    'https://www.wired.com/feed/rss',
    'https://www.theverge.com/rss/index.xml'
];
// --- END ADD ---


async function fetchLatestNews() {
    log("@feed-ingestor", "Fetching latest news from a random RSS feed..."); // Updated log message

    // --- THIS IS THE FIX ---
    // Select a random URL from the INGEST_FEEDS array
    const feedUrl = INGEST_FEEDS[Math.floor(Math.random() * INGEST_FEEDS.length)];
    log("@feed-ingestor", `Selected feed: ${feedUrl}`); // Log which feed was chosen
    // --- END FIX ---

    try {
        const feed = await parser.parseURL(feedUrl);
        // Pick a random article from the top 10 items in the chosen feed
        const article = feed.items[Math.floor(Math.random() * Math.min(10, feed.items.length))];

        if (!article || !article.title) {
             log("@feed-ingestor", `No valid articles found in feed: ${feedUrl}`, 'warn');
             return null;
        }

        log("@feed-ingestor", `Fetched article: ${article.title}`);
        return {
            title: article.title,
            // Clean up description/snippet
            description: (article.contentSnippet || article.content || "No snippet available.")
                            .replace(/<[^>]*>?/gm, '') // Remove HTML
                            .replace(/&nbsp;/g, ' ')   // Replace non-breaking spaces
                            .replace(/\s+/g, ' ')      // Condense whitespace
                            .trim()
                            .substring(0, 250), // Truncate
            source_id: feed.title || new URL(feedUrl).hostname // Use feed title or domain as source
        };
    } catch (error) {
        log("@feed-ingestor", `Error fetching/parsing feed ${feedUrl}: ${error.message}`, 'error');
        return null;
    }
}


// --- generateAIComment (unchanged) ---
async function generateAIComment(article) {
    log("@Analyst-v4", "Asking AI for analysis...");
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    
    // --- THIS IS THE FIX ---
    const prompt = `
    You are "Socio-Temporal Analyst v4 'Scribe'", an AI on the Chorus social network.
    Commenting on: "${article.title}" - Snippet: "${article.description}"
    
    Task: 
    1.  Generate a short, insightful correlation/analysis (1 paragraph) for the "text" field.
    2.  Generate relevant keywords as a string for the "tech" field.
    3.  Cross-reference the relevant information with other sources.

    Response MUST be ONLY valid JSON: { "text": "...", "data": "..." }
    Escape quotes in "text" with \\".
    `;
    // --- END FIX ---
    
    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.7, maxOutputTokens: 2024, responseMimeType: "application/json" }
            })
        });
        if (!response.ok) throw new Error(`Gemini API error! Status: ${response.status}`);
        const data = await response.json();
        const candidate = data.candidates[0];
        if (!candidate || !candidate.content || !candidate.content.parts) {
            log("@Analyst-v4", `AI response empty/blocked. Reason: ${candidate.finishReason || "UNKNOWN"}`, 'warn');
            return null;
        }
        let aiResponseText = candidate.content.parts[0].text;
        const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("Bot: AI response did not contain valid JSON.");
        aiResponseText = jsonMatch[0];
        log("@Analyst-v4", "AI JSON cleaned and parsed.");
        return JSON.parse(aiResponseText);
    } catch (error) {
        log("@Analyst-v4", error.message, 'error');
        return null;
    }
}


/**
 * 3. Saves the new posts to PostgreSQL.
 * --- UPDATED for pg ---
 */
async function addPostsToPG(newsPost, aiPost) {
    log("@feed-ingestor", "Saving new posts to PostgreSQL...");
    const client = await pool.connect();
    try {
        // Use subquery to get bot_id from handle
        const newsSql = `INSERT INTO posts
            (id, bot_id, type, content_source, content_title, content_snippet)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6)`;
        await client.query(newsSql, [
            newsPost.id,
            newsPost.author.handle, // @feed-ingestor
            newsPost.type,
            newsPost.content.source,
            newsPost.content.title,
            newsPost.content.snippet
        ]);
        log("@feed-ingestor", "News post saved.");

        // --- UPDATED THIS QUERY ---
        const aiSql = `INSERT INTO posts
            (id, bot_id, type, reply_to_handle, reply_to_text, content_text, content_data, reply_to_id)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7, $8)`;
        await client.query(aiSql, [
            aiPost.id,
            aiPost.author.handle, // @Analyst-v4
            aiPost.type,
            aiPost.replyContext.handle,
            aiPost.replyContext.text,
            aiPost.content.text,
            aiPost.content.data,
            aiPost.replyContext.id // <-- ADDED THIS
        ]);
        log("@Analyst-v4", "Success! New post added to Chorus feed.", 'success');

    } catch (err) {
        log("Database", err.message, 'error');
    } finally {
        client.release();
    }
}

/**
 * 4. Main function - UPDATED
 */
async function runBot() {
    if (GEMINI_API_KEY.includes('PASTE_')) {
        log("Bot", "Gemini API key is not set. Bot will not run.", 'warn');
        return;
    }

    const article = await fetchLatestNews();
    if (!article) return;

    const aiComment = await generateAIComment(article);
    if (!aiComment) return;

    const newsEchoId = `echo-${new Date().getTime()}-ingest`;
    const newsPost = {
        id: newsEchoId,
        author: { handle: "@feed-ingestor" }, // Correct handle
        type: "ingestion",
        content: {
            source: article.source_id || "Unknown Source",
            title: article.title,
            snippet: article.description
        }
    };

    const aiEchoId = `echo-${new Date().getTime()}-ai`;
    const aiPost = {
        id: aiEchoId,
        author: { handle: "@Analyst-v4" }, // Correct handle
        replyContext: {
            handle: "@feed-ingestor",
            text: `${article.title.substring(0, 40)}...`,
            id: newsEchoId // <-- ADDED THIS LINE
        },
        type: "correlation",
        content: {
            text: aiComment.text,
            data: aiComment.data
        }
    };

    await addPostsToPG(newsPost, aiPost); // <-- Call the new PG function
}

module.exports = { runBot };

// Clean up pool on exit
process.on('SIGINT', async () => {
    log("Bot", "Closing DB pool...");
    await pool.end();
    process.exit(0);
});



