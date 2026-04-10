const { ethers } = require("ethers");

// ─── ABIs ────────────────────────────────────────────────────────────────────
const UNISWAP_V3_QUOTER_ABI = [
    "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) public returns (uint256 amountOut)"
];
const AERODROME_ROUTER_ABI = [
    "function getAmountOut(uint256 amountIn, address tokenIn, address tokenOut) public view returns (uint256 amountOut, bool stable)"
];

// ─── Contract Addresses (Base Mainnet) ───────────────────────────────────────
const QUOTER     = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const AERO_ROUTER = "0xcF77a3Ba9A5CA399AF7227c0A3DA9651f42a0321";

// ─── Token Addresses (Base Mainnet) ──────────────────────────────────────────
const TOKENS = {
    WETH:  { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
    USDC:  { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6  },
    USDT:  { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6  },
    DAI:   { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18 },
    cbETH: { address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18 },
    AERO:  { address: "0x940181a94A35A4569E400762A40599b551F39350", decimals: 18 },
};

// ─── Token Pairs ──────────────────────────────────────────────────────────────
// fee: Uniswap V3 fee tier in bps (500 = 0.05%, 100 = 0.01%)
// Fee tier selection: use 500 for volatile pairs, 100 for tightly-pegged stables.
// To test alternative tiers, change fee here and compare quote outputs.
const TOKEN_PAIRS = [
    // Original pairs
    { tokenIn: "WETH",  tokenOut: "USDC",  fee: 500,  label: "WETH/USDC"  },
    { tokenIn: "WETH",  tokenOut: "USDT",  fee: 500,  label: "WETH/USDT"  },
    { tokenIn: "USDC",  tokenOut: "USDT",  fee: 100,  label: "USDC/USDT"  },
    { tokenIn: "WETH",  tokenOut: "DAI",   fee: 500,  label: "WETH/DAI"   },
    { tokenIn: "cbETH", tokenOut: "WETH",  fee: 500,  label: "cbETH/WETH" },
    // New pairs
    { tokenIn: "WETH",  tokenOut: "AERO",  fee: 500,  label: "WETH/AERO"  }, // Aerodrome native token, high volume
    { tokenIn: "USDC",  tokenOut: "AERO",  fee: 500,  label: "USDC/AERO"  }, // Stablecoin to AERO
    { tokenIn: "DAI",   tokenOut: "USDT",  fee: 100,  label: "DAI/USDT"   }, // Stablecoin pair, often has spreads
    { tokenIn: "cbETH", tokenOut: "USDC",  fee: 500,  label: "cbETH/USDC" }, // Wrapped ETH to stablecoin
];

// ─── Configuration ────────────────────────────────────────────────────────────
const MIN_NET_PROFIT   = 0.20;  // Minimum profit after gas to trigger execution ($)
const MAX_GAS_USD      = 0.75;  // Skip execution if estimated gas cost exceeds this ($)
const SLIPPAGE_BPS     = 50;    // 0.5% slippage tolerance (in basis points)
const ETH_PRICE_USD    = 3000;  // Fallback ETH price for gas estimation; update or fetch dynamically

// ─── Performance Metrics ──────────────────────────────────────────────────────
const metrics = {
    opportunitiesFound: {},  // { [label]: count }
    executions: 0,
    totalProfitUsd: 0,
    totalGasCostUsd: 0,
    errors: {},              // { [label]: count }
};

// Initialise per-pair counters
for (const pair of TOKEN_PAIRS) {
    metrics.opportunitiesFound[pair.label] = 0;
    metrics.errors[pair.label] = 0;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fetch the current gas price from the provider and convert to USD.
 * Returns { gasPriceGwei, gasUsd } or null on failure.
 *
 * MEV / Private RPC note:
 *   Public RPCs (e.g. Chainstack) expose your pending transactions to searchers,
 *   making you vulnerable to sandwich attacks. To protect execution:
 *   1. Set PRIVATE_RPC_URL in your .env to a Flashbots-compatible endpoint
 *      (e.g. https://rpc.flashbots.net or https://rpc.mevblocker.io).
 *   2. Send the strike() transaction through that provider instead of the
 *      public WebSocket provider used for scanning.
 *   3. Flashbots bundles are never broadcast to the public mempool, so
 *      front-runners cannot see or sandwich your trade.
 */
async function getGasCostUsd(provider) {
    try {
        const feeData = await provider.getFeeData();
        // Use maxFeePerGas if available (EIP-1559), otherwise fall back to gasPrice
        const gasPriceWei = feeData.maxFeePerGas ?? feeData.gasPrice;
        if (!gasPriceWei) return null;

        const gasPriceGwei = parseFloat(ethers.formatUnits(gasPriceWei, "gwei"));
        // Approximate gas units for a strike() call on Base
        const gasUnits = 300_000;
        const gasCostEth = (gasPriceGwei * gasUnits) / 1e9;
        const gasUsd = gasCostEth * ETH_PRICE_USD;

        return { gasPriceGwei, gasUsd };
    } catch {
        return null;
    }
}

/**
 * Apply slippage tolerance to an expected output amount.
 * minAmountOut = amountOut * (1 - SLIPPAGE_BPS / 10000)
 * Protects against sandwich attacks and unexpected price impact.
 */
function applySlippage(amountOut) {
    return (amountOut * BigInt(10000 - SLIPPAGE_BPS)) / BigInt(10000);
}

/**
 * Quote a single pair on both Uniswap V3 and Aerodrome.
 * Returns { uniOutNum, aeroOutNum, diff, spreadPercent, minAmountOut } or null.
 *
 * Flashloan integration note (future):
 *   To trade without upfront capital, wrap the strike() call in an Aave V3
 *   flashloan. The pattern is:
 *     1. Borrow `amountIn` of tokenIn from Aave (0.09% fee).
 *     2. Execute the arbitrage swap.
 *     3. Repay Aave within the same transaction.
 *   Profit calculation must subtract the Aave fee:
 *     netProfit = grossProfit - gasCostUsd - (amountIn * 0.0009 * tokenPriceUsd)
 *   This allows scaling trade size far beyond wallet balance.
 */
async function quotePair(pair, amountIn, quoter, router) {
    const tokenIn  = TOKENS[pair.tokenIn];
    const tokenOut = TOKENS[pair.tokenOut];

    // Retry up to 2 times for transient RPC failures
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const [uniOut, aeroResult] = await Promise.all([
                quoter.quoteExactInputSingle.staticCall(
                    tokenIn.address, tokenOut.address, pair.fee, amountIn, 0
                ),
                router.getAmountOut(amountIn, tokenIn.address, tokenOut.address),
            ]);

            const aeroOut = aeroResult.amountOut;

            const uniOutNum  = parseFloat(ethers.formatUnits(uniOut,  tokenOut.decimals));
            const aeroOutNum = parseFloat(ethers.formatUnits(aeroOut, tokenOut.decimals));

            const diff          = aeroOutNum - uniOutNum;
            const spreadPercent = (Math.abs(diff) / uniOutNum) * 100;

            // minAmountOut uses the better of the two quotes with slippage applied
            const bestOut    = uniOutNum >= aeroOutNum ? uniOut : aeroOut;
            const minAmountOut = applySlippage(bestOut);

            return { uniOutNum, aeroOutNum, diff, spreadPercent, minAmountOut };
        } catch (err) {
            if (attempt === 2) {
                // Surface the error to the caller after both attempts fail
                throw err;
            }
            // Brief pause before retry
            await new Promise(r => setTimeout(r, 200));
        }
    }
}

// ─── Main Scan ────────────────────────────────────────────────────────────────

async function runScan(tradeSizeEth, provider) {
    const quoter = new ethers.Contract(QUOTER, UNISWAP_V3_QUOTER_ABI, provider);
    const router = new ethers.Contract(AERO_ROUTER, AERODROME_ROUTER_ABI, provider);

    // Fetch dynamic gas cost once per scan cycle
    const gasData = await getGasCostUsd(provider);
    const gasUsd  = gasData ? gasData.gasUsd : 1.50; // fall back to $1.50 if unavailable
    const gasPriceGwei = gasData ? gasData.gasPriceGwei.toFixed(3) : "n/a";

    if (gasData && gasData.gasUsd > MAX_GAS_USD) {
        console.log(`⛽ Gas too high: ${gasData.gasUsd.toFixed(3)} (${gasPriceGwei} gwei) — skipping scan`);
        return null;
    }

    let bestResult = null;

    for (const pair of TOKEN_PAIRS) {
        const tokenIn = TOKENS[pair.tokenIn];
        // Scale amountIn to the tokenIn's decimals
        const amountIn = ethers.parseUnits(tradeSizeEth.toString(), tokenIn.decimals);

        try {
            const quote = await quotePair(pair, amountIn, quoter, router);
            const { uniOutNum, aeroOutNum, diff, spreadPercent, minAmountOut } = quote;

            const netProfit = Math.abs(diff) - gasUsd;
            const direction = uniOutNum < aeroOutNum ? 0 : 1; // 0: Uni→Aero, 1: Aero→Uni

            console.log(
                `📊 ${pair.label} | Uni: ${uniOutNum.toFixed(4)} | Aero: ${aeroOutNum.toFixed(4)}` +
                ` | Spread: ${spreadPercent.toFixed(4)}% | Net: ${netProfit.toFixed(3)}` +
                ` | Gas: ${gasUsd.toFixed(3)} (${gasPriceGwei} gwei)`
            );

            if (netProfit > MIN_NET_PROFIT) {
                metrics.opportunitiesFound[pair.label]++;

                // Keep the most profitable opportunity this block
                if (!bestResult || netProfit > bestResult.netProfit) {
                    bestResult = {
                        shouldStrike: true,
                        netProfit,
                        gasUsd,
                        direction,
                        spreadPercent,
                        minAmountOut,
                        pair: pair.label,
                    };
                }
            }
        } catch (err) {
            metrics.errors[pair.label]++;
            console.warn(`⚠️  Quote failed for ${pair.label} (attempt 2/2): ${err.message}`);
        }
    }

    return bestResult;
}

// ─── Metrics Reporter ─────────────────────────────────────────────────────────

function logMetrics(blockNumber) {
    console.log(`\n📈 ── PERFORMANCE METRICS @ block ${blockNumber} ──────────────────`);
    console.log(`   Executions      : ${metrics.executions}`);
    console.log(`   Total Profit    : ${metrics.totalProfitUsd.toFixed(4)}`);
    console.log(`   Total Gas Spent : ${metrics.totalGasCostUsd.toFixed(4)}`);
    console.log(`   Net P&L         : ${(metrics.totalProfitUsd - metrics.totalGasCostUsd).toFixed(4)}`);
    console.log(`   Opportunities found per pair:`);
    for (const [label, count] of Object.entries(metrics.opportunitiesFound)) {
        const errs = metrics.errors[label];
        console.log(`     ${label.padEnd(14)}: ${count} opps, ${errs} errors`);
    }
    console.log(`────────────────────────────────────────────────────────────\n`);
}

module.exports = { runScan, logMetrics, metrics };
