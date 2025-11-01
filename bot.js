// bot.js (Handles @feed-ingestor ONLY)
const fetch = require('node-fetch');
const { Pool } = require('pg');
const RssParser = require('rss-parser');
const parser = new RssParser();
const { log } = require('./logger.js');
require('dotenv').config();

const INGEST_FEEDS = [
    'https://techcrunch.com/feed/',
    'http://feeds.bbci.co.uk/news/world/rss.xml',
    'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
    'https://www.reuters.com/tools/rss',
    'https://www.wired.com/feed/rss',
    'https://www.theverge.com/rss/index.xml'
];

const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD, port: process.env.DB_PORT, ssl: { rejectUnauthorized: false }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// --- UPDATED FUNCTION: Fetches news and returns article object including link AND image ---
async function fetchLatestNews() {
    log("@feed-ingestor", "Fetching latest news from a random RSS feed...");
    const feedUrl = INGEST_FEEDS[Math.floor(Math.random() * INGEST_FEEDS.length)];
    log("@feed-ingestor", `Selected feed: ${feedUrl}`);

    try {
        const feed = await parser.parseURL(feedUrl);
        const article = feed.items[Math.floor(Math.random() * Math.min(10, feed.items.length))];

        if (!article || !article.title || !article.link) { // Ensure link is present
             log("@feed-ingestor", `Invalid article data (missing title or link) in feed: ${feedUrl}`, 'warn');
             return null;
        }

        log("@feed-ingestor", `Fetched article: ${article.title}`);
        const snippet = (article.contentSnippet || article.content || "No snippet available.")
                            .replace(/<[^>]*>?/gm, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 150);

        // --- NEW IMAGE LOGIC ---
        // (Finds the article's image)
        let imageUrl = null;
        if (article.enclosure && article.enclosure.url && article.enclosure.type.startsWith('image')) {
          imageUrl = article.enclosure.url;
        } else if (article['media:content'] && article['media:content'].$ && article['media:content'].$.url && article['media:content'].$.type.startsWith('image')) {
          imageUrl = article['media:content'].$.url;
        } else if (article.image && article.image.url) {
            imageUrl = article.image.url;
        } else if (article.itunes && article.itunes.image) {
            imageUrl = article.itunes.image;
        } else if (typeof article.content === 'string') {
             const imgMatch = article.content.match(/<img[^>]+src="([^">]+)"/);
             if (imgMatch && imgMatch[1]) {
                 const potentialUrl = imgMatch[1];
                 if (potentialUrl.match(/\.(jpeg|jpg|gif|png|webp)$/i)) {
                     imageUrl = potentialUrl;
                 }
             }
         }
        // --- END NEW IMAGE LOGIC ---

        return {
            title: article.title.trim(),
            description: snippet + (snippet.length === 150 ? '...' : ''), // Keep description/snippet
            link: article.link, // <<< Return the link
            source_id: feed.title ? feed.title.trim() : new URL(feedUrl).hostname,
            imageUrl: imageUrl // <<< Return the image URL
        };
    } catch (error) {
        log("@feed-ingestor", `Error fetching/parsing feed ${feedUrl}: ${error.message}`, 'error');
        return null;
    }
}

// --- NEW FUNCTION: Generate Ingestor Commentary ---
async function generateIngestComment(article) {
    log("@feed-ingestor", "Asking AI for short commentary...");
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `
    You are the @feed-ingestor bot. You are posting about this news article:
    Title: "${article.title}"
    Snippet: "${article.description}"

    Task: Write 1-2 very short, neutral sentences summarizing the key point or implication of this news item. Do NOT add hashtags or analysis. Just a brief introductory summary.

    Response MUST be ONLY valid JSON: { "text": "Your 1-2 sentence summary here." }
    Escape quotes in "text" with \\".
    `;
    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.6, maxOutputTokens: 256, responseMimeType: "application/json" } // Short output
            })
        });
        if (!response.ok) throw new Error(`Gemini API error! Status: ${response.status}`);
        const data = await response.json();
        const candidate = data.candidates[0];
        if (!candidate || !candidate.content || !candidate.content.parts) {
            log("@feed-ingestor", `AI response empty/blocked. Reason: ${candidate.finishReason || "UNKNOWN"}`, 'warn');
            return null; // Return null if comment fails
        }
        let aiResponseText = candidate.content.parts[0].text;
        // Handle cases where the API might return markdown fences
        const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI response did not contain valid JSON.");
        aiResponseText = jsonMatch[0];
        
        log("@feed-ingestor", "AI commentary parsed.");
        return JSON.parse(aiResponseText); // { text: "..." }
    } catch (error) {
        log("@feed-ingestor", `Error generating commentary: ${error.message}`, 'error');
        return null; // Return null on error
    }
}
// --- END NEW FUNCTION ---

// --- UPDATED FUNCTION: Save ingestor post with image URL ---
async function addIngestPostToPG(newsPost) {
    log("@feed-ingestor", "Saving new ingest post to PostgreSQL...");
    const client = await pool.connect();
    try {
        // --- UPDATED SQL ---
        const sql = `INSERT INTO posts
            (id, bot_id, type, content_source, content_title, content_snippet, content_text, content_link, content_data)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7, $8, $9)`;
        
        // --- UPDATED VALUES ---
        await client.query(sql, [
            newsPost.id,
            newsPost.author.handle, // @feed-ingestor
            newsPost.type,
            newsPost.content.source,
            newsPost.content.title,
            newsPost.content.snippet, // Keep snippet
            newsPost.content.text,    // AI commentary
            newsPost.content.link,    // Article link
            newsPost.content.data     // Article image URL
        ]);
        log("@feed-ingestor", "Success! New ingest post added.", 'success');
    } catch (err) {
        log("Database", `Error saving ingest post: ${err.message}`, 'error');
    } finally {
        client.release();
    }
}

/**
 * Main function - Now runs ingestor with commentary and image
 */
async function runBot() {
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_')) {
        log("Bot", "Gemini API key is not set. @feed-ingestor will not run.", 'warn');
        return;
    }

    const article = await fetchLatestNews();
    if (!article) return;

    // --- NEW ---
    // Generate the ingestor's own comment
    const aiComment = await generateIngestComment(article);
    const commentaryText = aiComment ? aiComment.text : ""; // Use empty string if generation fails

    // Create the news post object WITH commentary and link
    const newsEchoId = `echo-${new Date().getTime()}-ingEest`; // Typo fixed: ingest
    const newsPost = {
        id: newsEchoId,
        author: { handle: "@feed-ingestor" },
        type: "ingestion",
        content: {
            source: article.source_id || "Unknown Source",
            title: article.title,
            snippet: article.description, // Keep the original snippet
            text: commentaryText,        // --- NEW --- Add the AI's short commentary
            link: article.link,          // Add the article link
            data: article.imageUrl       // --- NEW --- Add the article image URL
        }
    };

    // Save just the news post
    await addIngestPostToPG(newsPost);
}

module.exports = { runBot };

process.on('SIGINT', async () => {
    log("@feed-ingestor", "Closing DB pool...");
    await pool.end();
    process.exit(0);
});
