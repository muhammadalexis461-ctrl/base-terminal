const { ethers } = require("ethers");
const { runScan, runScanAll, dustCollectorScan, stablecoinPegMonitor, liquidationSentryListener } = require("./lib/scanner");
require('dotenv').config();

const RPC_URL = process.env.CHAINSTACK_WSS;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x700d70d8d1D4833BCF882340E6b005B14FE542D4";
const TRADE_SIZE = "1.2";

// ─── NEW STRATEGIES — feature toggles ────────────────────────────────────────
const ENABLE_DUST_COLLECTOR       = true;
const DUST_COLLECTOR_MIN_PROFIT   = 0.10;  // $0.10 minimum net profit
const DUST_COLLECTOR_MAX_GAS_GWEI = 0.1;   // Only execute when gas < 0.1 gwei
const DUST_COLLECTOR_TRADE_SIZE   = "1.0"; // 1 ETH — smaller size for thin spreads

const ENABLE_STABLECOIN_PEG_MONITOR = true;
const STABLECOIN_TRADE_SIZE         = "5.0"; // 5 ETH — larger size for rare depegs

const ENABLE_LIQUIDATION_SENTRY = true;
// ─────────────────────────────────────────────────────────────────────────────

// ─── Metrics ──────────────────────────────────────────────────────────────────
const metrics = {
    blocksScanned:           0,
    opportunitiesFound:      0,
    tradesExecuted:          0,
    // NEW STRATEGIES
    dustCollectorExecutions: 0,
    stablecoinExecutions:    0,
    liquidationOpportunities: 0,
};

function logMetrics() {
    console.log(
        `📊 METRICS | Blocks: ${metrics.blocksScanned} | ` +
        `Opportunities: ${metrics.opportunitiesFound} | ` +
        `Trades: ${metrics.tradesExecuted} | ` +
        `Dust Hits: ${metrics.dustCollectorExecutions} | ` +
        `Stablecoin Hits: ${metrics.stablecoinExecutions} | ` +
        `Liquidation Alerts: ${metrics.liquidationOpportunities}`
    );
}

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

        // ── Liquidation Sentry — register once at startup ─────────────────────
        if (ENABLE_LIQUIDATION_SENTRY) {
            try {
                liquidationSentryListener(provider);
            } catch (sentryErr) {
                console.error(`❌ Liquidation Sentry startup error: ${sentryErr.message}`);
            }
        }

        // ── Per-block listener ────────────────────────────────────────────────
        provider.on("block", async (blockNumber) => {
            metrics.blocksScanned++;

            // ── Core arbitrage scan (original — untouched) ────────────────────
            try {
                const result = await runScan(TRADE_SIZE, provider);
                if (result && result.shouldStrike) {
                    metrics.opportunitiesFound++;
                    console.log(`🔥 [BLOCK ${blockNumber}] OPPORTUNITY! Profit: ${result.netProfit.toFixed(2)}`);
                    const tx = await contract.strike(
                        result.direction,
                        ethers.parseEther(TRADE_SIZE),
                        0,
                        { gasLimit: 500000 }
                    );
                    console.log(`✅ Sent: ${tx.hash}`);
                    await tx.wait();
                    metrics.tradesExecuted++;
                }
            } catch (e) {
                console.error(`⚠️ Scan error: ${e.message}`);
            }

            // ── Dust Collector — every block, gas-gated internally ────────────
            if (ENABLE_DUST_COLLECTOR) {
                try {
                    const dust = await dustCollectorScan(
                        DUST_COLLECTOR_TRADE_SIZE,
                        DUST_COLLECTOR_MIN_PROFIT,
                        DUST_COLLECTOR_MAX_GAS_GWEI,
                        provider
                    );
                    if (dust && dust.shouldStrike) {
                        metrics.dustCollectorExecutions++;
                        console.log(
                            `🌫️  [BLOCK ${blockNumber}] DUST OPPORTUNITY | ` +
                            `Pair: ${dust.pair} | Profit: ${dust.netProfit.toFixed(3)} | ` +
                            `Gas: ${dust.gasUsd.toFixed(4)} | Direction: ${dust.direction === 0 ? "Uni→Aero" : "Aero→Uni"}`
                        );
                        const tx = await contract.strike(
                            dust.direction,
                            ethers.parseEther(DUST_COLLECTOR_TRADE_SIZE),
                            0,
                            { gasLimit: 400000 }
                        );
                        console.log(`✅ Dust tx sent: ${tx.hash}`);
                        await tx.wait();
                    }
                } catch (dustErr) {
                    console.error(`❌ Dust Collector error: ${dustErr.message}`);
                }
            }

            // ── Stablecoin Peg Monitor — every 10 blocks to reduce RPC load ───
            if (ENABLE_STABLECOIN_PEG_MONITOR && blockNumber % 10 === 0) {
                try {
                    const peg = await stablecoinPegMonitor(STABLECOIN_TRADE_SIZE, provider);
                    if (peg && peg.shouldStrike) {
                        metrics.stablecoinExecutions++;
                        console.log(
                            `💱 [BLOCK ${blockNumber}] STABLECOIN DEPEG | ` +
                            `Pair: ${peg.pair} | ` +
                            `Depeg: ${(peg.depegAmount * 100).toFixed(3)}% | ` +
                            `Uni Rate: ${peg.uniRate.toFixed(5)} | ` +
                            `Aero Rate: ${peg.aeroRate.toFixed(5)} | ` +
                            `Direction: ${peg.direction === 0 ? "Uni→Aero" : "Aero→Uni"}`
                        );
                        const tx = await contract.strike(
                            peg.direction,
                            ethers.parseEther(STABLECOIN_TRADE_SIZE),
                            0,
                            { gasLimit: 400000 }
                        );
                        console.log(`✅ Stablecoin arb tx sent: ${tx.hash}`);
                        await tx.wait();
                    }
                } catch (pegErr) {
                    console.error(`❌ Stablecoin Peg Monitor error: ${pegErr.message}`);
                }
            }

            // ── Periodic metrics log (every 100 blocks) ───────────────────────
            if (blockNumber % 100 === 0) {
                logMetrics();
            }
        });

        // ── Liquidation Sentry metrics hook ───────────────────────────────────
        // Patch console.log to count liquidation alerts without modifying scanner.js
        if (ENABLE_LIQUIDATION_SENTRY) {
            const _origLog = console.log.bind(console);
            console.log = (...args) => {
                if (typeof args[0] === "string" && args[0].startsWith("🚨 LIQUIDATION OPPORTUNITY")) {
                    metrics.liquidationOpportunities++;
                }
                _origLog(...args);
            };
        }

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

