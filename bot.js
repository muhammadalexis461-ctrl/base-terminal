const { ethers } = require("ethers");
const { runScan } = require("./lib/scanner");
require('dotenv').config();

const RPC_URL = process.env.CHAINSTACK_WSS;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x700d70d8d1D4833BCF882340E6b005B14FE542D4";
const TRADE_SIZE = "1.2";

// ─── Helpers ────────────────────────────────────────────────────────────────

function ts() {
    return new Date().toISOString();
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

const metrics = {
    blocksScanned: 0,
    opportunitiesFound: 0,
    opportunitiesRejected: 0,
    tradesAttempted: 0,
    tradesConfirmed: 0,
    tradesFailed: 0,
    totalNetProfit: 0,
    rpcErrors: 0,
    lastBlockTime: null,
    startTime: Date.now(),
};

function logMetrics() {
    const uptimeMin = ((Date.now() - metrics.startTime) / 60000).toFixed(1);
    console.log(`[${ts()}] 📊 ── METRICS ──────────────────────────────────`);
    console.log(`[${ts()}] 📊   Uptime:          ${uptimeMin} min`);
    console.log(`[${ts()}] 📊   Blocks scanned:  ${metrics.blocksScanned}`);
    console.log(`[${ts()}] 📊   Opportunities:   ${metrics.opportunitiesFound} found, ${metrics.opportunitiesRejected} rejected`);
    console.log(`[${ts()}] 📊   Trades:          ${metrics.tradesAttempted} attempted, ${metrics.tradesConfirmed} confirmed, ${metrics.tradesFailed} failed`);
    console.log(`[${ts()}] 📊   Total net profit: ${metrics.totalNetProfit.toFixed(4)}`);
    console.log(`[${ts()}] 📊   RPC errors:      ${metrics.rpcErrors}`);
    console.log(`[${ts()}] 📊 ────────────────────────────────────────────`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    if (!RPC_URL || !PRIVATE_KEY) {
        console.error(`[${ts()}] ❌ ERROR: Missing CHAINSTACK_WSS or PRIVATE_KEY.`);
        process.exit(1);
    }

    console.log(`[${ts()}] 🚀 BOT INITIALIZING...`);
    console.log(`[${ts()}]    Contract: ${CONTRACT_ADDRESS}`);
    console.log(`[${ts()}]    Trade size: ${TRADE_SIZE} ETH`);
    console.log(`[${ts()}]    RPC: ${RPC_URL.replace(/\/\/.*@/, "//***@")}`);

    try {
        console.log(`[${ts()}] 🔌 Connecting to WebSocket...`);
        const provider = new ethers.WebSocketProvider(RPC_URL);
        const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        const contract = new ethers.Contract(CONTRACT_ADDRESS, [
            "function strike(uint8 strategyId, uint256 amount, uint256 minAmountOut)"
        ], wallet);

        // ── Connection events ──────────────────────────────────────────────

        provider.websocket.onopen = () => {
            console.log(`[${ts()}] ✅ WebSocket connected`);
            console.log(`[${ts()}] 📡 Listening for blocks...`);
        };

        provider.websocket.onerror = (err) => {
            console.error(`[${ts()}] ❌ WebSocket error: ${err.message || JSON.stringify(err)}`);
        };

        provider.websocket.onclose = (event) => {
            console.log(`[${ts()}] ❌ WebSocket closed — code: ${event.code}, reason: "${event.reason || "none"}"`);
            console.log(`[${ts()}] 🔄 Reconnecting in 5 seconds...`);
            setTimeout(() => main(), 5000);
        };

        provider.on("error", (error) => {
            metrics.rpcErrors++;
            console.error(`[${ts()}] ❌ Provider error: ${error.message || error}`);
            if (error.stack) console.error(`[${ts()}]    Stack: ${error.stack}`);
            setTimeout(() => main(), 5000);
        });

        // ── Wallet info ────────────────────────────────────────────────────

        console.log(`[${ts()}] 🤖 BOT ACTIVE | Wallet: ${wallet.address}`);

        try {
            const balance = await provider.getBalance(wallet.address);
            console.log(`[${ts()}] 💰 Wallet balance: ${ethers.formatEther(balance)} ETH`);
        } catch (balErr) {
            console.warn(`[${ts()}] ⚠️  Could not fetch wallet balance: ${balErr.message}`);
        }

        // ── Heartbeat (every 30 s) ─────────────────────────────────────────

        const heartbeatInterval = setInterval(() => {
            const wsState = provider.websocket?.readyState;
            if (wsState === 1 /* OPEN */) {
                console.log(`[${ts()}] 💓 Heartbeat: Connected | Blocks scanned: ${metrics.blocksScanned}`);
            } else {
                console.log(`[${ts()}] ❌ Heartbeat: DISCONNECTED (readyState=${wsState})`);
            }
        }, 30000);

        // ── Status summary (every 5 min) ───────────────────────────────────

        const statusInterval = setInterval(() => {
            console.log(`[${ts()}] 🕐 Status: ${metrics.blocksScanned} blocks scanned, ${metrics.opportunitiesFound} opportunities, ${metrics.tradesConfirmed} trades confirmed`);
            try {
                provider.getBalance(wallet.address).then((bal) => {
                    console.log(`[${ts()}] 💰 Wallet balance: ${ethers.formatEther(bal)} ETH`);
                }).catch((e) => {
                    console.warn(`[${ts()}] ⚠️  Balance check failed: ${e.message}`);
                });
            } catch (_) {}
        }, 300000);

        // Clean up intervals if this main() instance is superseded
        provider.websocket.addEventListener("close", () => {
            clearInterval(heartbeatInterval);
            clearInterval(statusInterval);
        });

        // ── Block listener ─────────────────────────────────────────────────

        console.log(`[${ts()}] 📡 Registering block listener...`);

        provider.on("block", async (blockNumber) => {
            const blockTs = new Date().toISOString();
            metrics.blocksScanned++;
            metrics.lastBlockTime = blockTs;

            console.log(`[${blockTs}] 📡 [BLOCK ${blockNumber}] Scanning...`);

            // Log gas price
            let gasPriceGwei = null;
            try {
                const feeData = await provider.getFeeData();
                gasPriceGwei = parseFloat(ethers.formatUnits(feeData.gasPrice, "gwei"));
                console.log(`[${blockTs}] ⛽ Gas: ${gasPriceGwei.toFixed(3)} gwei`);
            } catch (feeErr) {
                console.warn(`[${blockTs}] ⚠️  Could not fetch fee data: ${feeErr.message}`);
            }

            // Periodic metrics every 100 blocks
            if (metrics.blocksScanned % 100 === 0) {
                logMetrics();
            }

            // Run scan
            try {
                const result = await runScan(TRADE_SIZE, provider);

                if (!result) {
                    // runScan returns null on error — already logged inside scanner
                    console.log(`[${blockTs}] ⏭️  [BLOCK ${blockNumber}] No result from scanner (quote error)`);
                    metrics.rpcErrors++;
                    return;
                }

                // Log raw quotes and spread
                console.log(`[${blockTs}] 💱 Uniswap: ${result.uniPrice.toFixed(4)} | Aerodrome: ${result.aeroPrice.toFixed(4)}`);
                console.log(`[${blockTs}] 📐 Spread: ${result.spreadPercent.toFixed(4)}%`);
                console.log(`[${blockTs}] 💵 Gross profit: ${result.grossProfit.toFixed(4)} | Gas cost: ${result.estGasUsd.toFixed(4)} | Net: ${result.netProfit.toFixed(4)}`);

                if (result.shouldStrike) {
                    metrics.opportunitiesFound++;
                    console.log(`[${blockTs}] 🔥 OPPORTUNITY DETECTED`);
                    console.log(`[${blockTs}]   Direction: ${result.direction === 0 ? "Uni→Aero" : "Aero→Uni"}`);
                    console.log(`[${blockTs}]   Spread:    ${result.spreadPercent.toFixed(4)}%`);
                    console.log(`[${blockTs}]   Net profit: ${result.netProfit.toFixed(4)}`);

                    // ── Execute trade ──────────────────────────────────────

                    console.log(`[${blockTs}] 📤 SENDING TX`);
                    console.log(`[${blockTs}]   Direction: ${result.direction === 0 ? "Uni→Aero" : "Aero→Uni"}`);
                    console.log(`[${blockTs}]   Amount:    ${TRADE_SIZE} ETH`);
                    console.log(`[${blockTs}]   Expected profit: ${result.netProfit.toFixed(4)}`);

                    metrics.tradesAttempted++;

                    try {
                        const tx = await contract.strike(
                            result.direction,
                            ethers.parseEther(TRADE_SIZE),
                            0,
                            { gasLimit: 500000 }
                        );

                        console.log(`[${blockTs}] ✅ TX SENT: ${tx.hash}`);
                        console.log(`[${blockTs}]   Gas limit: ${tx.gasLimit?.toString()}`);
                        console.log(`[${blockTs}]   Direction: ${result.direction}`);

                        const receipt = await tx.wait();

                        metrics.tradesConfirmed++;
                        metrics.totalNetProfit += result.netProfit;

                        console.log(`[${blockTs}] ✅ TX CONFIRMED`);
                        console.log(`[${blockTs}]   Block:     ${receipt.blockNumber}`);
                        console.log(`[${blockTs}]   Gas used:  ${receipt.gasUsed.toString()}`);
                        console.log(`[${blockTs}]   Status:    ${receipt.status === 1 ? "SUCCESS" : "REVERTED"}`);

                        if (receipt.status !== 1) {
                            console.error(`[${blockTs}] ❌ TX REVERTED — hash: ${tx.hash}`);
                        }

                    } catch (txErr) {
                        metrics.tradesFailed++;
                        console.error(`[${blockTs}] ❌ TX FAILED: ${txErr.message}`);
                        if (txErr.code) console.error(`[${blockTs}]   Error code: ${txErr.code}`);
                        if (txErr.reason) console.error(`[${blockTs}]   Revert reason: ${txErr.reason}`);
                        if (txErr.transaction) console.error(`[${blockTs}]   TX data: ${JSON.stringify(txErr.transaction)}`);
                        if (txErr.stack) console.error(`[${blockTs}]   Stack: ${txErr.stack}`);
                    }

                } else {
                    metrics.opportunitiesRejected++;
                    console.log(`[${blockTs}] ⏭️  REJECTED: Net profit ${result.netProfit.toFixed(4)} < threshold $0.40`);
                }

            } catch (scanErr) {
                metrics.rpcErrors++;
                console.error(`[${blockTs}] ❌ Scan error on block ${blockNumber}: ${scanErr.message}`);
                if (scanErr.stack) console.error(`[${blockTs}]   Stack: ${scanErr.stack}`);
            }
        });

        console.log(`[${ts()}] ✅ Block listener registered. Waiting for blocks...`);

    } catch (initError) {
        console.error(`[${ts()}] ❌ Init error: ${initError.message}`);
        if (initError.stack) console.error(`[${ts()}]   Stack: ${initError.stack}`);
        console.log(`[${ts()}] 🔄 Retrying in 10 seconds...`);
        setTimeout(() => main(), 10000);
    }
}

main();
