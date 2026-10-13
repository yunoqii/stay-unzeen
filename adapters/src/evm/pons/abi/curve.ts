import { parseAbi } from "viem";

/**
 * PonsV2BondingCurve: subset of the ABI used by the adapter.
 *
 * Curves are deployed per launch (CREATE2 via PonsV2LaunchDeployer) and are not
 * verified on Sourcify on their own. These signatures are copied by hand from the
 * VERIFIED source `contracts/src/v2/PonsV2BondingCurve.sol` (plus the libraries it
 * uses: PonsV2BondingCurveMath, OpenZeppelin ReentrancyGuard / SafeERC20 / IERC6093),
 * which Sourcify serves inside the exact-match bundle of PonsV2LaunchFactory
 * (https://sourcify.dev/server/v2/contract/4663/0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e,
 * solc 0.8.35, verified 2026-08-04). test/evm/pons-abi.test.ts checks that every
 * function selector below is present in the runtime bytecode of a live curve
 * (fixture recorded from mainnet).
 */
export const ponsV2CurveAbi = parseAbi([
  // state
  "function token() view returns (address)",
  "function pairToken() view returns (address)",
  "function deployer() view returns (address)",
  "function factory() view returns (address)",
  "function phantomQuote() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
  "function graduated() view returns (bool)",
  "function quoteFeeBalance() view returns (uint256)",
  "function creatorTaxBalance() view returns (uint256)",
  "function trackedQuote() view returns (uint256)",
  "function trackedTokens() view returns (uint256)",
  "function reservedTokens() view returns (uint256)",
  "function launchSupply() view returns (uint256)",
  "function launchedAt() view returns (uint256)",
  "function snipeTaxStartBps() view returns (uint256)",
  "function snipeTaxSeconds() view returns (uint256)",
  "function snipeTaxExempt(address account) view returns (bool)",
  "function isNativeQuote() view returns (bool)",
  "function sellableTokens() view returns (uint256)",
  "function currentSnipeTaxBps(address recipient) view returns (uint256)",
  "function getReserves() view returns (uint256 quoteReserve_, uint256 tokenReserve_)",
  "function realQuoteReserve() view returns (uint256)",
  "function readyToGraduate() view returns (bool)",
  // trading
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)",
  "function sweepFees(uint256 minBuybackTokensOut)",
  // events
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
  "event CurveBuyRefunded(address indexed buyer, uint256 refund)",
  "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
  "event SnipeTaxCharged(address indexed recipient, uint256 amount)",
  "event SnipeTaxExempted(address indexed account)",
  "event FeesSwept(uint256 protocolAmount, uint256 buybackAmount, uint256 creatorAmount)",
  "event CurveCompleted(address recipient, uint256 quoteOut, uint256 tokenOut)",
  "event AutoGraduationFailed(address indexed token, uint256 gasRemaining)",
  // errors (curve)
  "error CurveGraduated()",
  "error ZeroAmount()",
  "error ZeroAddress()",
  "error SlippageExceeded(uint256 actual, uint256 minimum)",
  "error NotFactory()",
  "error TransferFailed()",
  "error AlreadyGraduated()",
  "error AlreadyInitialized()",
  "error NotInitialized()",
  "error InvalidLaunchEconomics()",
  "error NotReadyToGraduate()",
  "error NotFeeSweepOperator()",
  "error InternalSwapRequiresOperator()",
  "error InvalidFeePolicy()",
  "error MinimumOutputRequired()",
  "error NativeValueMismatch(uint256 supplied, uint256 expected)",
  "error UnexpectedNativeValue()",
  // errors (PonsV2BondingCurveMath)
  "error InsufficientInputAmount()",
  "error InsufficientOutputAmount()",
  "error InsufficientLiquidity()",
  // errors (OpenZeppelin)
  "error ReentrancyGuardReentrantCall()",
  "error SafeERC20FailedOperation(address token)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
]);

/** Function names whose selectors must be in the live curve bytecode (pons-abi test). */
export const CURVE_FUNCTIONS_IN_BYTECODE = ponsV2CurveAbi
  .filter((x) => x.type === "function")
  .map((x) => (x as { name: string }).name);
