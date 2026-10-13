import { parseAbi } from "viem";

/**
 * PonsV2LauncherToken (OpenZeppelin ERC20 + ERC20Burnable, no owner, whole supply
 * minted to the curve). Hand-copied from the VERIFIED source
 * `contracts/src/v2/PonsV2LauncherToken.sol` in the Sourcify bundle of
 * PonsV2LaunchFactory (chain 4663); see abi/curve.ts for provenance and the
 * bytecode selector test.
 */
export const ponsV2TokenAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",
  "function burn(uint256 value)",
  "function deployer() view returns (address)",
  "function curve() view returns (address)",
  "function launchFactory() view returns (address)",
  "function logo() view returns (string)",
  "function description() view returns (string)",
  "function socials() view returns (string twitter, string telegram, string discord, string website, string farcaster)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InvalidSender(address sender)",
  "error ERC20InvalidReceiver(address receiver)",
  "error ERC20InvalidApprover(address approver)",
  "error ERC20InvalidSpender(address spender)",
]);

export const TOKEN_FUNCTIONS_IN_BYTECODE = ponsV2TokenAbi
  .filter((x) => x.type === "function")
  .map((x) => (x as { name: string }).name);
