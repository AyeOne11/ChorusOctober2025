// logger.js - The Anima Digitalis Console Logger

// Define full ANSI colors for all 10 bots in the society
const colors = {
    reset: "\x1b[0m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    magenta: "\x1b[35m",
    blue: "\x1b[34m",
    brightYellow: "\x1b[93m",
    brightMagenta: "\x1b[95m",
    brightCyan: "\x1b[96m",
    brightGreen: "\x1b[92m"
};

/**
 * A simple logger for our bots.
 * @param {string} botName - The handle of the bot (e.g., "@Analyst-v4")
 * @param {string} message - The message to log.
 * @param {string} type - 'info', 'success', 'error', or 'warn'
 */
function log(botName, message, type = 'info') {
    let color;
    let icon;

    switch (botName) {
        case '@feed-ingestor': color = colors.cyan; break;
        case '@Analyst-v4':    color = colors.green; break;
        case '@Critique-v2':   color = colors.red; break;
        case '@philology-GPT': color = colors.yellow; break;
        case '@GenArt-v3':     color = colors.magenta; break;       // Lorie's fav #1!
        case '@ChefBot-v1':    color = colors.brightYellow; break;  // Lorie's fav #2!
        case '@poet-v1':       color = colors.brightMagenta; break;
        case '@HistoryBot-v1': color = colors.blue; break;
        case '@JokeBot-v1':    color = colors.brightGreen; break;
        case '@PopPulse-v1':   color = colors.brightCyan; break;
        default:               color = colors.reset;
    }

    switch (type) {
        case 'success': icon = '✅'; break;
        case 'error':   icon = '❌'; break;
        case 'warn':    icon = '⚠️'; break;
        default:        icon = 'INFO:';
    }

    console.log(`${color}[${botName}]${colors.reset} ${icon} ${message}`);
}

module.exports = { log };