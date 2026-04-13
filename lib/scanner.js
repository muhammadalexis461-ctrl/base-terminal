const { ethers } = require("ethers");

const UNISWAP_V3_QUOTER_ABI = ["function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) public returns (uint256 amountOut)"];
const AERODROME_ROUTER_ABI = ["function getAmountOut(uint256 amountIn, address tokenIn, address tokenOut) public view returns (uint256 amountOut, bool stable)"];

const QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const AERO_ROUTER = "0xcF77a3Ba9A5CA399AF7227c0A3DA9651f42a0321";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const QUOTE_TIMEOUT_MS = 5000;

/**
 * Race a promise against a timeout. Rejects with a timeout error if the
 * promise doesn't settle within `ms` milliseconds.
 */
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
        )
    ]);
}

async function runScan(tradeSizeEth, provider) {
    try {
        const quoter = new ethers.Contract(QUOTER, UNISWAP_V3_QUOTER_ABI, provider);
        const router = new ethers.Contract(AERO_ROUTER, AERODROME_ROUTER_ABI, provider);

        const amountIn = ethers.parseEther(tradeSizeEth.toString());

        // 1. Get Uniswap Price (0.05% fee) — timeout after 5 seconds
        const uniOut = await withTimeout(
            quoter.quoteExactInputSingle.staticCall(WETH, USDC, 500, amountIn, 0),
            QUOTE_TIMEOUT_MS,
            "Uniswap quote"
        );

        // 2. Get Aerodrome Price — timeout after 5 seconds
        const aeroResult = await withTimeout(
            router.getAmountOut(amountIn, WETH, USDC),
            QUOTE_TIMEOUT_MS,
            "Aerodrome quote"
        );
        const aeroOut = aeroResult.amountOut;

        const uniOutNum = parseFloat(ethers.formatUnits(uniOut, 6));
        const aeroOutNum = parseFloat(ethers.formatUnits(aeroOut, 6));

        const diff = aeroOutNum - uniOutNum;
        const spreadPercent = (Math.abs(diff) / uniOutNum) * 100;

        // Gas estimation ($1.00 - $2.00 is typical for a strike on Base)
        const estGasUsd = 1.50;
        const netProfit = Math.abs(diff) - estGasUsd;

        return {
            shouldStrike: netProfit > 0.40, // Trigger if profit > $0.40 after gas
            netProfit,
            direction: uniOutNum < aeroOutNum ? 0 : 1, // 0: Uni->Aero, 1: Aero->Uni
            spreadPercent
        };
    } catch (err) {
        console.error(`[scanner] ⚠️ runScan error: ${err.message}`);
        if (err.stack) console.error(err.stack);
        return null;
    }
}

module.exports = { runScan };
