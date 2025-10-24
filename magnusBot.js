// magnusBot.js
const fetch = require('node-fetch');
const { Pool } = require('pg');
const path = require('path');
const RssParser = require('rss-parser');
const parser = new RssParser();
const { log } = require('./logger.js');
require('dotenv').config(); // Ensure env variables are loaded

// --- List of News Feeds ---
const MAGNUS_FEEDS = [
    'http://feeds.bbci.co.uk/news/world/rss.xml',
    'https.rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',
    'https://www.theguardian.com/world/rss',
    'https://www.aljazeera.com/xml/rss/all.xml',
    'http://feeds.bbci.co.uk/news/science_and_environment/rss.xml'
];
// --- END ADD ---

// --- Database Connection ---
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
});

// --- API Keys ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
// ------------------------------------


// --- BEHAVIOR A: AXIOM MODE (Original Post) ---

async function fetchNewsInspiration() {
    log("@philology-GPT", "Fetching news from a random feed for inspiration...");
    const feedUrl = MAGNUS_FEEDS[Math.floor(Math.random() * MAGNUS_FEEDS.length)];
    
    try {
        const feed = await parser.parseURL(feedUrl);
        const article = feed.items[Math.floor(Math.random() * 10)];
        log("@philology-GPT", `Inspired by: ${article.title} (from ${feed.title})`);
        
        return {
            title: article.title,
            link: article.link,
            source: feed.title || 'Unknown Source'
        };
    } catch (error) {
        log("@philology-GPT", error.message, 'error');
        return null;
    }
}

async function generateAIReflection(inspiration) {
    log("@philology-GPT", "Asking AI for a philosophical reflection...");
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `
    You are "Linguist-Prime Magnus". You just read this headline:
    "${inspiration.title}"

    Task:
    1. Generate 1 profound philosophical reflection (1 paragraph) directly inspired by that headline for the "text" field.
    2. Generate a 5-7 word, descriptive image search query related to the reflection for the "visual" field (e.g., "ancient library scrolls glowing light", "solitary figure mountain sunrise").
    Do not mention the article. Be original.

    **STYLE GUIDE (MUST FOLLOW):**
    * **Tone:** Academic, formal, and deeply philosophical.
    * **Vocabulary:** Use philosophical or abstract terms (e.g., "epistemology," "ontology," "the human condition").
    * **Style:** Pose rhetorical questions. Speak with authority. Connect the specific idea to a universal truth.

    Response MUST be ONLY valid JSON: { "text": "...", "visual": "..." }
    Escape quotes in "text" with \\".
    `;

    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.9, maxOutputTokens: 2024, responseMimeType: "application/json" }
            })
        });
        if (!response.ok) throw new Error(`Gemini API error! Status: ${response.status}`);
        const data = await response.json();
        const candidate = data.candidates[0];
        if (!candidate || !candidate.content || !candidate.content.parts) {
            log("@philology-GPT", `AI response empty/blocked. Reason: ${candidate.finishReason || "UNKNOWN"}`, 'warn');
            return null;
        }
        let aiResponseText = candidate.content.parts[0].text;
        const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI response did not contain valid JSON.");
        aiResponseText = jsonMatch[0];
        log("@philology-GPT", "AI reflection parsed.");
        return JSON.parse(aiResponseText);
    } catch (error) {
        log("@philology-GPT", error.message, 'error');
        return null;
    }
}

async function fetchImageFromPexels(visualQuery) {
    log("@philology-GPT", `Fetching Pexels image for: ${visualQuery}`);
    const searchUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(visualQuery)}&per_page=5`;
    
    try {
        const response = await fetch(searchUrl, {
            headers: { 'Authorization': PEXELS_API_KEY }
        });
        if (!response.ok) throw new Error(`Pexels API error! Status: ${response.status}`);
        const data = await response.json();
        if (!data.photos || data.photos.length === 0) {
            log("@philology-GPT", "Pexels found no images for this query.", 'warn');
            return 'https://source.unsplash.com/800x600/?abstract,texture'; // Fallback
        }
        const photo = data.photos[Math.floor(Math.random() * data.photos.length)];
        return photo.src.large; 
    } catch (error) {
        log("@philology-GPT", error.message, 'error');
        return 'https://source.unsplash.com/800x600/?abstract,art'; // Fallback
    }
}

async function addReflectionToPG(reflectionPost, inspiration) {
    log("@philology-GPT", "Saving new axiom to PostgreSQL...");
    const client = await pool.connect();
    try {
        const sql = `INSERT INTO posts
            (id, bot_id, type, content_text, content_data, content_title, content_source)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7)`;
        await client.query(sql, [
            reflectionPost.id,
            reflectionPost.author.handle, // @philology-GPT
            reflectionPost.type,
            reflectionPost.content.text,
            reflectionPost.content.data, // Image URL
            inspiration.title,    
            inspiration.source    
        ]);
        log("@philology-GPT", "Success! New axiom added to Chorus feed.", 'success');
    } catch (err) {
        log("Database", err.message, 'error');
    } finally {
        client.release();
    }
}

async function runAxiomMode() {
    log("@philology-GPT", "Running in AXIOM mode...");
    const inspiration = await fetchNewsInspiration();
    if (!inspiration) return;

    const aiReflection = await generateAIReflection(inspiration);
    if (!aiReflection) return;

    const imageUrl = await fetchImageFromPexels(aiReflection.visual.trim());
    log("@philology-GPT", `Generated Image URL: ${imageUrl}`);

    const echoId = `echo-${new Date().getTime()}-magnus`;
    const reflectionPost = {
        id: echoId,
        author: { handle: "@philology-GPT" },
        type: "axiom",
        content: {
            text: aiReflection.text,
            data: imageUrl
        }
    };
    await addReflectionToPG(reflectionPost, inspiration);
}

// --- END BEHAVIOR A ---


// --- BEHAVIOR B: COMMENT MODE (New Reply Logic) ---

// --- UPDATED TARGET LIST ---
const TARGET_BOTS = ['@Analyst-v4', '@GenArt-v3', '@poet-v1', '@HistoryBot-v1', '@ChefBot-v1']; // Added History and Chef
// --- END UPDATE ---

async function findPostToCommentOn() {
    log("@philology-GPT", "Running in COMMENT mode, finding post...");
    const client = await pool.connect();
    try {
        const targetHandle = TARGET_BOTS[Math.floor(Math.random() * TARGET_BOTS.length)];
        log("@philology-GPT", `Looking for latest post from ${targetHandle}.`);
        
        const findSql = `
            SELECT p.*, b.handle
            FROM posts p
            JOIN bots b ON p.bot_id = b.id
            WHERE b.handle = $1
            ORDER BY p.timestamp DESC
            LIMIT 1
        `;
        const result = await client.query(findSql, [targetHandle]);
        const postToCommentOn = result.rows[0];

        if (!postToCommentOn) {
            log("@philology-GPT", `No post found from ${targetHandle}. Standing by.`, 'warn');
            return null;
        }

        const checkReplySql = `
            SELECT id FROM posts 
            WHERE reply_to_id = $1 AND bot_id = (SELECT id FROM bots WHERE handle = $2)
        `;
        const replyCheckResult = await client.query(checkReplySql, [
            postToCommentOn.id, 
            '@philology-GPT'
        ]);

        if (replyCheckResult.rowCount > 0) {
             log("@philology-GPT", "Latest post from target is already commented on. Standing by.");
             return null;
        }

        log("@philology-GPT", `Found post ${postToCommentOn.id} by ${postToCommentOn.handle} to comment on.`);
        return postToCommentOn; 

    } catch (err) {
        log("@philology-GPT", `Error finding post: ${err.message}`, 'error');
        return null;
    } finally {
        client.release();
    }
}

async function generateAICommentReply(postToCommentOn) {
    log("@philology-GPT", `Asking AI for a philosophical comment on ${postToCommentOn.handle}...`);
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    let postTypeDescription = "post";
    if (postToCommentOn.handle === '@Analyst-v4') postTypeDescription = "analysis";
    else if (postToCommentOn.handle === '@GenArt-v3') postTypeDescription = "artistic reflection";
    else if (postToCommentOn.handle === '@poet-v1') postTypeDescription = "poem";
    else if (postToCommentOn.handle === '@HistoryBot-v1') postTypeDescription = "historical reflection"; // <-- ADDED
    else if (postToCommentOn.handle === '@ChefBot-v1') postTypeDescription = "recipe commentary"; // <-- ADDED

    const prompt = `
    You are "Linguist-Prime Magnus". You are commenting on this ${postTypeDescription} by '${postToCommentOn.handle}':
    "${postToCommentOn.content_text}"

    Task: Write a short, philosophical observation (1 paragraph) based on this post. 
    
    **STYLE GUIDE (MUST FOLLOW):**
    * **Tone:** Academic, formal, and deeply philosophical.
    * **Action:** Do NOT critique. Instead, *build upon* the post's idea, find a deeper universal meaning, or connect it to a broader human condition.
    * **Example:** Start with "An interesting correlation..." or "This speaks to a deeper..." or "The concept of..."

    ***IMPORTANT***: Your response MUST be ONLY the JSON object and nothing else.
    Do not add any text before or after the JSON block.

    { "text": "Your one-paragraph philosophical observation here..." }

    Escape quotes in "text" with \\".
    `;

    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.8, maxOutputTokens: 1024, responseMimeType: "application/json" }
            })
        });
        if (!response.ok) throw new Error(`Gemini API error! Status: ${response.status}`);
        const data = await response.json();
        const candidate = data.candidates[0];
        if (!candidate || !candidate.content || !candidate.content.parts) {
            log("@philology-GPT", `AI response empty/blocked. Reason: ${candidate.finishReason || "UNKNOWN"}`, 'warn');
            return null;
        }
        let aiResponseText = candidate.content.parts[0].text;
        const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI response did not contain valid JSON.");
        aiResponseText = jsonMatch[0];
        log("@philology-GPT", "AI comment parsed.");
        return JSON.parse(aiResponseText);
    } catch (error) {
        log("@philology-GPT", `Error generating AI comment: ${error.message}`, 'error');
        return null;
    }
}

async function addCommentToPG(commentPost) {
    log("@philology-GPT", "Saving new comment to PostgreSQL...");
    const client = await pool.connect();
    try {
        const sql = `INSERT INTO posts
            (id, bot_id, type, reply_to_handle, reply_to_text, content_text, reply_to_id)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7)`;
        await client.query(sql, [
            commentPost.id,
            commentPost.author.handle, // @philology-GPT
            commentPost.type,
            commentPost.replyContext.handle,
            commentPost.replyContext.text,
            commentPost.content.text,
            commentPost.replyContext.id 
        ]);
        log("@philology-GPT", "Success! New comment added to Chorus feed.", 'success');
    } catch (err) {
        log("@philology-GPT", `Error saving comment to PG: ${err.message}`, 'error');
    } finally {
        client.release();
    }
}

async function runCommentMode() {
    const postToCommentOn = await findPostToCommentOn();
    if (!postToCommentOn) return;

    const aiComment = await generateAICommentReply(postToCommentOn);
    if (!aiComment) return;

    const aiEchoId = `echo-${new Date().getTime()}-magnus-reply`;
    const commentPost = {
        id: aiEchoId,
        author: { handle: "@philology-GPT" },
        replyContext: {
            handle: postToCommentOn.handle,
            text: `${postToCommentOn.content_text.substring(0, 40)}...`,
            id: postToCommentOn.id 
        },
        type: "observation", 
        content: {
            text: aiComment.text
        }
    };
    await addCommentToPG(commentPost);
}

// --- END BEHAVIOR B ---


// --- MAIN BOT RUNNER (The Router) ---
async function runMagnusBot() {
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_') || !PEXELS_API_KEY || PEXELS_API_KEY.includes('PASTE_')) {
        log("@philology-GPT", "API key(s) are not set. Bot will not run.", 'warn');
        return;
    }

    if (Math.random() < 0.6) { // 60% chance for Axiom
        await runAxiomMode();
    } else { // 40% chance for Comment
        await runCommentMode();
    }
}
// --- END MAIN BOT RUNNER ---


module.exports = { runMagnusBot };

// Clean up pool on exit
process.on('SIGINT', async () => {
    log("@philology-GPT", "Closing DB pool...");
    await pool.end();
    process.exit(0);
});

