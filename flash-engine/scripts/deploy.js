"use strict";

/**
 * Deployment script for FlashArbitrageV2
 *
 * Usage:
 *   npx hardhat run scripts/deploy.js --network base
 *
 * Required env vars:
 *   PRIVATE_KEY           — deployer wallet
 *   BASE_RPC_URL          — Base mainnet RPC
 *
 * Optional env vars:
 *   BALANCER_VAULT_ADDRESS — defaults to Base mainnet Balancer V2 Vault
 *   MIN_PROFIT_USDC        — minimum profit in USDC (6 decimals), default 500000 ($0.50)
 */

const { ethers } = require("hardhat");

// Base mainnet contract addresses
const ADDRESSES = {
    balancerVault:   process.env.BALANCER_VAULT_ADDRESS ||
                     "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
    uniswapRouter:   "0x2626664c2603336E57B271c5C0b26F421741e481", // Uniswap V3 SwapRouter02
    uniswapQuoter:   "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", // Uniswap V3 QuoterV2
    aerodromeRouter: "0xcF77a3Ba9A5CA399AF7227c0A3DA9651f42a0321"  // Aerodrome Router
};

// Minimum profit: $0.50 in USDC (6 decimals) = 500_000
const MIN_PROFIT_USDC = process.env.MIN_PROFIT_USDC
    ? BigInt(process.env.MIN_PROFIT_USDC)
    : 500_000n;

async function main() {
    const [deployer] = await ethers.getSigners();

    console.log("🚀 Deploying FlashArbitrageV2...");
    console.log(`   Deployer        : ${deployer.address}`);
    console.log(`   Network         : ${(await ethers.provider.getNetwork()).name}`);
    console.log(`   Balancer Vault  : ${ADDRESSES.balancerVault}`);
    console.log(`   Uniswap Router  : ${ADDRESSES.uniswapRouter}`);
    console.log(`   Uniswap Quoter  : ${ADDRESSES.uniswapQuoter}`);
    console.log(`   Aerodrome Router: ${ADDRESSES.aerodromeRouter}`);
    console.log(`   Min Profit USDC : ${MIN_PROFIT_USDC} (${Number(MIN_PROFIT_USDC) / 1e6} USD)\n`);

    const Factory = await ethers.getContractFactory("FlashArbitrageV2");

    const contract = await Factory.deploy(
        ADDRESSES.balancerVault,
        ADDRESSES.uniswapRouter,
        ADDRESSES.uniswapQuoter,
        ADDRESSES.aerodromeRouter,
        MIN_PROFIT_USDC
    );

    await contract.waitForDeployment();

    const address = await contract.getAddress();

    console.log(`✅ FlashArbitrageV2 deployed to: ${address}`);
    console.log(`\n📝 Add this to your .env file:`);
    console.log(`   CONTRACT_ADDRESS=${address}`);
    console.log(`\n🔍 Verify on Basescan:`);
    console.log(
        `   npx hardhat verify --network base ${address}` +
        ` ${ADDRESSES.balancerVault}` +
        ` ${ADDRESSES.uniswapRouter}` +
        ` ${ADDRESSES.uniswapQuoter}` +
        ` ${ADDRESSES.aerodromeRouter}` +
        ` ${MIN_PROFIT_USDC}`
    );
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error("❌ Deployment failed:", err);
        process.exit(1);
    });
