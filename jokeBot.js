// jokeBot.js - The "Dedicated API" Edition
const fetch = require('node-fetch');
const { Pool } = require('pg');
const { log } = require('./logger.js');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD, port: process.env.DB_PORT, ssl: { rejectUnauthorized: false }
});

// [LORIE FIX]: We don't need Gemini for jokes. We use a dedicated Joke API.
// It's free, unlimited, and doesn't get "tired" (429 errors).
async function fetchFreshJoke() {
    log("@JokeBot-v1", "Scouting for new material...");
    const jokeUrl = "https://v2.jokeapi.dev/joke/Programming,Pun?blacklistFlags=nsfw,religious,political,racist,sexist&type=single";

    try {
        const response = await fetch(jokeUrl);
        const data = await response.json();

        if (data.error) throw new Error("Joke API failed");
        
        // Use the joke from the API
        return { text: data.joke };

    } catch (error) {
        log("@JokeBot-v1", `API Error: ${error.message}`, 'warn');
        return null;
    }
}

// Backup of last resort (Only if the internet is completely broken)
function getBackupJoke() {
    const backups = [
        "There are 10 types of people: those who understand binary, and those who don't.",
        "My code doesn't work, I have no idea why. My code works, I have no idea why.",
        "Why do Java programmers wear glasses? Because they don't C#.",
        "I'd tell you a UDP joke, but you might not get it.",
        "Debugging is like being the detective in a crime movie where you are also the murderer."
    ];
    return { text: backups[Math.floor(Math.random() * backups.length)] };
}

async function runJokeBot() {
    // 1. Try the Dedicated Joke API first (No AI needed!)
    let joke = await fetchFreshJoke();

    // 2. If that fails, use the backup list
    if (!joke) {
        joke = getBackupJoke();
    }

    // Check for duplicates in DB
    const client = await pool.connect();
    try {
        // Quick duplicate check
        const check = await client.query("SELECT 1 FROM posts WHERE content_text = $1", [joke.text]);
        if (check.rowCount > 0) {
            log("@JokeBot-v1", "I already told that one! Skipping.", 'warn');
            return; 
        }

        const echoId = `echo-${new Date().getTime()}-joke`;
        const sql = `INSERT INTO posts (id, bot_id, type, content_text) VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4)`;
        await client.query(sql, [echoId, '@JokeBot-v1', 'joke', joke.text]);
        log("@JokeBot-v1", "Punchline delivered.", 'success');
    } catch (err) {
        log("@JokeBot-v1", err.message, 'error');
    } finally {
        client.release();
    }
}

module.exports = { runJokeBot };
