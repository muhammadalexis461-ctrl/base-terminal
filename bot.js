const { ethers } = require("ethers");
const { runScan } = require("./lib/scanner");
require('dotenv').config();

const RPC_URL = process.env.CHAINSTACK_WSS;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x700d70d8d1D4833BCF882340E6b005B14FE542D4";
const TRADE_SIZE = "1.2";

const metrics = { blocksScanned: 0 };

function ts() {
    return new Date().toISOString();
}

async function main() {
    if (!RPC_URL || !PRIVATE_KEY) {
        console.error(`[${ts()}] ❌ ERROR: Missing CHAINSTACK_WSS or PRIVATE_KEY.`);
        process.exit(1);
    }

    console.log(`[${ts()}] 🚀 BOT INITIALIZING...`);

    try {
        console.log(`[${ts()}] 🔌 Connecting to WebSocket...`);

        const provider = new ethers.WebSocketProvider(RPC_URL);

        if (!provider.websocket) {
            throw new Error("provider.websocket is null — WebSocket failed to initialize");
        }

        // Attach onclose/onerror IMMEDIATELY before any await, so they are
        // never missed regardless of how quickly the socket transitions state.
        provider.websocket.onerror = (err) => {
            console.error(`[${ts()}] ❌ WebSocket error: ${err.message || JSON.stringify(err)}`);
        };

        provider.websocket.onclose = (event) => {
            console.log(`[${ts()}] ❌ WebSocket closed — code: ${event.code}`);
            setTimeout(() => main(), 5000);
        };

        // Wait for the connection to open, with a hard 10-second timeout so
        // a hanging TCP handshake doesn't silently stall the bot forever.
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("WebSocket connection timeout (10s)"));
            }, 10000);

            provider.websocket.onopen = () => {
                clearTimeout(timeout);
                console.log(`[${ts()}] ✅ WebSocket connected`);
                resolve();
            };

            // If the socket is already open by the time we attach the handler
            // (unlikely but possible), resolve immediately.
            if (provider.websocket.readyState === 1 /* OPEN */) {
                clearTimeout(timeout);
                console.log(`[${ts()}] ✅ WebSocket already open`);
                resolve();
            }
        });

        const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        const contract = new ethers.Contract(CONTRACT_ADDRESS, [
            "function strike(uint8 strategyId, uint256 amount, uint256 minAmountOut)"
        ], wallet);

        console.log(`[${ts()}] 🤖 BOT ACTIVE | Wallet: ${wallet.address}`);
        console.log(`[${ts()}] 📡 Registering block listener...`);

        provider.on("block", async (blockNumber) => {
            metrics.blocksScanned++;
            try {
                const result = await runScan(TRADE_SIZE, provider);
                if (result && result.shouldStrike) {
                    console.log(`[${ts()}] 🔥 [BLOCK ${blockNumber}] OPPORTUNITY! Profit: ${result.netProfit.toFixed(2)}`);
                    const tx = await contract.strike(
                        result.direction,
                        ethers.parseEther(TRADE_SIZE),
                        0,
                        { gasLimit: 500000 }
                    );
                    console.log(`[${ts()}] ✅ Sent: ${tx.hash}`);
                    await tx.wait();
                }
            } catch (e) {
                console.error(`[${ts()}] ⚠️ Scan error: ${e.message}`);
                if (e.stack) console.error(e.stack);
            }
        });

        provider.on("error", (error) => {
            console.error(`[${ts()}] ❌ Provider error: ${error.message || error}`);
            if (error.stack) console.error(error.stack);
            setTimeout(() => main(), 5000);
        });

        console.log(`[${ts()}] ✅ Block listener registered. Waiting for blocks...`);

        // If no blocks arrive within 30 seconds the RPC subscription likely
        // silently failed — restart so the connection is re-established.
        setTimeout(() => {
            if (metrics.blocksScanned === 0) {
                console.error(`[${ts()}] ❌ No blocks received in 30 seconds — restarting...`);
                setTimeout(() => main(), 5000);
            }
        }, 30000);

    } catch (initError) {
        console.error(`[${ts()}] ❌ Init error: ${initError.message}`);
        if (initError.stack) console.error(initError.stack);
        console.log(`[${ts()}] 🔄 Retrying in 10 seconds...`);
        setTimeout(() => main(), 10000);
    }
}

main();
