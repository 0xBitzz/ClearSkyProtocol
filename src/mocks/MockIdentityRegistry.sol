// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IIdentityRegistry} from "../interfaces/IIdentityRegistry.sol";

/**
 * @title MockIdentityRegistry
 * @notice Minimal stand-in for the ERC-8004 IdentityRegistry.
 *
 * @dev Only models what ClearSky depends on: an id-to-owner mapping and
 *      ERC-721's revert-on-unknown-id behaviour. Real registration mints an
 *      NFT and stores a metadata URI; none of that affects our checks.
 *
 *      Lives in `src/` so local and mock-USDC deployments can wire up the
 *      identity path without an ERC-8004 deployment on the target chain.
 */
contract MockIdentityRegistry is IIdentityRegistry {
    mapping(uint256 => address) private _owners;
    uint256 public nextAgentId = 1;

    error NonexistentAgent(uint256 agentId);

    /// @notice Mint an identity to `owner`, mirroring `register(string)`.
    function register(address owner) external returns (uint256 agentId) {
        agentId = nextAgentId++;
        _owners[agentId] = owner;
    }

    /// @inheritdoc IIdentityRegistry
    function ownerOf(uint256 agentId) external view returns (address) {
        address owner = _owners[agentId];
        if (owner == address(0)) {
            revert NonexistentAgent(agentId);
        }
        return owner;
    }
}
