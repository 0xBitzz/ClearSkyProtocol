// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDC
 * @notice 6-decimal stand-in for USDC with an open mint.
 *
 * @dev Lives in `src/` rather than `test/` so it can be deployed from a script.
 *      This is deliberate: Arc's testnet faucet dispenses a small amount of
 *      USDC, which is not enough to exercise a vault that locks 5x every
 *      premium as collateral. Deploying this alongside the protocol lets you
 *      mint whatever volume the scenario needs.
 *
 *      IMPORTANT: this is NOT a substitute for testing against Arc's real USDC.
 *      Arc's USDC is the native gas token exposed through an ERC-20 interface,
 *      with blocklist enforcement and dual-decimal semantics that an ordinary
 *      ERC-20 cannot reproduce. Use this for protocol-logic runs at volume, and
 *      a separate deployment against the real USDC for token-semantics fidelity.
 */
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Unrestricted mint. Test networks only, obviously.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
