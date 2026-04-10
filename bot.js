const { ethers } = require("ethers");
const { runScan } = require("./lib/scanner");
require('dotenv').config();

// Configuration from Environment Variables
const RPC_URL = process.env.CHAINSTACK_WSS;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x700d70d8d1D4833BCF882340E6b005B14FE542D4";
const TRADE_SIZE = "1.2"; // Amount in ETH

async function main() {
    // 1. Safety Check for Variables
    if (!RPC_URL || !PRIVATE_KEY) {
        console.error("❌ ERROR: Missing CHAINSTACK_WSS or PRIVATE_KEY in Railway Variables.");
        process.exit(1);
    }

    console.log("🚀 BOT INITIALIZING...");

    try {
        // 2. Setup Provider & Wallet
        const provider = new ethers.WebSocketProvider(RPC_URL);
        const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

        // 3. Setup Contract Instance
        const contract = new ethers.Contract(CONTRACT_ADDRESS, [
            "function strike(uint8 strategyId, uint256 amount, uint256 minAmountOut)"
        ], wallet);

        console.log(`🤖 BOT ACTIVE | Wallet: ${wallet.address}`);
        console.log("📡 Monitoring Base Mainnet via WebSocket...");

        // 4. Block Listener (The Scan Trigger)
        provider.on("block", async (blockNumber) => {
            try {
                // Use the scanner logic to check prices
                const result = await runScan(TRADE_SIZE, provider);

                if (result && result.shouldStrike) {
                    console.log(`🔥 [BLOCK ${blockNumber}] OPPORTUNITY FOUND!`);
                    console.log(`Profit: $${result.netProfit.toFixed(2)} | Spread: ${result.spreadPercent.toFixed(3)}%`);
                    
                    // Execute Strike
                    const tx = await contract.strike(
                        result.direction,
