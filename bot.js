const { ethers } = require("ethers");
const { runScanAll } = require("./lib/scanner");
require('dotenv').config();

const RPC_URL = process.env.CHAINSTACK_WSS;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x700d70d8d1D4833BCF882340E6b005B14FE542D4";
const TRADE_SIZE = "1.2";

// ---------------------------------------------------------------------------
// Token addresses — Base mainnet
// ---------------------------------------------------------------------------
const TOKENS = {
    WETH:  { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
    USDC:  { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6  },
    USDT:  { address: "0xfde4C96c8593536E31F26D3646Ad27256A171EC2", decimals: 6  },
    DAI:   { address: "0x50c5725949A6F0c72E6C4a641F14DA7493d8EB08", decimals: 18 },
    cbETH: { address: "0x2Ae3F1Ec7F1F5012CFEab0411dafAC2D7d2d9353", decimals: 18 },
};

// ---------------------------------------------------------------------------
// Pairs to scan each block.
// feeTier: Uniswap V3 pool fee in hundredths of a bip (500 = 0.05%, 100 = 0.01%).
// ---------------------------------------------------------------------------
const TOKEN_PAIRS = [
    {
        name:             "WETH/USDC",
        tokenIn:          TOKENS.WETH.address,
        tokenOut:         TOKENS.USDC.address,
        tokenInDecimals:  TOKENS.WETH.decimals,
        tokenOutDecimals: TOKENS.USDC.decimals,
        feeTier:          500,
    },
    {
        name:             "WETH/USDT",
        tokenIn:          TOKENS.WETH.address,
        tokenOut:         TOKENS.USDT.address,
        tokenInDecimals:  TOKENS.WETH.decimals,
        tokenOutDecimals: TOKENS.USDT.decimals,
        feeTier:          500,
    },
    {
        name:             "USDC/USDT",
        tokenIn:          TOKENS.USDC.address,
        tokenOut:         TOKENS.USDT.address,
        tokenInDecimals:  TOKENS.USDC.decimals,
        tokenOutDecimals: TOKENS.USDT.decimals,
        feeTier:          100, // stablecoin pair — tightest fee tier
    },
    {
        name:             "WETH/DAI",
        tokenIn:          TOKENS.WETH.address,
        tokenOut:         TOKENS.DAI.address,
        tokenInDecimals:  TOKENS.WETH.decimals,
        tokenOutDecimals: TOKENS.DAI.decimals,
        feeTier:          500,
    },
    {
        name:             "cbETH/WETH",
        tokenIn:          TOKENS.cbETH.address,
        tokenOut:         TOKENS.WETH.address,
        tokenInDecimals:  TOKENS.cbETH.decimals,
        tokenOutDecimals: TOKENS.WETH.decimals,
        feeTier:          500,
    },
];

async function main() {
    if (!RPC_URL || !PRIVATE_KEY) {
        console.error("❌ ERROR: Missing CHAINSTACK_WSS or PRIVATE_KEY.");
        process.exit(1);
    }

    console.log("🚀 BOT INITIALIZING...");
    console.log(`📋 Scanning ${TOKEN_PAIRS.length} pairs: ${TOKEN_PAIRS.map((p) => p.name).join(", ")}`);

    try {
        const provider = new ethers.WebSocketProvider(RPC_URL);
        const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        const contract = new ethers.Contract(CONTRACT_ADDRESS, [
            "function strike(uint8 strategyId, uint256 amount, uint256 minAmountOut)"
        ], wallet);

        console.log(`🤖 BOT ACTIVE | Wallet: ${wallet.address}`);

        provider.on("block", async (blockNumber) => {
            try {
                const opportunities = await runScanAll(TOKEN_PAIRS, TRADE_SIZE, provider);

                for (const result of opportunities) {
                    console.log(`🔥 [BLOCK ${blockNumber}] ${result.pair.name} OPPORTUNITY! Profit: ${result.netProfit.toFixed(2)} | Spread: ${result.spreadPercent.toFixed(4)}%`);
                    const tx = await contract.strike(
                        result.direction,
                        ethers.parseEther(TRADE_SIZE),
                        0,
                        { gasLimit: 500000 }
                    );
                    console.log(`✅ [${result.pair.name}] Sent: ${tx.hash}`);
                    await tx.wait();
                }
            } catch (e) {
                console.error(`⚠️ Scan error: ${e.message}`);
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

