const { ethers } = require("ethers");
const { runScan } = require("./lib/scanner");
require('dotenv').config();

const RPC_URL = process.env.CHAINSTACK_WSS;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x700d70d8d1D4833BCF882340E6b005B14FE542D4";
const TRADE_SIZE = "1.2"; 

async function main() {
    if (!RPC_URL || !PRIVATE_KEY) {
        console.error("❌ ERROR: Missing CHAINSTACK_WSS or PRIVATE_KEY.");
        process.exit(1);
    }

    console.log("🚀 BOT INITIALIZING...");

    try {
        const provider = new ethers.WebSocketProvider(RPC_URL);
        const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        const contract = new ethers.Contract(CONTRACT_ADDRESS, [
            "function strike(uint8 strategyId, uint256 amount, uint256 minAmountOut)"
        ], wallet);

        console.log(`🤖 BOT ACTIVE | Wallet: ${wallet.address}`);

        provider.on("block", async (blockNumber) => {
            try {
                const result = await runScan(TRADE_SIZE, provider);
                if (result && result.shouldStrike) {
                    console.log(`🔥 [BLOCK ${blockNumber}] OPPORTUNITY! Profit: $${result.netProfit.toFixed(2)}`);
                    const tx = await contract.strike(
                        result.direction, 
                        ethers.parseEther(TRADE_SIZE), 
                        0, 
                        { gasLimit: 500000 }
                    );
                    console.log(`✅ Sent: ${tx.hash}`);
                    await tx.wait();
                }
            } catch (e) {
                console.error(`⚠️ Scan error: ${e.message}`);
            }
        });

        provider.on("error", (error) => {
            console.error("❌ Provider Error:", error);
            setTimeout(() => main(), 5000);
        });

        if (provider.websocket) {
            provider.websocket.onclose = () => {
                console.log("⚠️ Connection closed. Restarting...");
                setTimeout(() => main(), 5000);
            };
        }
    } catch (initError) {
        console.error("❌ Init Error:", initError.message);
        setTimeout(() => main(), 10000);
    }
}

main(); // <--- Ensure this line is here!
