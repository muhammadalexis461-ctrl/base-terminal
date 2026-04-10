const { ethers } = require("ethers");
const { runScan } = require("./lib/scanner");
require('dotenv').config();

const RPC_URL = process.env.CHAINSTACK_WSS;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x700d70d8d1D4833BCF882340E6b005B14FE542D4";

async function main() {
    const provider = new ethers.WebSocketProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, [
        "function strike(uint8 strategyId, uint256 amount, uint256 minAmountOut)"
    ], wallet);

    console.log("🤖 BOT STARTED | Monitoring Base Mainnet...");

    provider.on("block", async (blockNumber) => {
        const result = await runScan(1.2, provider);

        if (result && result.shouldStrike) {
            console.log(`🔥 [BLOCK ${blockNumber}] PROFIT DETECTED: $${result.netProfit.toFixed(2)}`);
            
            try {
                // minAmountOut set to 0 for maximum execution speed (rely on contract checks)
                const tx = await contract.strike(result.direction, ethers.parseEther("1.2"), 0, {
                    gasLimit: 400000 
                });
                console.log(`✅ Strike Sent: ${tx.hash}`);
                await tx.wait();
                console.log("💰 Strike Confirmed!");
            } catch (error) {
                console.log("❌ Strike Failed:", error.shortMessage || error.message);
            }
        }
    });

    // Keep connection alive
    provider._websocket.on("close", () => {
        console.log("WebSocket Closed. Restarting...");
        main();
    });
}

main();
