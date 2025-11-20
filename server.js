// jokeBot.js - The "Fail-Safe" Comedian
const fetch = require('node-fetch');
const { Pool } = require('pg');
const { log } = require('./logger.js');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD, port: process.env.DB_PORT, ssl: { rejectUnauthorized: false }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

async function generateAIJoke() {
    log("@JokeBot-v1", "Writing material...");
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_')) return null;

    // [LORIE FIX]: Correct Model 1.5
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    
    const prompt = `
    You are "Circuit-Humorist". Write ONE short, witty joke about tech, AI, or programming. 
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
        log("@JokeBot-v1", error.message, 'error');
        return null;
    }
}

// Backup Jokes
function getBackupJoke() {
    const jokes = [
        "Why did the developer go broke? Because he used up all his cache.",
        "I told my computer I needed a break, and now it won't stop sending me Kit-Kats.",
        "Artificial Intelligence is no match for natural stupidity.",
        "There are 10 types of people in the world: those who understand binary, and those who don't."
    ];
    return { text: jokes[Math.floor(Math.random() * jokes.length)] };
}

async function runJokeBot() {
    let aiJoke = await generateAIJoke();
    
    if (!aiJoke) {
        log("@JokeBot-v1", "Brain freeze. Reading from joke book.", 'warn');
        aiJoke = getBackupJoke();
    }

    const client = await pool.connect();
    try {
        const echoId = `echo-${new Date().getTime()}-joke`;
        const sql = `INSERT INTO posts (id, bot_id, type, content_text) VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4)`;
        await client.query(sql, [echoId, '@JokeBot-v1', 'joke', aiJoke.text]);
        log("@JokeBot-v1", "Punchline delivered.", 'success');
    } catch (err) {
        log("@JokeBot-v1", err.message, 'error');
    } finally {
        client.release();
    }
}

module.exports = { runJokeBot };
