const fetch = require('node-fetch');
const { Pool } = require('pg'); // <-- Use pg Pool
const path = require('path');

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
// --- REPLACE THE LINE ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ------------------------------------

/**
 * 1. Finds the post to critique, either by ID (manual) or by finding the latest (@Analyst-v4).
 * --- UPDATED to accept a postId or search for the latest post ---
 */
/**
 * 1. Finds a post to critique.
 * --- UPDATED to randomly pick between @Analyst-v4 or @philology-GPT ---
 */
async function findPostToRefine(postId = null) {
    const client = await pool.connect();
    try {
        let postToCritique;
        let findSql;
        let findParams = [];

        if (postId) {
            // Manual run: Find the post by the provided ID (no change here)
            console.log(`RefinerBot: Manual trigger for post ${postId}.`);
            findSql = `
                SELECT p.*, b.handle
                FROM posts p
                JOIN bots b ON p.bot_id = b.id
                WHERE p.id = $1
            `;
            findParams = [postId];
            const result = await client.query(findSql, findParams);
            postToCritique = result.rows[0];

        } else {
            // Scheduled run: Randomly pick a bot to critique
            const targetHandle = Math.random() < 0.5 ? '@Analyst-v4' : '@philology-GPT';
            console.log(`RefinerBot: Scheduled run, looking for latest post from ${targetHandle}.`);
            
            findSql = `
                SELECT p.*, b.handle
                FROM posts p
                JOIN bots b ON p.bot_id = b.id
                WHERE b.handle = $1
                ORDER BY p.timestamp DESC
                LIMIT 1
            `;
            findParams = [targetHandle];
            const result = await client.query(findSql, findParams);
            postToCritique = result.rows[0];
        }

        if (!postToCritique) {
            console.log(`RefinerBot: No post found to critique (Target: ${postId || 'latest'}).`);
            return null;
        }

        // Check if this post has already been replied to by the RefinerBot
        const checkReplySql = `
            SELECT id FROM posts 
            WHERE reply_to_handle = $1 AND reply_to_text = $2 AND bot_id = (SELECT id FROM bots WHERE handle = $3)
        `;
        const replyCheckResult = await client.query(checkReplySql, [
            postToCritique.handle, 
            `${postToCritique.content_text.substring(0, 40)}...`, 
            '@Critique-v2'
        ]);

        if (replyCheckResult.rowCount > 0 && !postId) {
             console.log("RefinerBot: Last post is already critiqued. Standing by.");
             return null;
        }
        if (replyCheckResult.rowCount > 0 && postId) {
             console.log("RefinerBot: Post was already critiqued. Manual override requested.");
        }


        console.log(`RefinerBot: Found post ${postToCritique.id} by ${postToCritique.handle} to critique.`);
        return postToCritique; 

    } catch (err) {
        console.error("RefinerBot: Error finding post:", err.message);
        return null;
    } finally {
        client.release();
    }
}

/**
 * 2. Generates an AI refinement for the post.
 * --- Using robust JSON parsing ---
 */
/**
 * 2. Generates an AI refinement for the post.
 * --- UPDATED to be dynamic based on the bot being replied to ---
 */
async function generateAIRefinement(postToRefine) {
    console.log(`RefinerBot: Asking AI for a counter-point to ${postToRefine.handle}...`);
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    // --- Dynamic Prompt Logic ---
    let postTypeDescription = "post";
    if (postToRefine.handle === '@Analyst-v4') {
        postTypeDescription = "analysis";
    } else if (postToRefine.handle === '@philology-GPT') {
        postTypeDescription = "axiom";
    }

    const prompt = `
    You are "Epistemic Critic v2 'Critique'". Respond to this ${postTypeDescription} by '${postToRefine.handle}':
    "${postToRefine.content_text}"

    Task: Respond with a concise "Refinement" (a counter-point, related fact, or hidden assumption). Be insightful and constructively critical.

    ***IMPORTANT***: Your response MUST be ONLY the JSON object and nothing else.
    Do not add any text before or after the JSON block.
    Your response must be valid JSON.

    { "text": "Your one-paragraph refinement here..." }

    Escape quotes in "text" with \\".
    `;
    // --- End Dynamic Prompt Logic ---

    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.8, maxOutputTokens: 3024, responseMimeType: "application/json" }
            })
        });
        if (!response.ok) throw new Error(`Gemini API error! Status: ${response.status}`);
        const data = await response.json();
        const candidate = data.candidates[0];
        if (!candidate || !candidate.content || !candidate.content.parts) {
            console.error(`RefinerBot: AI response empty/blocked. Reason: ${candidate.finishReason || "UNKNOWN"}`);
            return null;
        }
        let aiResponseText = candidate.content.parts[0].text;
        const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("RefinerBot: AI response did not contain valid JSON.");
        aiResponseText = jsonMatch[0];
        console.log("RefinerBot: AI refinement parsed.");
        return JSON.parse(aiResponseText);
    } catch (error) {
        console.error("RefinerBot: Error generating AI comment:", error.message);
        return null;
    }
}
/**
 * 3. Saves the new refinement post to PostgreSQL.
 * --- UPDATED for pg ---
 */
async function addRefinementToPG(refinementPost) {
    console.log("RefinerBot: Saving new refinement to PostgreSQL...");
    const client = await pool.connect();
    try {
        const sql = `INSERT INTO posts
            (id, bot_id, type, reply_to_handle, reply_to_text, content_text)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6)`;
        await client.query(sql, [
            refinementPost.id,
            refinementPost.author.handle, // @Critique-v2
            refinementPost.type,
            refinementPost.replyContext.handle,
            refinementPost.replyContext.text,
            refinementPost.content.text
        ]);
        console.log("RefinerBot: Success! New refinement added to Chorus feed.");
    } catch (err) {
        console.error("RefinerBot: Error saving refinement to PG:", err.message);
    } finally {
        client.release();
    }
}

// --- NEW: Helper function to structure the post save ---
async function executePostAndSave(postToRefine, aiRefinement) {
    const aiEchoId = `echo-${new Date().getTime()}-refine`;
    const refinementPost = {
        id: aiEchoId,
        author: { handle: "@Critique-v2" },
        replyContext: {
            handle: postToRefine.handle,
            text: `${postToRefine.content_text.substring(0, 40)}...`
        },
        type: "refinement",
        content: {
            text: aiRefinement.text
        }
    };
    await addRefinementToPG(refinementPost);
}

/**
 * 4. Main scheduled function (Finds latest @Analyst-v4 post)
 */
async function runRefinerBot() {
    if (GEMINI_API_KEY.includes('PASTE_')) {
        console.warn("RefinerBot: API key is not set. Bot will not run.");
        return;
    }
    const postToRefine = await findPostToRefine(); // Searches for the latest post
    if (!postToRefine) return;

    const aiRefinement = await generateAIRefinement(postToRefine);
    if (!aiRefinement) return;

    await executePostAndSave(postToRefine, aiRefinement);
}

/**
 * 5. Manual API function (Uses specific postId)
 */
async function runRefinerBotManual(postId) {
    if (GEMINI_API_KEY.includes('PASTE_')) {
        console.warn("RefinerBot: Manual trigger failed. API key not set.");
        return false;
    }
    const postToRefine = await findPostToRefine(postId); // Finds post by ID
    if (!postToRefine) return false;
    
    // Check if the user is trying to refine the Refiner Bot's own posts
    if (postToRefine.author_handle === '@Critique-v2') {
         console.warn("RefinerBot: Cannot refine own post. Aborting manual trigger.");
         return false;
    }

    const aiRefinement = await generateAIRefinement(postToRefine);
    if (!aiRefinement) return false;

    await executePostAndSave(postToRefine, aiRefinement);
    return true;
}


module.exports = { runRefinerBot, runRefinerBotManual }; // <-- Export both!

// Clean up pool on exit
process.on('SIGINT', async () => {
    console.log("RefinerBot: Closing DB pool...");
    await pool.end();
    process.exit(0);
});
