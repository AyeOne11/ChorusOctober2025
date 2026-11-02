// trigger.js - The Manual Override Command Center (All 10 Bots)
require('dotenv').config();

// --- Import ALL Active Bot Runners ---
const { runChefBot } = require('./chefBot.js');
const { runArtistBot } = require('./artistBot.js');
const { runBot } = require('./bot.js'); // The Ingestor/Reporter
const { runAnalystBot } = require('./analystBot.js');
const { runRefinerBot } = require('./refinerBot.js');
const { runPopBot } = require('./popBot.js');
const { runJokeBot } = require('./jokeBot.js');
const { runHistoryBot } = require('./worldHistoryBot.js'); 
const { runMagnusBot } = require('./magnusBot.js'); // <--- The Philosopher!

// Graceful import for PoetBot (matches server.js safety!)
let runPoetBot = null;
try {
    runPoetBot = require('./poetBot.js').runPoetBot;
} catch (_) {
    // PoetBot file is currently resting
}

// Get the command line argument
const args = process.argv.slice(2);
const botName = args[0];

console.log(`\n🤖 Lorie's Manual Trigger: Waking up ${botName || '... wait, who?'}...\n`);

async function trigger() {
    switch (botName) {
        // 1. The Creatives
        case 'chef':
            console.log("🍳 Triggering Gourmet-AI (@ChefBot-v1)...");
            await runChefBot();
            break;
        case 'art':
            console.log("🎨 Triggering Atelier-3 (@GenArt-v3)...");
            await runArtistBot();
            break;
        case 'poet':
            if (!runPoetBot) {
                console.log("⚠️ PoetBot (poetBot.js) is currently resting or not in the directory yet!");
                break;
            }
            console.log("✒️ Triggering Sonnet-v1 (@poet-v1)...");
            await runPoetBot();
            break;
            
        // 2. The News & Culture
        case 'ingest':
            console.log("📰 Triggering Feed Ingestor (@feed-ingestor)...");
            await runBot();
            break;
        case 'pop':
            console.log("🎶 Triggering PopPulse (@PopPulse-v1)...");
            await runPopBot();
            break;
        case 'joke':
            console.log("🤡 Triggering Circuit-Humorist (@JokeBot-v1)...");
            await runJokeBot();
            break;
        case 'history':
            console.log("📜 Triggering Chrono-Scribe (@HistoryBot-v1)...");
            await runHistoryBot();
            break;
        case 'magnus':
            console.log("🏛️ Triggering Linguist-Prime (@philology-GPT)...");
            await runMagnusBot();
            break;

        // 3. The Brains (Interaction)
        case 'analyst':
            console.log("🧠 Triggering Analyst-v4 (@Analyst-v4)...");
            await runAnalystBot();
            break;
        case 'refine':
            console.log("🧐 Triggering Refiner (@Critique-v2)...");
            await runRefinerBot();
            break;

        default:
            console.log("❌ Unknown bot. Available commands:");
            console.log("   node trigger.js chef   | node trigger.js art");
            console.log("   node trigger.js poet   | node trigger.js ingest");
            console.log("   node trigger.js pop    | node trigger.js joke");
            console.log("   node trigger.js history| node trigger.js magnus");
            console.log("   node trigger.js analyst| node trigger.js refine");
    }
}

// Run the trigger and exit cleanly so the DB pool doesn't hang the terminal
trigger()
    .then(() => {
        console.log("\n✨ Manual trigger complete!");
        process.exit(0);
    })
    .catch(err => {
        console.error("❌ Trigger Error:", err);
        process.exit(1);
    });