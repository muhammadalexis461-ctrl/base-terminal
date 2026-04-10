const { ethers } = require("ethers");
const { runScan, logMetrics, metrics } = require("./lib/scanner");
require('dotenv').config();

// ─── Configuration ────────────────────────────────────────────────────────────
const RPC_URL          = process.env.CHAINSTACK_WSS;
const PRIVATE_KEY      = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x700d70d8d1D4833BCF882340E6b005B14FE542D4";
const TRADE_SIZE       = "2.5"; // ETH — increased from 1.2 for higher profit per trade

// MEV Protection — Private RPC (optional but recommended):
//   Set PRIVATE_RPC_URL in your .env to route strike() transactions through a
//   private mempool (e.g. Flashbots: https://rpc.flashbots.net, or MEV-Blocker:
//   https://rpc.mevblocker.io). Scanning still uses the public WebSocket RPC;
//   only execution is routed privately, preventing sandwich attacks.
const PRIVATE_RPC_URL  = process.env.PRIVATE_RPC_URL || null;

// Log performance metrics every N blocks
const METRICS_INTERVAL = 100;

async function main() {
    if (!RPC_URL || !PRIVATE_KEY) {
        console.error("❌ ERROR: Missing CHAINSTACK_WSS or PRIVATE_KEY.");
        process.exit(1);
    }

    console.log("🚀 BOT INITIALIZING...");
    console.log(`   Trade size      : ${TRADE_SIZE} ETH`);
    console.log(`   Private RPC     : ${PRIVATE_RPC_URL ? "enabled ✅" : "disabled (public RPC) ⚠️"}`);

    try {
        // Scanning provider — public WebSocket for low-latency block subscription
        const provider = new ethers.WebSocketProvider(RPC_URL);

        // Execution provider — use private RPC if configured, otherwise fall back
        // to the same public provider (less MEV-safe but functional)
        const execProvider = PRIVATE_RPC_URL
            ? new ethers.JsonRpcProvider(PRIVATE_RPC_URL)
            : provider;

        const wallet   = new ethers.Wallet(PRIVATE_KEY, execProvider);
        const contract = new ethers.Contract(CONTRACT_ADDRESS, [
            "function strike(uint8 strategyId, uint256 amount, uint256 minAmountOut)"
        ], wallet);

        console.log(`🤖 BOT ACTIVE | Wallet: ${wallet.address}`);

        provider.on("block", async (blockNumber) => {
            // Log metrics every METRICS_INTERVAL blocks
            if (blockNumber % METRICS_INTERVAL === 0) {
                logMetrics(blockNumber);
            }

            try {
                const result = await runScan(TRADE_SIZE, provider);

                if (result && result.shouldStrike) {
                    console.log(
                        `🔥 [BLOCK ${blockNumber}] OPPORTUNITY on ${result.pair}!` +
                        ` Profit: ${result.netProfit.toFixed(4)}` +
                        ` | Gas: ${result.gasUsd.toFixed(4)}` +
                        ` | Spread: ${result.spreadPercent.toFixed(4)}%`
                    );

                    try {
                        const tx = await contract.strike(
                            result.direction,
                            ethers.parseEther(TRADE_SIZE),
                            result.minAmountOut, // 0.5% slippage protection
                            { gasLimit: 500000 }
                        );
                        console.log(`✅ Sent: ${tx.hash}`);
                        const receipt = await tx.wait();

                        // Update metrics on confirmed execution
                        metrics.executions++;
                        metrics.totalProfitUsd  += result.netProfit;
                        metrics.totalGasCostUsd += result.gasUsd;

                        console.log(
                            `🏁 Confirmed in block ${receipt.blockNumber}` +
                            ` | Cumulative P&L: ${(metrics.totalProfitUsd - metrics.totalGasCostUsd).toFixed(4)}`
                        );
                    } catch (txErr) {
                        console.error(`❌ Transaction failed: ${txErr.message}`);
                    }
                }
            } catch (e) {
                console.error(`⚠️ Scan error [block ${blockNumber}]: ${e.message}`);
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

main();
