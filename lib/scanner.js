const { ethers } = require("ethers");

const UNISWAP_V3_QUOTER_ABI = ["function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) public returns (uint256 amountOut)"];
const AERODROME_ROUTER_ABI = ["function getAmountOut(uint256 amountIn, address tokenIn, address tokenOut) public view returns (uint256 amountOut, bool stable)"];

const QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const AERO_ROUTER = "0xcF77a3Ba9A5CA399AF7227c0A3DA9651f42a0321";
const WETH  = "0x4200000000000000000000000000000000000006";
const USDC  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DAI   = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb";
const USDT  = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const USDbC = "0xd9aAEc86B65D86f6A7B630E2c953754b5426C092";

// ─── 9-pair scan table ────────────────────────────────────────────────────────
// Each entry: [tokenIn, tokenOut, uniswapFeeTier, decimalsOut, label]
const TOKEN_PAIRS = [
    [WETH,  USDC,  500,  6,  "WETH/USDC"],
    [WETH,  DAI,   500,  18, "WETH/DAI"],
    [WETH,  USDT,  500,  6,  "WETH/USDT"],
    [USDC,  DAI,   100,  18, "USDC/DAI"],
    [USDC,  USDT,  100,  6,  "USDC/USDT"],
    [DAI,   USDT,  100,  6,  "DAI/USDT"],
    [WETH,  USDbC, 500,  6,  "WETH/USDbC"],
    [USDC,  USDbC, 100,  6,  "USDC/USDbC"],
    [DAI,   USDbC, 100,  6,  "DAI/USDbC"],
];

// ─── Stablecoin-specific pairs (0.01% fee tier = 100) ────────────────────────
const STABLECOIN_PAIRS = [
    [USDC,  USDT,  100, 6,  "USDC/USDT"],
    [DAI,   USDT,  100, 6,  "DAI/USDT"],
    [USDbC, USDT,  100, 6,  "USDbC/USDT"],
];

// ─── Shared quote helper ──────────────────────────────────────────────────────
/**
 * Quotes both DEXes for a single pair and returns pricing data.
 * @param {ethers.Contract} quoter   - Uniswap V3 Quoter contract
 * @param {ethers.Contract} router   - Aerodrome Router contract
 * @param {string}  tokenIn          - Input token address
 * @param {string}  tokenOut         - Output token address
 * @param {number}  feeTier          - Uniswap fee tier (e.g. 500, 100)
 * @param {number}  decimalsOut      - Decimals of output token
 * @param {bigint}  amountIn         - Amount in (wei)
 * @returns {{ uniOutNum, aeroOutNum, diff, spreadPercent } | null}
 */
async function quotePair(quoter, router, tokenIn, tokenOut, feeTier, decimalsOut, amountIn) {
    try {
        const uniOut = await quoter.quoteExactInputSingle.staticCall(
            tokenIn, tokenOut, feeTier, amountIn, 0
        );
        const aeroResult = await router.getAmountOut(amountIn, tokenIn, tokenOut);
        const aeroOut = aeroResult.amountOut;

        const uniOutNum  = parseFloat(ethers.formatUnits(uniOut,  decimalsOut));
        const aeroOutNum = parseFloat(ethers.formatUnits(aeroOut, decimalsOut));
        const diff = aeroOutNum - uniOutNum;
        const spreadPercent = (Math.abs(diff) / uniOutNum) * 100;

        return { uniOutNum, aeroOutNum, diff, spreadPercent };
    } catch (_) {
        return null;
    }
}

// ─── ORIGINAL CORE — DO NOT MODIFY ───────────────────────────────────────────
async function runScan(tradeSizeEth, provider) {
    const quoter = new ethers.Contract(QUOTER, UNISWAP_V3_QUOTER_ABI, provider);
    const router = new ethers.Contract(AERO_ROUTER, AERODROME_ROUTER_ABI, provider);

    const amountIn = ethers.parseEther(tradeSizeEth.toString());

    try {
        // 1. Get Uniswap Price (0.05% fee)
        const uniOut = await quoter.quoteExactInputSingle.staticCall(WETH, USDC, 500, amountIn, 0);
        
        // 2. Get Aerodrome Price
        const aeroResult = await router.getAmountOut(amountIn, WETH, USDC);
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
        return null;
    }
}

/**
 * Scans all 9 TOKEN_PAIRS in parallel and returns the best opportunity found,
 * or null if nothing clears the profit threshold.
 */
async function runScanAll(tradeSizeEth, minProfitUsd, provider) {
    const quoter = new ethers.Contract(QUOTER, UNISWAP_V3_QUOTER_ABI, provider);
    const router = new ethers.Contract(AERO_ROUTER, AERODROME_ROUTER_ABI, provider);
    const amountIn = ethers.parseEther(tradeSizeEth.toString());

    try {
        const results = await Promise.all(
            TOKEN_PAIRS.map(async ([tokenIn, tokenOut, fee, decimals, label]) => {
                const q = await quotePair(quoter, router, tokenIn, tokenOut, fee, decimals, amountIn);
                if (!q) return null;

                const estGasUsd = 1.50;
                const netProfit = Math.abs(q.diff) - estGasUsd;
                const direction = q.diff > 0 ? 0 : 1; // 0: Uni->Aero, 1: Aero->Uni

                // Minimum amount out with 0.5% slippage tolerance
                const bestOut = Math.max(q.uniOutNum, q.aeroOutNum);
                const minAmountOut = bestOut * 0.995;

                return {
                    shouldStrike: netProfit > minProfitUsd,
                    netProfit,
                    pair: label,
                    direction,
                    minAmountOut,
                    spreadPercent: q.spreadPercent,
                    gasUsd: estGasUsd,
                };
            })
        );

        // Return the single best opportunity above threshold
        const viable = results
            .filter(r => r && r.shouldStrike)
            .sort((a, b) => b.netProfit - a.netProfit);

        return viable.length > 0 ? viable[0] : null;
    } catch (err) {
        return null;
    }
}

// ─── NEW STRATEGIES ───────────────────────────────────────────────────────────

/**
 * Dust Collector — scans all 9 pairs with a lower profit threshold and only
 * fires when the network gas price is below maxGasPriceGwei.  Ideal for
 * capturing small spreads ($0.10–$0.30) during quiet, low-gas periods.
 *
 * @param {string|number} tradeSizeEth      - Trade size in ETH (e.g. "1.0")
 * @param {number}        minProfitUsd      - Minimum net profit in USD (e.g. 0.10)
 * @param {number}        maxGasPriceGwei   - Max gas price to allow execution (e.g. 0.1)
 * @param {ethers.Provider} provider
 * @returns {{ shouldStrike, netProfit, pair, direction, minAmountOut, gasUsd } | null}
 */
async function dustCollectorScan(tradeSizeEth, minProfitUsd, maxGasPriceGwei, provider) {
    try {
        // ── Gas gate ──────────────────────────────────────────────────────────
        const feeData = await provider.getFeeData();
        const gasPriceGwei = parseFloat(ethers.formatUnits(feeData.gasPrice ?? 0n, "gwei"));

        if (gasPriceGwei > maxGasPriceGwei) {
            // Gas too high — dust trades are not worth it right now
            return null;
        }

        const quoter = new ethers.Contract(QUOTER, UNISWAP_V3_QUOTER_ABI, provider);
        const router = new ethers.Contract(AERO_ROUTER, AERODROME_ROUTER_ABI, provider);
        const amountIn = ethers.parseEther(tradeSizeEth.toString());

        // ── Quote all 9 pairs in parallel ─────────────────────────────────────
        const results = await Promise.all(
            TOKEN_PAIRS.map(async ([tokenIn, tokenOut, fee, decimals, label]) => {
                const q = await quotePair(quoter, router, tokenIn, tokenOut, fee, decimals, amountIn);
                if (!q) return null;

                // Recalculate gas cost using live gas price
                // Assume ~300 000 gas units for a two-hop flash-arb
                const gasUnits = 300_000n;
                const gasCostWei = (feeData.gasPrice ?? 0n) * gasUnits;
                const gasCostEth = parseFloat(ethers.formatEther(gasCostWei));
                // Approximate ETH price from the WETH/USDC quote if available, else use $3000
                const ethPriceUsd = q.uniOutNum > 0 && tokenIn === WETH
                    ? q.uniOutNum / parseFloat(tradeSizeEth.toString())
                    : 3000;
                const gasUsd = gasCostEth * ethPriceUsd;

                const netProfit = Math.abs(q.diff) - gasUsd;
                const direction = q.diff > 0 ? 0 : 1;
                const bestOut = Math.max(q.uniOutNum, q.aeroOutNum);
                const minAmountOut = bestOut * 0.995;

                return {
                    shouldStrike: netProfit > minProfitUsd,
                    netProfit,
                    pair: label,
                    direction,
                    minAmountOut,
                    gasUsd,
                };
            })
        );

        // Return best viable dust opportunity
        const viable = results
            .filter(r => r && r.shouldStrike)
            .sort((a, b) => b.netProfit - a.netProfit);

        return viable.length > 0 ? viable[0] : null;
    } catch (err) {
        return null;
    }
}

/**
 * Stablecoin Peg Monitor — checks USDC, DAI, and USDbC pairs for depegs.
 * A depeg is detected when a stablecoin trades below $0.998 on one DEX while
 * remaining at $1.00 on the other, creating a risk-adjusted arb opportunity.
 *
 * Uses a higher trade size (default 5 ETH equivalent) because depegs are rare
 * but yield outsized profit when they occur.
 *
 * @param {string|number} tradeSizeEth  - Trade size in ETH (e.g. "5.0")
 * @param {ethers.Provider} provider
 * @returns {{ shouldStrike, pair, depegAmount, direction, minAmountOut, tradeSize } | null}
 */
async function stablecoinPegMonitor(tradeSizeEth, provider) {
    try {
        const DEPEG_THRESHOLD = 0.998; // Flag if price drops below $0.998

        const quoter = new ethers.Contract(QUOTER, UNISWAP_V3_QUOTER_ABI, provider);
        const router = new ethers.Contract(AERO_ROUTER, AERODROME_ROUTER_ABI, provider);

        // For stablecoin pairs the "amount in" is denominated in the input token's
        // own units.  We approximate 5 ETH worth ≈ $15 000 USDC/DAI/USDbC at $3000/ETH.
        // Use a fixed $15 000 notional expressed in 6-decimal units (USDC/USDT/USDbC).
        const NOTIONAL_USD = 15_000;
        const amountIn6  = ethers.parseUnits(NOTIONAL_USD.toString(), 6);   // 6-decimal tokens
        const amountIn18 = ethers.parseUnits(NOTIONAL_USD.toString(), 18);  // 18-decimal tokens (DAI)

        const results = await Promise.all(
            STABLECOIN_PAIRS.map(async ([tokenIn, tokenOut, fee, decimalsOut, label]) => {
                // Choose correct input amount based on tokenIn decimals
                const decimalsIn = tokenIn === DAI ? 18 : 6;
                const amountIn = decimalsIn === 18 ? amountIn18 : amountIn6;

                const q = await quotePair(quoter, router, tokenIn, tokenOut, fee, decimalsOut, amountIn);
                if (!q) return null;

                // For a $1:$1 pair the expected output equals the input notional.
                // A depeg shows up as one side returning noticeably less than $1 per unit.
                const expectedOut = NOTIONAL_USD;
                const uniRate  = q.uniOutNum  / expectedOut; // should be ~1.0
                const aeroRate = q.aeroOutNum / expectedOut; // should be ~1.0

                const depegDetected =
                    uniRate  < DEPEG_THRESHOLD ||
                    aeroRate < DEPEG_THRESHOLD;

                if (!depegDetected) return null;

                // Buy on the cheaper DEX, sell on the more expensive one
                const direction = q.diff > 0 ? 0 : 1; // 0: Uni->Aero, 1: Aero->Uni
                const depegAmount = Math.abs(1.0 - Math.min(uniRate, aeroRate));
                const bestOut = Math.max(q.uniOutNum, q.aeroOutNum);
                const minAmountOut = bestOut * 0.997; // tighter slippage for stablecoins

                return {
                    shouldStrike: true,
                    pair: label,
                    depegAmount,
                    direction,
                    minAmountOut,
                    tradeSize: tradeSizeEth,
                    uniRate,
                    aeroRate,
                };
            })
        );

        const opportunities = results.filter(r => r !== null);
        if (opportunities.length === 0) return null;

        // Return the pair with the largest depeg (most profit potential)
        return opportunities.sort((a, b) => b.depegAmount - a.depegAmount)[0];
    } catch (err) {
        return null;
    }
}

/**
 * Liquidation Sentry — attaches one-time event listeners for LiquidationCall
 * events on Seamless Protocol and Moonwell (Base deployments).
 *
 * This function is LISTEN-ONLY.  It logs every liquidation opportunity with
 * borrower address, collateral/debt assets, and estimated bounty.  No trades
 * are executed.  Call once at bot startup.
 *
 * Seamless Pool (Base):  0x8F44Fd754285aa6A2b8B9B97739B79746e0475a7
 * Moonwell Comptroller (Base): 0xfBb21d0380beE3312B33c4353c8936a0F13EF26C
 *
 * @param {ethers.Provider} provider
 */
function liquidationSentryListener(provider) {
    try {
        // ── Seamless Protocol (Aave V3 fork) ─────────────────────────────────
        // LiquidationCall(address collateralAsset, address debtAsset,
        //   address user, uint256 debtToCover, uint256 liquidatedCollateralAmount,
        //   address liquidator, bool receiveAToken)
        const SEAMLESS_POOL = "0x8F44Fd754285aa6A2b8B9B97739B79746e0475a7";
        const SEAMLESS_ABI  = [
            "event LiquidationCall(" +
                "address indexed collateralAsset, " +
                "address indexed debtAsset, " +
                "address indexed user, " +
                "uint256 debtToCover, " +
                "uint256 liquidatedCollateralAmount, " +
                "address liquidator, " +
                "bool receiveAToken" +
            ")"
        ];
        const seamlessContract = new ethers.Contract(SEAMLESS_POOL, SEAMLESS_ABI, provider);

        seamlessContract.on(
            "LiquidationCall",
            (collateralAsset, debtAsset, user, debtToCover, liquidatedCollateralAmount, liquidator, receiveAToken, event) => {
                try {
                    const debtUsd = parseFloat(ethers.formatUnits(debtToCover, 6));
                    // Typical liquidation bonus on Seamless is 5–10 %
                    const bountyEstimate = debtUsd * 0.075;
                    console.log(
                        `🚨 LIQUIDATION OPPORTUNITY | Protocol: Seamless | ` +
                        `Borrower: ${user} | ` +
                        `Collateral: ${collateralAsset} | ` +
                        `Debt: ${debtAsset} | ` +
                        `Debt To Cover: ${debtUsd.toFixed(2)} | ` +
                        `Bounty Potential: ${bountyEstimate.toFixed(2)} | ` +
                        `Block: ${event.log?.blockNumber ?? "unknown"}`
                    );
                } catch (logErr) {
                    console.error(`❌ Liquidation Sentry (Seamless) log error: ${logErr.message}`);
                }
            }
        );

        // ── Moonwell (Compound V2 fork) ───────────────────────────────────────
        // LiquidateBorrow(address liquidator, address borrower,
        //   uint256 repayAmount, address cTokenCollateral, uint256 seizeTokens)
        const MOONWELL_COMPTROLLER = "0xfBb21d0380beE3312B33c4353c8936a0F13EF26C";
        const MOONWELL_ABI = [
            "event LiquidateBorrow(" +
                "address liquidator, " +
                "address borrower, " +
                "uint256 repayAmount, " +
                "address cTokenCollateral, " +
                "uint256 seizeTokens" +
            ")"
        ];
        const moonwellContract = new ethers.Contract(MOONWELL_COMPTROLLER, MOONWELL_ABI, provider);

        moonwellContract.on(
            "LiquidateBorrow",
            (liquidator, borrower, repayAmount, cTokenCollateral, seizeTokens, event) => {
                try {
                    const repayUsd = parseFloat(ethers.formatUnits(repayAmount, 6));
                    // Moonwell liquidation incentive is typically 8 %
                    const bountyEstimate = repayUsd * 0.08;
                    console.log(
                        `🚨 LIQUIDATION OPPORTUNITY | Protocol: Moonwell | ` +
                        `Borrower: ${borrower} | ` +
                        `Collateral Token: ${cTokenCollateral} | ` +
                        `Repay Amount: ${repayUsd.toFixed(2)} | ` +
                        `Bounty Potential: ${bountyEstimate.toFixed(2)} | ` +
                        `Block: ${event.log?.blockNumber ?? "unknown"}`
                    );
                } catch (logErr) {
                    console.error(`❌ Liquidation Sentry (Moonwell) log error: ${logErr.message}`);
                }
            }
        );

        console.log("👁️  Liquidation Sentry ACTIVE | Watching: Seamless, Moonwell");
    } catch (err) {
        // Non-fatal — log and continue
        console.error(`❌ Liquidation Sentry setup error: ${err.message}`);
    }
}

module.exports = { runScan, runScanAll, dustCollectorScan, stablecoinPegMonitor, liquidationSentryListener };

