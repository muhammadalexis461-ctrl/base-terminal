const { ethers } = require("ethers");

const UNISWAP_V3_QUOTER_ABI = ["function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) public returns (uint256 amountOut)"];
const AERODROME_ROUTER_ABI = ["function getAmountOut(uint256 amountIn, address tokenIn, address tokenOut) public view returns (uint256 amountOut, bool stable)"];

const QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const AERO_ROUTER = "0xcF77a3Ba9A5CA399AF7227c0A3DA9651f42a0321";

// Gas estimation ($1.00 - $2.00 is typical for a strike on Base)
const EST_GAS_USD = 1.50;
const MIN_NET_PROFIT = 0.40;

/**
 * Scan a single token pair for arbitrage opportunities between Uniswap V3 and Aerodrome.
 *
 * @param {object} pair         - Token pair descriptor from TOKEN_PAIRS in bot.js
 * @param {string} tradeSizeEth - Trade size in ETH-equivalent units (e.g. "1.2")
 * @param {object} provider     - ethers provider
 * @returns {object|null}       - Scan result, or null on error
 */
async function runScan(pair, tradeSizeEth, provider) {
    const quoter = new ethers.Contract(QUOTER, UNISWAP_V3_QUOTER_ABI, provider);
    const router = new ethers.Contract(AERO_ROUTER, AERODROME_ROUTER_ABI, provider);

    // tokenIn is always expressed in its own native decimals
    const amountIn = ethers.parseUnits(tradeSizeEth.toString(), pair.tokenInDecimals);

    try {
        // 1. Get Uniswap V3 price (use pair-specific fee tier)
        const uniOut = await quoter.quoteExactInputSingle.staticCall(
            pair.tokenIn, pair.tokenOut, pair.feeTier, amountIn, 0
        );

        // 2. Get Aerodrome price
        const aeroResult = await router.getAmountOut(amountIn, pair.tokenIn, pair.tokenOut);
        const aeroOut = aeroResult.amountOut;

        const uniOutNum  = parseFloat(ethers.formatUnits(uniOut,  pair.tokenOutDecimals));
        const aeroOutNum = parseFloat(ethers.formatUnits(aeroOut, pair.tokenOutDecimals));

        const diff          = aeroOutNum - uniOutNum;
        const spreadPercent = (Math.abs(diff) / uniOutNum) * 100;
        const netProfit     = Math.abs(diff) - EST_GAS_USD;

        return {
            pair,
            shouldStrike: netProfit > MIN_NET_PROFIT,
            netProfit,
            direction: uniOutNum < aeroOutNum ? 0 : 1, // 0: Uni->Aero, 1: Aero->Uni
            spreadPercent
        };
    } catch (err) {
        return null;
    }
}

/**
 * Scan all provided token pairs in parallel and return every result that
 * meets the minimum profit threshold.
 *
 * @param {object[]} pairs      - Array of token pair descriptors
 * @param {string}   tradeSizeEth
 * @param {object}   provider
 * @returns {object[]}          - Array of profitable scan results (may be empty)
 */
async function runScanAll(pairs, tradeSizeEth, provider) {
    const results = await Promise.all(
        pairs.map((pair) => runScan(pair, tradeSizeEth, provider))
    );
    return results.filter((r) => r !== null && r.shouldStrike);
}

module.exports = { runScan, runScanAll };

