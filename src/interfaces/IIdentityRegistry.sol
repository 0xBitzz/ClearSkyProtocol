// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IIdentityRegistry
 * @notice Minimal view of the ERC-8004 IdentityRegistry.
 *
 * @dev ERC-8004 gives an autonomous agent an on-chain identity: registering
 *      mints an NFT whose owner is the agent's controlling address and whose
 *      `tokenURI` points at metadata describing what the agent does.
 *
 *      We deliberately declare only `ownerOf`. That is the single function
 *      ClearSky needs — to prove an operator actually controls the identity it
 *      claims — and narrowing the interface means we are not asserting the
 *      shape of registry functions we have not verified.
 *
 *      On Arc Testnet the registry lives at
 *      0x8004A818BFB912233c491871b3d84c89A494BD9e.
 */
interface IIdentityRegistry {
    /**
     * @notice Owner of an agent identity.
     * @param agentId The ERC-8004 identity token id.
     * @return The address controlling that identity.
     * @dev Reverts for a non-existent id, per ERC-721.
     */
    function ownerOf(uint256 agentId) external view returns (address);
}
