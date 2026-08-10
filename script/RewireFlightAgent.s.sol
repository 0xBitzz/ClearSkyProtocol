// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {FlightRegistry} from "../src/FlightRegistry.sol";
import {FlightAgent} from "../src/FlightAgent.sol";

/**
 * @title RewireFlightAgent
 * @notice Swap FlightAgent for a fresh one bound to a different IdentityRegistry.
 *
 * @dev Run with:
 *      forge script script/RewireFlightAgent.s.sol:RewireFlightAgent \
 *        --rpc-url $ARC_RPC_URL --broadcast
 *
 *      Why a swap and not a setter: `FlightAgent.identityRegistry` is immutable,
 *      deliberately — the address that decides which identities are real should
 *      not be changeable by whoever holds the admin key. The cost of that choice
 *      is that repointing means redeploying. This script makes that cheap.
 *
 *      It is safe because FlightAgent owns no funds and no durable state. Flight
 *      data lives in FlightRegistry, policies and collateral in Insurance and
 *      Vault, and none of them reference FlightAgent. The only thing lost is the
 *      `lastUpdate` / `updateCount` monitoring counters.
 *
 *      Env vars:
 *        PRIVATE_KEY         admin key (DEFAULT_ADMIN_ROLE on FlightRegistry)
 *        FLIGHT_REGISTRY     existing registry to re-point
 *        OLD_FLIGHT_AGENT    agent to demote (optional; skipped if unset)
 *        IDENTITY_REGISTRY   registry for the new agent (default: Arc Testnet's)
 *        AGENT_OPERATOR      monitoring address to bind (optional)
 *        AGENT_ID            ERC-8004 id it owns (optional, required with above)
 */
contract RewireFlightAgent is Script {
    /// @dev ERC-8004 IdentityRegistry on Arc Testnet.
    address public constant ARC_IDENTITY_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        FlightRegistry flightRegistry = FlightRegistry(vm.envAddress("FLIGHT_REGISTRY"));
        address oldAgent = vm.envOr("OLD_FLIGHT_AGENT", address(0));
        address identityRegistry = vm.envOr("IDENTITY_REGISTRY", ARC_IDENTITY_REGISTRY);
        address operator = vm.envOr("AGENT_OPERATOR", address(0));
        uint256 agentId = vm.envOr("AGENT_ID", uint256(0));

        console2.log("Admin:", deployer);
        console2.log("FlightRegistry:", address(flightRegistry));
        console2.log("Old FlightAgent:", oldAgent);
        console2.log("IdentityRegistry for new agent:", identityRegistry);

        vm.startBroadcast(deployerPrivateKey);

        FlightAgent flightAgent = new FlightAgent(address(flightRegistry), deployer, identityRegistry);
        console2.log("New FlightAgent deployed at:", address(flightAgent));

        // Grant first, revoke second. Doing it in this order means the registry
        // is never left without a writer, so a failure between the two calls
        // degrades to "two agents" rather than "no oracle".
        flightRegistry.addAgent(address(flightAgent));
        console2.log("New FlightAgent granted AGENT_ROLE on FlightRegistry");

        if (oldAgent != address(0)) {
            flightRegistry.removeAgent(oldAgent);
            console2.log("Old FlightAgent AGENT_ROLE revoked");
        }

        // Bind the monitoring operator to its ERC-8004 identity. Reverts unless
        // the operator actually owns the id on `identityRegistry`, which is the
        // whole point of doing this.
        if (operator != address(0) && agentId != 0) {
            flightAgent.registerAgent(operator, agentId);
            console2.log("Operator bound to identity:", operator, agentId);
        } else {
            console2.log("No operator bound. Run FlightAgent.registerAgent(operator, agentId) next.");
        }

        vm.stopBroadcast();

        console2.log("=== Rewire complete ===");
        console2.log("Update FLIGHT_AGENT_ADDRESS to:", address(flightAgent));
        console2.log("Flight data in FlightRegistry is untouched; no re-registration needed.");
    }
}
