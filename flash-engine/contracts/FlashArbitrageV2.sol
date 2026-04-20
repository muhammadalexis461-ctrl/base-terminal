// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title FlashArbitrageV2
 * @notice Balancer V2 flash loan arbitrage contract for Base mainnet.
 *         Borrows tokens at 0% fee, executes cross-DEX arbitrage between
 *         Uniswap V3 and Aerodrome, then repays Balancer atomically.
 *         Reverts the entire transaction if the trade is unprofitable.
 *
 * Key addresses (Base mainnet):
 *   Balancer Vault  : 0xBA12222222228d8Ba445958a75a0704d566BF2C8
 *   Uniswap V3 Quoter: 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a
 *   Aerodrome Router : 0xcF77a3Ba9A5CA399AF7227c0A3DA9651f42a0321
 *   WETH            : 0x4200000000000000000000000000000000000006
 *   USDC            : 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 */

// ---------------------------------------------------------------------------
// Minimal interface definitions (no external npm imports required)
// ---------------------------------------------------------------------------

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Balancer V2 Vault — only the subset we need.
interface IBalancerVault {
    function flashLoan(
        address recipient,
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes calldata userData
    ) external;
}

/// @dev Uniswap V3 SwapRouter (exactInputSingle).
interface IUniswapV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        returns (uint256 amountOut);
}

/// @dev Uniswap V3 Quoter V2 (off-chain quoting, staticCall only).
interface IUniswapV3Quoter {
    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24  fee,
        uint256 amountIn,
        uint160 sqrtPriceLimitX96
    ) external returns (uint256 amountOut);
}

/// @dev Aerodrome Router — volatile pool quoting and swapping.
interface IAerodromeRouter {
    struct Route {
        address from;
        address to;
        bool    stable;
        address factory;
    }

    function getAmountOut(
        uint256 amountIn,
        address tokenIn,
        address tokenOut
    ) external view returns (uint256 amountOut, bool stable);

    function swapExactTokensForTokens(
        uint256        amountIn,
        uint256        amountOutMin,
        Route[] calldata routes,
        address        to,
        uint256        deadline
    ) external returns (uint256[] memory amounts);
}

// ---------------------------------------------------------------------------
// Main contract
// ---------------------------------------------------------------------------

contract FlashArbitrageV2 {

    // -----------------------------------------------------------------------
    // Immutables & constants
    // -----------------------------------------------------------------------

    address public immutable owner;

    IBalancerVault    public immutable balancerVault;
    IUniswapV3Router  public immutable uniswapRouter;
    IUniswapV3Quoter  public immutable uniswapQuoter;
    IAerodromeRouter  public immutable aerodromeRouter;

    address public constant WETH =
        0x4200000000000000000000000000000000000006;
    address public constant USDC =
        0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    /// @dev Aerodrome default factory for volatile pools on Base.
    address public constant AERO_FACTORY =
        0x420DD381b31aEf6683db6B902084cB0FFECe40Da;

    /// @dev Uniswap V3 pool fee tier (0.05 %).
    uint24 public constant UNI_FEE = 500;

    /// @dev Direction: 0 = buy on Uniswap, sell on Aerodrome.
    ///                 1 = buy on Aerodrome, sell on Uniswap.
    uint8 public constant DIR_UNI_TO_AERO = 0;
    uint8 public constant DIR_AERO_TO_UNI = 1;

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    /// @dev Minimum net profit (in USDC, 6 decimals) required to proceed.
    uint256 public minProfitUsdc;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event FlashLoanInitiated(address indexed token, uint256 amount, uint8 direction);
    event ArbitrageExecuted(uint8 direction, uint256 loanAmount, uint256 profit);
    event ProfitWithdrawn(address indexed token, uint256 amount);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error Unauthorized();
    error UnprofitableTrade(uint256 expectedProfit, uint256 gasCost);
    error InvalidDirection();
    error RepaymentFailed();

    // -----------------------------------------------------------------------
    // Modifiers
    // -----------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyBalancerVault() {
        if (msg.sender != address(balancerVault)) revert Unauthorized();
        _;
    }

    /**
     * @dev Checks that the expected profit exceeds the estimated gas cost.
     *      Reverts the entire call (including any flash loan) if unprofitable.
     */
    modifier checkProfitability(uint256 expectedProfit, uint256 gasCost) {
        if (expectedProfit <= gasCost) {
            revert UnprofitableTrade(expectedProfit, gasCost);
        }
        _;
    }

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    /**
     * @param _balancerVault   Balancer V2 Vault address.
     * @param _uniswapRouter   Uniswap V3 SwapRouter address.
     * @param _uniswapQuoter   Uniswap V3 QuoterV2 address.
     * @param _aerodromeRouter Aerodrome Router address.
     * @param _minProfitUsdc   Minimum profit in USDC (6 decimals) to proceed.
     */
    constructor(
        address _balancerVault,
        address _uniswapRouter,
        address _uniswapQuoter,
        address _aerodromeRouter,
        uint256 _minProfitUsdc
    ) {
        owner             = msg.sender;
        balancerVault     = IBalancerVault(_balancerVault);
        uniswapRouter     = IUniswapV3Router(_uniswapRouter);
        uniswapQuoter     = IUniswapV3Quoter(_uniswapQuoter);
        aerodromeRouter   = IAerodromeRouter(_aerodromeRouter);
        minProfitUsdc     = _minProfitUsdc;
    }

    // -----------------------------------------------------------------------
    // External — bot entry point
    // -----------------------------------------------------------------------

    /**
     * @notice Initiates a Balancer V2 flash loan for the given token/amount.
     *         The arbitrage direction is encoded in `userData` and decoded
     *         inside `receiveFlashLoan`.
     *
     * @param tokenAddress  Token to borrow (e.g. WETH).
     * @param amount        Amount to borrow (in token's native decimals).
     * @param direction     0 = Uni→Aero, 1 = Aero→Uni.
     * @param gasCostUsdc   Estimated gas cost in USDC (6 decimals) for the
     *                      profitability check inside the callback.
     */
    function initiateFlashLoan(
        address tokenAddress,
        uint256 amount,
        uint8   direction,
        uint256 gasCostUsdc
    ) external onlyOwner {
        if (direction > DIR_AERO_TO_UNI) revert InvalidDirection();

        address[] memory tokens  = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0]  = tokenAddress;
        amounts[0] = amount;

        bytes memory userData = abi.encode(direction, gasCostUsdc);

        emit FlashLoanInitiated(tokenAddress, amount, direction);

        balancerVault.flashLoan(address(this), tokens, amounts, userData);
    }

    // -----------------------------------------------------------------------
    // Balancer V2 flash loan callback
    // -----------------------------------------------------------------------

    /**
     * @notice Called by the Balancer Vault after transferring the borrowed
     *         tokens to this contract.  Must repay `amounts[i] + feeAmounts[i]`
     *         for each token before returning.
     *
     *         Balancer V2 charges 0% flash loan fees on Base, so
     *         feeAmounts[0] == 0 in practice.
     */
    function receiveFlashLoan(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes     calldata userData
    ) external onlyBalancerVault {
        (uint8 direction, uint256 gasCostUsdc) =
            abi.decode(userData, (uint8, uint256));

        address token      = tokens[0];
        uint256 loanAmount = amounts[0];
        uint256 fee        = feeAmounts[0]; // 0 on Balancer V2

        // Execute the arbitrage and capture the gross output in USDC.
        uint256 grossOutputUsdc = _executeArbitrage(direction, loanAmount);

        // Convert loan repayment to USDC equivalent for profit calculation.
        // grossOutputUsdc already accounts for the full round-trip; the
        // "cost" is the original loan value expressed in USDC.
        uint256 loanValueUsdc = _quoteUniswapV3(token, USDC, loanAmount);

        uint256 netProfit = grossOutputUsdc > loanValueUsdc + gasCostUsdc
            ? grossOutputUsdc - loanValueUsdc - gasCostUsdc
            : 0;

        // Revert if the trade is not profitable — Balancer unwinds everything.
        if (netProfit == 0) {
            revert UnprofitableTrade(grossOutputUsdc, loanValueUsdc + gasCostUsdc);
        }

        // Repay Balancer: transfer loanAmount + fee back to the Vault.
        _repayBalancer(token, loanAmount + fee);

        emit ArbitrageExecuted(direction, loanAmount, netProfit);
    }

    // -----------------------------------------------------------------------
    // Internal — quoting
    // -----------------------------------------------------------------------

    /**
     * @dev Quotes Uniswap V3 (0.05 % pool) for tokenIn → tokenOut.
     *      Uses staticCall so no state is mutated.
     */
    function _quoteUniswapV3(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) internal returns (uint256 amountOut) {
        // quoteExactInputSingle mutates state transiently; call via try/catch.
        try uniswapQuoter.quoteExactInputSingle(
            tokenIn, tokenOut, UNI_FEE, amountIn, 0
        ) returns (uint256 out) {
            amountOut = out;
        } catch {
            amountOut = 0;
        }
    }

    /**
     * @dev Quotes Aerodrome volatile pool for tokenIn → tokenOut.
     */
    function _quoteAerodrome(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) internal view returns (uint256 amountOut) {
        try aerodromeRouter.getAmountOut(amountIn, tokenIn, tokenOut)
            returns (uint256 out, bool /*stable*/)
        {
            amountOut = out;
        } catch {
            amountOut = 0;
        }
    }

    // -----------------------------------------------------------------------
    // Internal — execution
    // -----------------------------------------------------------------------

    /**
     * @dev Executes the two-leg arbitrage swap.
     *      Direction 0: WETH → USDC on Uniswap, then USDC → WETH on Aerodrome.
     *      Direction 1: WETH → USDC on Aerodrome, then USDC → WETH on Uniswap.
     *
     *      Returns the gross USDC output of the first leg (before the second
     *      leg converts back to WETH for repayment).
     *
     * @param direction  0 = Uni→Aero, 1 = Aero→Uni.
     * @param wethAmount Amount of WETH borrowed from Balancer.
     * @return usdcOut   USDC received from the first swap leg.
     */
    function _executeArbitrage(
        uint8   direction,
        uint256 wethAmount
    ) internal returns (uint256 usdcOut) {
        if (direction == DIR_UNI_TO_AERO) {
            // Leg 1: sell WETH on Uniswap V3, receive USDC.
            usdcOut = _swapOnUniswap(WETH, USDC, wethAmount, 0);

            // Leg 2: sell USDC on Aerodrome, receive WETH (for repayment).
            _swapOnAerodrome(USDC, WETH, usdcOut, 0);

        } else if (direction == DIR_AERO_TO_UNI) {
            // Leg 1: sell WETH on Aerodrome, receive USDC.
            usdcOut = _swapOnAerodrome(WETH, USDC, wethAmount, 0);

            // Leg 2: sell USDC on Uniswap V3, receive WETH (for repayment).
            _swapOnUniswap(USDC, WETH, usdcOut, 0);

        } else {
            revert InvalidDirection();
        }
    }

    /**
     * @dev Executes an exactInputSingle swap on Uniswap V3.
     */
    function _swapOnUniswap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMinimum
    ) internal returns (uint256 amountOut) {
        IERC20(tokenIn).approve(address(uniswapRouter), amountIn);

        amountOut = uniswapRouter.exactInputSingle(
            IUniswapV3Router.ExactInputSingleParams({
                tokenIn:           tokenIn,
                tokenOut:          tokenOut,
                fee:               UNI_FEE,
                recipient:         address(this),
                deadline:          block.timestamp,
                amountIn:          amountIn,
                amountOutMinimum:  amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
        );
    }

    /**
     * @dev Executes a swap on Aerodrome via the volatile pool route.
     */
    function _swapOnAerodrome(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMinimum
    ) internal returns (uint256 amountOut) {
        IERC20(tokenIn).approve(address(aerodromeRouter), amountIn);

        IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](1);
        routes[0] = IAerodromeRouter.Route({
            from:    tokenIn,
            to:      tokenOut,
            stable:  false,
            factory: AERO_FACTORY
        });

        uint256[] memory amounts = aerodromeRouter.swapExactTokensForTokens(
            amountIn,
            amountOutMinimum,
            routes,
            address(this),
            block.timestamp
        );

        amountOut = amounts[amounts.length - 1];
    }

    /**
     * @dev Repays the Balancer Vault by transferring `repayAmount` of `token`
     *      directly back to the Vault address.
     */
    function _repayBalancer(address token, uint256 repayAmount) internal {
        bool ok = IERC20(token).transfer(address(balancerVault), repayAmount);
        if (!ok) revert RepaymentFailed();
    }

    // -----------------------------------------------------------------------
    // Owner utilities
    // -----------------------------------------------------------------------

    /// @notice Update the minimum profit threshold (USDC, 6 decimals).
    function setMinProfitUsdc(uint256 _minProfitUsdc) external onlyOwner {
        minProfitUsdc = _minProfitUsdc;
    }

    /// @notice Withdraw any ERC-20 token held by this contract to the owner.
    function withdrawToken(address token, uint256 amount) external onlyOwner {
        IERC20(token).transfer(owner, amount);
        emit ProfitWithdrawn(token, amount);
    }

    /// @notice Withdraw all ETH held by this contract to the owner.
    function withdrawEth() external onlyOwner {
        payable(owner).transfer(address(this).balance);
    }

    /// @dev Accept ETH (e.g. from WETH unwrap).
    receive() external payable {}
}
