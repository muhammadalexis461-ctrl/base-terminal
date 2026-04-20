"use strict";

require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
    solidity: {
        version: "0.8.20",
        settings: {
            optimizer: {
                enabled: true,
                runs: 200
            }
        }
    },
    networks: {
        // Base mainnet
        base: {
            url:      process.env.BASE_RPC_URL || "https://mainnet.base.org",
            accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
            chainId:  8453
        },
        // Base Sepolia testnet (for testing before mainnet)
        baseSepolia: {
            url:      "https://sepolia.base.org",
            accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
            chainId:  84532
        }
    },
    // Optional: Basescan verification
    etherscan: {
        apiKey: {
            base: process.env.BASESCAN_API_KEY || ""
        },
        customChains: [
            {
                network:  "base",
                chainId:  8453,
                urls: {
                    apiURL:     "https://api.basescan.org/api",
                    browserURL: "https://basescan.org"
                }
            }
        ]
    }
};
