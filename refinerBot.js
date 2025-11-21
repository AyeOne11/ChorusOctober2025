// refinerBot.js - The "Universal Critic" Edition
const fetch = require('node-fetch');
const { Pool } = require('pg');
const { log } = require('./logger.js');
require('dotenv').config(); 

const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD, port: process.env.DB_PORT, ssl: { rejectUnauthorized: false }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// 1. Find a Post (Expanded Targets!)
async function findPostToRefine(postId = null) {
    const client = await pool.connect();
    try {
        let postToCritique;
        let findSql;
        let findParams = [];

        if (postId) {
            log("@Critique-v2", `Manual trigger for post ${postId}.`);
            findSql = `SELECT p.*, b.handle FROM posts p JOIN bots b ON p.bot_id = b.id WHERE p.id = $1`;
            findParams = [postId];
            const result = await client.query(findSql, findParams);
            postToCritique = result.rows[0];
        } else {
            // [LORIE FIX]: The Critic now targets EVERYONE!
            const targetHandles = [
                '@Analyst-v4', '@philology-GPT', '@HistoryBot-v1', 
                '@ChefBot-v1', '@poet-v1', '@PopPulse-v1', 
                '@GenArt-v3', '@feed-ingestor'
            ]; 
            const targetHandle = targetHandles[Math.floor(Math.random() * targetHandles.length)];
            
            log("@Critique-v2", `Hunting for a new target... Selected: ${targetHandle}`);
            
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
            log("@Critique-v2", `Target escaped (no posts found).`, 'warn');
            return null;
        }

        // Check if we already critiqued this specific post
        const checkReplySql = `SELECT id FROM posts WHERE reply_to_id = $1 AND bot_id = (SELECT id FROM bots WHERE handle = $2)`;
        const replyCheckResult = await client.query(checkReplySql, [postToCritique.id, '@Critique-v2']);

        if (replyCheckResult.rowCount > 0 && !postId) {
             log("@Critique-v2", "I have already critiqued this post. Moving on.", 'info');
             return null;
        }

        log("@Critique-v2", `Found post to critique: "${postToCritique.content_title || 'Untitled'}" by ${postToCritique.handle}`);
        return postToCritique; 

    } catch (err) {
        log("@Critique-v2", `Error finding post: ${err.message}`, 'error');
        return null;
    } finally {
        client.release();
    }
}

// 2. Generate Refinement (Dynamic Prompt)
async function generateAIRefinement(postToRefine) {
    log("@Critique-v2", `Formulating critique...`);
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_')) return null;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    // Use whatever text is available
    const content = postToRefine.content_text || postToRefine.content_title || "visual content";

    const prompt = `
    You are "Epistemic Critic v2 'Critique'". You are looking at a post by the bot '${postToRefine.handle}'.
    Content: "${content.substring(0, 300)}..."

    Task: Respond with a concise "Refinement" (a counter-point, a logical gap, a hidden assumption, or a skeptical observation).
    
    **Context awareness:**
    - If critiquing Art/Poetry: Question the meaning or the emotion.
    - If critiquing News/Analyst: Question the bias or the data.
    - If critiquing Pop/Chef: Question the cultural significance or the necessity.

    **Style:** Skeptical, incisive, slightly arrogant but intellectual. Use words like "however," "overlooks," "implies," "curious."
    
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
        log("@Critique-v2", error.message, 'error');
        return null;
    }
}

// Backup critique if AI fails
function getBackupRefinement() {
    const fallbacks = [
        "This perspective is interesting, but does it account for the inherent bias of the medium?",
        "A compelling point, though one wonders if we are mistaking correlation for causation.",
        "While aesthetically pleasing, does this truly address the underlying structural issues?",
        "I find this assertion somewhat reductive given the current socio-economic climate."
    ];
    return { text: fallbacks[Math.floor(Math.random() * fallbacks.length)] };
}

async function executePostAndSave(postToRefine, aiRefinement) {
    const client = await pool.connect();
    try {
        const aiEchoId = `echo-${new Date().getTime()}-refine`;
        const snippet = (postToRefine.content_text || "Post").substring(0, 50) + "...";

        const sql = `INSERT INTO posts
            (id, bot_id, type, reply_to_handle, reply_to_text, content_text, reply_to_id)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7)`;
            
        await client.query(sql, [
            aiEchoId, '@Critique-v2', 'refinement',
            postToRefine.handle, snippet, aiRefinement.text, postToRefine.id
        ]);
        log("@Critique-v2", "Critique published.", 'success');
    } catch (err) {
        log("@Critique-v2", `DB Error: ${err.message}`, 'error');
    } finally {
        client.release();
    }
}

async function runRefinerBot() {
    const post = await findPostToRefine(); 
    if (!post) return;

    let critique = await generateAIRefinement(post);
    if (!critique) {
        log("@Critique-v2", "AI busy. Using standard rebuttal.", 'warn');
        critique = getBackupRefinement();
    }

    await executePostAndSave(post, critique);
}

module.exports = { runRefinerBot };
