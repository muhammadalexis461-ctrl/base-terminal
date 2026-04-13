const { ethers } = require("ethers");

const UNISWAP_V3_QUOTER_ABI = ["function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) public returns (uint256 amountOut)"];
const AERODROME_ROUTER_ABI = ["function getAmountOut(uint256 amountIn, address tokenIn, address tokenOut) public view returns (uint256 amountOut, bool stable)"];

const QUOTER    = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const AERO_ROUTER = "0xcF77a3Ba9A5CA399AF7227c0A3DA9651f42a0321";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const PAIR_NAME   = "WETH/USDC";
const MIN_NET_PROFIT = 0.40; // USD — trigger threshold
const EST_GAS_USD    = 1.50; // USD — fixed gas cost estimate
const MAX_RETRIES    = 2;

// ─── Per-pair metrics ─────────────────────────────────────────────────────────

const pairMetrics = {
    [PAIR_NAME]: { attempts: 0, uniErrors: 0, aeroErrors: 0, opportunities: 0 },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ts() {
    return new Date().toISOString();
}

// ─── Quote helpers with retry ─────────────────────────────────────────────────

async function getUniswapQuote(quoter, amountIn, retries = MAX_RETRIES) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`[${ts()}] 🔍 Quoting ${PAIR_NAME} on Uniswap (attempt ${attempt}/${retries})...`);
            const uniOut = await quoter.quoteExactInputSingle.staticCall(WETH, USDC, 500, amountIn, 0);
            const uniOutNum = parseFloat(ethers.formatUnits(uniOut, 6));
            console.log(`[${ts()}] ✅ Uniswap returned: ${uniOutNum.toFixed(6)} USDC`);
            return uniOutNum;
        } catch (err) {
            console.error(`[${ts()}] ❌ Uniswap quote failed (attempt ${attempt}/${retries}): ${err.message}`);
            if (err.code)   console.error(`[${ts()}]   Error code: ${err.code}`);
            if (err.reason) console.error(`[${ts()}]   Reason: ${err.reason}`);
            if (attempt < retries) {
                console.log(`[${ts()}] 🔄 Retry ${attempt}/${retries} for ${PAIR_NAME} on Uniswap...`);
                await new Promise((r) => setTimeout(r, 500));
            } else {
                pairMetrics[PAIR_NAME].uniErrors++;
                console.error(`[${ts()}] ❌ ${PAIR_NAME}: Uniswap quote failed after ${retries} attempts`);
                throw err;
            }
        }
    }
}

async function getAerodromeQuote(router, amountIn, retries = MAX_RETRIES) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`[${ts()}] 🔍 Quoting ${PAIR_NAME} on Aerodrome (attempt ${attempt}/${retries})...`);
            const aeroResult = await router.getAmountOut(amountIn, WETH, USDC);
            const aeroOutNum = parseFloat(ethers.formatUnits(aeroResult.amountOut, 6));
            console.log(`[${ts()}] ✅ Aerodrome returned: ${aeroOutNum.toFixed(6)} USDC (stable=${aeroResult.stable})`);
            return aeroOutNum;
        } catch (err) {
            console.error(`[${ts()}] ❌ Aerodrome quote failed (attempt ${attempt}/${retries}): ${err.message}`);
            if (err.code)   console.error(`[${ts()}]   Error code: ${err.code}`);
            if (err.reason) console.error(`[${ts()}]   Reason: ${err.reason}`);
            if (attempt < retries) {
                console.log(`[${ts()}] 🔄 Retry ${attempt}/${retries} for ${PAIR_NAME} on Aerodrome...`);
                await new Promise((r) => setTimeout(r, 500));
            } else {
                pairMetrics[PAIR_NAME].aeroErrors++;
                console.error(`[${ts()}] ❌ ${PAIR_NAME}: Aerodrome quote failed after ${retries} attempts`);
                throw err;
            }
        }
    }
}

// ─── Main scan ────────────────────────────────────────────────────────────────

async function runScan(tradeSizeEth, provider) {
    const quoter = new ethers.Contract(QUOTER, UNISWAP_V3_QUOTER_ABI, provider);
    const router = new ethers.Contract(AERO_ROUTER, AERODROME_ROUTER_ABI, provider);

    const amountIn = ethers.parseEther(tradeSizeEth.toString());

    pairMetrics[PAIR_NAME].attempts++;
    console.log(`[${ts()}] 🔎 Scanning pair: ${PAIR_NAME} | Trade size: ${tradeSizeEth} ETH`);

    let uniOutNum, aeroOutNum;

    // ── Uniswap quote ──────────────────────────────────────────────────────────
    try {
        uniOutNum = await getUniswapQuote(quoter, amountIn);
    } catch (err) {
        console.error(`[${ts()}] ❌ ${PAIR_NAME}: Uniswap quote error — ${err.message}`);
        console.log(`[${ts()}] 📊 Pair metrics: ${JSON.stringify(pairMetrics[PAIR_NAME])}`);
        return null;
    }

    // ── Aerodrome quote ────────────────────────────────────────────────────────
    try {
        aeroOutNum = await getAerodromeQuote(router, amountIn);
    } catch (err) {
        console.error(`[${ts()}] ❌ ${PAIR_NAME}: Aerodrome quote error — ${err.message}`);
        console.log(`[${ts()}] 📊 Pair metrics: ${JSON.stringify(pairMetrics[PAIR_NAME])}`);
        return null;
    }

    // ── Profit calculation ─────────────────────────────────────────────────────

    const diff         = aeroOutNum - uniOutNum;
    const grossProfit  = Math.abs(diff);
    const spreadPercent = (grossProfit / uniOutNum) * 100;
    const netProfit    = grossProfit - EST_GAS_USD;
    const direction    = uniOutNum < aeroOutNum ? 0 : 1; // 0: Uni→Aero, 1: Aero→Uni

    console.log(`[${ts()}] 📈 Profit calculation for ${PAIR_NAME}:`);
    console.log(`[${ts()}]   Uniswap:      ${uniOutNum.toFixed(4)}`);
    console.log(`[${ts()}]   Aerodrome:    ${aeroOutNum.toFixed(4)}`);
    console.log(`[${ts()}]   Spread:       ${spreadPercent.toFixed(4)}%`);
    console.log(`[${ts()}]   Gross profit: ${grossProfit.toFixed(4)}`);
    console.log(`[${ts()}]   Gas cost:     ${EST_GAS_USD.toFixed(4)}`);
    console.log(`[${ts()}]   Net profit:   ${netProfit.toFixed(4)}`);
    console.log(`[${ts()}]   Direction:    ${direction === 0 ? "Uni→Aero" : "Aero→Uni"}`);

    // ── Decision ───────────────────────────────────────────────────────────────

    const shouldStrike = netProfit > MIN_NET_PROFIT;

    if (shouldStrike) {
        pairMetrics[PAIR_NAME].opportunities++;
        console.log(`[${ts()}] ✅ PASS — Net profit ${netProfit.toFixed(4)} > threshold ${MIN_NET_PROFIT}`);
    } else {
        console.log(`[${ts()}] ❌ REJECT — Net profit ${netProfit.toFixed(4)} < threshold ${MIN_NET_PROFIT}`);
    }

    console.log(`[${ts()}] 📊 Pair metrics: ${JSON.stringify(pairMetrics[PAIR_NAME])}`);

    return {
        shouldStrike,
        netProfit,
        grossProfit,
        estGasUsd: EST_GAS_USD,
        direction,
        spreadPercent,
        uniPrice: uniOutNum,
        aeroPrice: aeroOutNum,
    };
}

module.exports = { runScan };

