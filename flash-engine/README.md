# Flash-Engine-V2-LowComp

Balancer V2 flash loan arbitrage engine for Base mainnet.  
Monitors Uniswap V3 ↔ Aerodrome spreads on WETH/USDC and executes atomic,  
zero-fee flash loan arbitrage when a profitable opportunity is detected.

---

## Architecture

```
index.js  (Node.js bot)
  │
  ├─ Every block: quote Uniswap V3 + Aerodrome for WETH→USDC
  ├─ Calculate net profit = bestOutput − loanValue − gasCost
  └─ If profit > MIN_PROFIT_USD → call contract.initiateFlashLoan()
         │
         └─ FlashArbitrageV2.sol (on-chain)
               ├─ Calls Balancer V2 Vault.flashLoan() (0% fee)
               ├─ receiveFlashLoan() callback:
               │     ├─ Execute Leg 1 swap (buy cheap DEX)
               │     ├─ Execute Leg 2 swap (sell expensive DEX)
               │     ├─ Check profitability — revert if unprofitable
               │     └─ Repay Balancer
               └─ Emit ArbitrageExecuted event
```

## Key Addresses (Base Mainnet)

| Contract            | Address |
|---------------------|---------|
| Balancer V2 Vault   | `0xBA12222222228d8Ba445958a75a0704d566BF2C8` |
| Uniswap V3 Quoter   | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` |
| Uniswap V3 Router   | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| Aerodrome Router    | `0xcF77a3Ba9A5CA399AF7227c0A3DA9651f42a0321` |
| WETH                | `0x4200000000000000000000000000000000000006` |
| USDC                | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

---

## Setup

### 1. Install dependencies

```bash
cd flash-engine
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your BASE_RPC_URL, PRIVATE_KEY, etc.
```

### 3. Compile the contract

```bash
npm run compile
```

### 4. Deploy to Base mainnet

```bash
npm run deploy
# Copy the deployed CONTRACT_ADDRESS into your .env
```

### 5. Start the bot

```bash
npm start
# or for development with auto-restart:
npm run dev
```

---

## Environment Variables

| Variable               | Required | Description |
|------------------------|----------|-------------|
| `BASE_RPC_URL`         | ✅       | WebSocket RPC for Base (e.g. `wss://base.llamarpc.com`) |
| `PRIVATE_KEY`          | ✅       | Wallet private key — must hold ETH for gas |
| `CONTRACT_ADDRESS`     | ✅       | Deployed `FlashArbitrageV2` address |
| `BALANCER_VAULT_ADDRESS` | ❌     | Defaults to Base mainnet Balancer V2 Vault |
| `FLASH_LOAN_AMOUNT`    | ❌       | WETH to borrow per trade in wei (default: 1 ETH) |
| `MIN_PROFIT_USD`       | ❌       | Minimum net profit to trigger (default: `0.50`) |

---

## Safety Features

- **Atomic execution** — the entire flash loan, both swaps, and repayment happen in one transaction. If any step fails, everything reverts.
- **On-chain profitability check** — the contract reverts if `grossOutput ≤ loanValue + gasCost`, so no unprofitable transaction can succeed.
- **0% flash loan fee** — Balancer V2 charges no fee on Base, maximising the profit window.
- **Owner-only execution** — only the deployer wallet can call `initiateFlashLoan`.
- **Emergency withdrawal** — `withdrawToken` and `withdrawEth` let the owner recover funds at any time.

---

## Separation from base-terminal

This service is completely independent of the existing `base-terminal` bot (`bot.js` / `lib/scanner.js`).  
It has its own `package.json`, contract, and entry point.  
No existing files were modified.
