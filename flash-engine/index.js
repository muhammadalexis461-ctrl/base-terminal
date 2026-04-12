"use strict";

/**
 * Flash-Engine-V2-LowComp — Node.js arbitrage bot
 *
 * Monitors every Base block for a profitable WETH/USDC spread between
 * Uniswap V3 and Aerodrome.  When the net profit exceeds MIN_PROFIT_USD
 * it calls FlashArbitrageV2.initiateFlashLoan(), which borrows from
 * Balancer V2 (0% fee), executes both swap legs atomically, and repays
 * Balancer — all in a single transaction that reverts if unprofitable.
 *
 * Environment variables (see .env.example):
 *   BASE_RPC_URL          — WebSocket RPC endpoint for Base mainnet
 *   PRIVATE_KEY           — Wallet private key (must hold ETH for gas)
 *   CONTRACT_ADDRESS      — Deployed FlashArbitrageV2 contract address
 *   BALANCER_VAULT_ADDRESS— Balancer V2 Vault (default provided)
 *   FLASH_LOAN_AMOUNT     — WETH amount to borrow in wei (default 1 ETH)
 *   MIN_PROFIT_USD        — Minimum net profit in USD to trigger (default 0.50)
 */

const { ethers } = require("ethers");
require("dotenv").config();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RPC_URL          = process.env.BASE_RPC_URL;
const PRIVATE_KEY      = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const MIN_PROFIT_USD   = parseFloat(process.env.MIN_PROFIT_USD  || "0.50");
const FLASH_LOAN_AMOUNT = BigInt(
    process.env.FLASH_LOAN_AMOUNT || "1000000000000000000" // 1 WETH default
);

// Base mainnet addresses
const BALANCER_VAULT   = process.env.BALANCER_VAULT_ADDRESS ||
                         "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const UNI_QUOTER       = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const AERO_ROUTER      = "0xcF77a3Ba9A5CA399AF7227c0A3DA9651f42a0321";
const WETH             = "0x4200000000000000000000000000000000000006";
const USDC             = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Uniswap V3 pool fee tier: 0.05 %
const UNI_FEE = 500;

// Estimated gas cost per arbitrage transaction on Base (in USD).
// Base L2 fees are very low; $0.30–$0.80 covers most scenarios.
const EST_GAS_USD = 0.60;

// ---------------------------------------------------------------------------
// ABIs (minimal subsets)
// ---------------------------------------------------------------------------

const QUOTER_ABI = [
    "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) public returns (uint256 amountOut)"
];

const AERO_ROUTER_ABI = [
    "function getAmountOut(uint256 amountIn, address tokenIn, address tokenOut) public view returns (uint256 amountOut, bool stable)"
];

const CONTRACT_ABI = [
    "function initiateFlashLoan(address tokenAddress, uint256 amount, uint8 direction, uint256 gasCostUsdc) external",
    "event ArbitrageExecuted(uint8 direction, uint256 loanAmount, uint256 profit)",
    "event FlashLoanInitiated(address indexed token, uint256 amount, uint8 direction)"
];

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const metrics = {
    blocksScanned:    0,
    opportunitiesFound: 0,
    executionsAttempted: 0,
    executionsSucceeded: 0,
    totalProfitUsd:   0,
    startTime:        Date.now()
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ts() {
    return new Date().toISOString();
}

function logMetrics() {
    const uptimeSec = Math.floor((Date.now() - metrics.startTime) / 1000);
    console.log(
        `\n📊 METRICS | uptime=${uptimeSec}s` +
        ` blocks=${metrics.blocksScanned}` +
        ` opps=${metrics.opportunitiesFound}` +
        ` execs=${metrics.executionsAttempted}` +
        ` success=${metrics.executionsSucceeded}` +
        ` totalProfit=$${metrics.totalProfitUsd.toFixed(2)}\n`
    );
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

/**
 * Quotes both DEXes for WETH → USDC and returns the spread analysis.
 *
 * @param {ethers.Contract} quoter   Uniswap V3 QuoterV2 contract
 * @param {ethers.Contract} router   Aerodrome Router contract
 * @param {bigint}          amountIn WETH amount in wei
 * @returns {{ uniOutUsd, aeroOutUsd, direction, netProfitUsd } | null}
 */
async function quoteBothDexes(quoter, router, amountIn) {
    let uniOut, aeroOut;

    try {
        uniOut = await quoter.quoteExactInputSingle.staticCall(
            WETH, USDC, UNI_FEE, amountIn, 0
        );
    } catch {
        return null; // Uniswap quote failed — skip block
    }

    try {
        const result = await router.getAmountOut(amountIn, WETH, USDC);
        aeroOut = result.amountOut;
    } catch {
        return null; // Aerodrome quote failed — skip block
    }

    // USDC has 6 decimals
    const uniOutUsd  = parseFloat(ethers.formatUnits(uniOut,  6));
    const aeroOutUsd = parseFloat(ethers.formatUnits(aeroOut, 6));

    // Best output determines direction
    const bestOutUsd  = Math.max(uniOutUsd, aeroOutUsd);
    const direction   = uniOutUsd < aeroOutUsd ? 0 : 1; // 0=Uni→Aero, 1=Aero→Uni

    // Loan value in USD (approximated as the lower of the two quotes)
    const loanValueUsd = Math.min(uniOutUsd, aeroOutUsd);

    const grossProfitUsd = bestOutUsd - loanValueUsd;
    const netProfitUsd   = grossProfitUsd - EST_GAS_USD;

    return { uniOutUsd, aeroOutUsd, direction, netProfitUsd, grossProfitUsd };
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
    // Validate required env vars
    if (!RPC_URL) {
        console.error("❌ BASE_RPC_URL is not set. Check your .env file.");
        process.exit(1);
    }
    if (!PRIVATE_KEY) {
        console.error("❌ PRIVATE_KEY is not set. Check your .env file.");
        process.exit(1);
    }
    if (!CONTRACT_ADDRESS) {
        console.error("❌ CONTRACT_ADDRESS is not set. Deploy the contract first.");
        process.exit(1);
    }

    console.log("🚀 Flash-Engine-V2-LowComp initializing...");
    console.log(`   RPC          : ${RPC_URL}`);
    console.log(`   Contract     : ${CONTRACT_ADDRESS}`);
    console.log(`   Loan amount  : ${ethers.formatEther(FLASH_LOAN_AMOUNT)} WETH`);
    console.log(`   Min profit   : $${MIN_PROFIT_USD}`);
    console.log(`   Est gas cost : $${EST_GAS_USD}`);
    console.log(`   Balancer Vault: ${BALANCER_VAULT}\n`);

    let provider, wallet, contract, quoter, router;

    function connect() {
        try {
            provider = new ethers.WebSocketProvider(RPC_URL);
            wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
            contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
            quoter   = new ethers.Contract(UNI_QUOTER,  QUOTER_ABI,      provider);
            router   = new ethers.Contract(AERO_ROUTER, AERO_ROUTER_ABI, provider);

            console.log(`✅ [${ts()}] Connected | Wallet: ${wallet.address}`);

            // Listen for successful arbitrage events from the contract
            contract.on("ArbitrageExecuted", (direction, loanAmount, profit) => {
                const profitUsd = parseFloat(ethers.formatUnits(profit, 6));
                metrics.executionsSucceeded++;
                metrics.totalProfitUsd += profitUsd;
                console.log(
                    `💰 [${ts()}] ArbitrageExecuted` +
                    ` | dir=${direction}` +
                    ` | loan=${ethers.formatEther(loanAmount)} WETH` +
                    ` | profit=$${profitUsd.toFixed(4)}`
                );
            });

            // Block listener — core scanning loop
            provider.on("block", async (blockNumber) => {
                metrics.blocksScanned++;

                try {
                    const scan = await quoteBothDexes(quoter, router, FLASH_LOAN_AMOUNT);

                    if (!scan) return; // Quote failed — skip silently

                    const { uniOutUsd, aeroOutUsd, direction, netProfitUsd } = scan;

                    // Verbose log every 20 blocks to avoid noise
                    if (metrics.blocksScanned % 20 === 0) {
                        console.log(
                            `📡 [${ts()}] Block ${blockNumber}` +
                            ` | Uni=$${uniOutUsd.toFixed(4)}` +
                            ` | Aero=$${aeroOutUsd.toFixed(4)}` +
                            ` | netProfit=$${netProfitUsd.toFixed(4)}`
                        );
                    }

                    if (netProfitUsd < MIN_PROFIT_USD) return; // Not profitable enough

                    // -------------------------------------------------------
                    // Opportunity found — attempt execution
                    // -------------------------------------------------------
                    metrics.opportunitiesFound++;
                    console.log(
                        `🔥 [${ts()}] Block ${blockNumber} OPPORTUNITY` +
                        ` | dir=${direction === 0 ? "Uni→Aero" : "Aero→Uni"}` +
                        ` | Uni=$${uniOutUsd.toFixed(4)}` +
                        ` | Aero=$${aeroOutUsd.toFixed(4)}` +
                        ` | netProfit=$${netProfitUsd.toFixed(4)}`
                    );

                    // Convert estimated gas cost to USDC (6 decimals) for the contract
                    const gasCostUsdc = BigInt(Math.round(EST_GAS_USD * 1e6));

                    metrics.executionsAttempted++;

                    const tx = await contract.initiateFlashLoan(
                        WETH,
                        FLASH_LOAN_AMOUNT,
                        direction,
                        gasCostUsdc,
                        { gasLimit: 600_000 }
                    );

                    console.log(`📤 [${ts()}] TX sent: ${tx.hash}`);

                    const receipt = await tx.wait();
                    console.log(
                        `✅ [${ts()}] TX confirmed` +
                        ` | block=${receipt.blockNumber}` +
                        ` | gasUsed=${receipt.gasUsed.toString()}`
                    );

                } catch (err) {
                    // Log but never crash the listener
                    console.error(`⚠️  [${ts()}] Block ${blockNumber} error: ${err.message}`);
                }
            });

            // Log metrics every 5 minutes
            setInterval(logMetrics, 5 * 60 * 1000);

            // Handle provider errors with reconnect
            provider.on("error", (err) => {
                console.error(`❌ [${ts()}] Provider error: ${err.message}`);
                scheduleReconnect();
            });

            if (provider.websocket) {
                provider.websocket.onclose = () => {
                    console.warn(`⚠️  [${ts()}] WebSocket closed — reconnecting...`);
                    scheduleReconnect();
                };
            }

        } catch (err) {
            console.error(`❌ [${ts()}] Connection failed: ${err.message}`);
            scheduleReconnect();
        }
    }

    function scheduleReconnect(delayMs = 5000) {
        // Remove all listeners before reconnecting to avoid duplicates
        try { provider.removeAllListeners(); } catch (_) {}
        setTimeout(connect, delayMs);
    }

    connect();
}

main().catch((err) => {
    console.error("❌ Fatal error:", err);
    process.exit(1);
});
