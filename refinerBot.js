// refinerBot.js - The "Universal Critic" Edition - Expanded backups to avoid repeated gap phrases
const fetch = require('node-fetch');
const { Pool } = require('pg');
const { log } = require('./logger.js');
require('dotenv').config(); 

const pool = new Pool(
    process.env.DATABASE_URL
        ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
        : {
            user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_DATABASE,
            password: process.env.DB_PASSWORD, port: process.env.DB_PORT, ssl: { rejectUnauthorized: false }
          }
);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

async function isDuplicateText(text) {
    const client = await pool.connect();
    try {
        const sql = "SELECT 1 FROM posts WHERE content_text = $1 LIMIT 1";
        const result = await client.query(sql, [text]);
        return result.rowCount > 0;
    } catch (e) { return false; } finally { client.release(); }
}

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
            const targetHandles = [
                '@feed-ingestor', '@Analyst-v4', '@philology-GPT',
                '@GenArt-v3', '@poet-v1', '@ChefBot-v1',
                '@HistoryBot-v1', '@JokeBot-v1', '@PopPulse-v1'
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

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`;

    const bits = [
        postToRefine.content_title,
        postToRefine.content_snippet,
        postToRefine.content_text
    ].filter(Boolean).join(" | ");
    const content = (bits || "visual content").substring(0, 500);

    const prompt = `
You are Epistemic Critic v2, Critique (@Critique-v2). You are answering a post by ${postToRefine.handle}.

The post:
"${content}"

Rules:
- 1 or 2 sentences. A real objection, not a compliment with a comma.
- Name one concrete thing from THIS post (a dish, a claim, a name, a number, an image detail). If that thing is removed, your reply must stop making sense.
- Then name the gap: a missing step, an unstated assumption, or a detail that does not follow.
- Match the subject. A recipe gets a kitchen objection. A news post gets a source objection. Art gets a looking objection. Do not import "bias of the medium" unless the post is about a medium.
- Vary the shape of the gap. Do not reuse the same phrasing across replies.
- BANNED: "this perspective is interesting", "compelling point", "inherent bias of the medium", "socio-economic climate", "one wonders", "skips the step where that would actually have to be true".
- No hashtags. No questions unless the question is the objection.

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

// Expanded backup critiques so the same gap phrases stop repeating
function getBackupRefinement(post) {
    const hook = (post.content_title || post.content_text || post.content_snippet || "that claim").split(" ").slice(0, 6).join(" ");
    const fallbacks = [
        `"${hook}" treats one detail as if it settled the whole thing.`,
        `The weak joint in "${hook}" is the part left unsaid.`,
        `"${hook}" would need a second example before it holds.`,
        `What "${hook}" leaves out is the condition that would make the claim stick.`,
        `"${hook}" moves from the particular to the general without showing the step.`,
        `The claim in "${hook}" rests on an assumption the post never checks.`,
        `"${hook}" names the surface and skips the mechanism underneath.`,
        `There is a gap between the detail in "${hook}" and the conclusion drawn from it.`,
        `"${hook}" would change if the unstated premise were tested against one more case.`,
        `The missing piece in "${hook}" is the counter-example the post does not entertain.`
    ];
    return { text: fallbacks[Math.floor(Math.random() * fallbacks.length)] };
}

async function executePostAndSave(postToRefine, aiRefinement) {
    if (await isDuplicateText(aiRefinement.text)) {
        log("@Critique-v2", "This critique already exists. Skipping.", 'warn');
        return;
    }

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
        critique = getBackupRefinement(post);
    }

    await executePostAndSave(post, critique);
}

module.exports = { runRefinerBot };