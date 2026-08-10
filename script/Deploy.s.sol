// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {FlightRegistry} from "../src/FlightRegistry.sol";
import {Vault} from "../src/Vault.sol";
import {FlightAgent} from "../src/FlightAgent.sol";
import {Insurance} from "../src/Insurance.sol";

/**
 * @title Deploy
 * @notice Deployment script for the ClearSky Protocol.
 *
 * @dev Run with:
 *      forge script script/Deploy.s.sol:Deploy --rpc-url $ARC_RPC_URL --broadcast
 *
 *      Configuration comes from the environment so a single script serves both
 *      Arc deployments: one against real USDC for token-semantics fidelity, and
 *      one against a mock for high-volume protocol runs. See DeployMock.s.sol.
 *
 *      Env vars (all optional except PRIVATE_KEY):
 *        PRIVATE_KEY       deployer key
 *        USDC_ADDRESS      settlement asset      (default: Arc's USDC)
 *        IDENTITY_REGISTRY ERC-8004 registry     (default: Arc Testnet's)
 *        MIN_PREMIUM       min premium, 6dp      (default: 10 USDC)
 *        MAX_PREMIUM       max premium, 6dp      (default: 1000 USDC)
 */
contract Deploy is Script {
    /// @dev Arc's ERC-20 interface over native USDC. 6 decimals.
    address public constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    /// @dev ERC-8004 IdentityRegistry on Arc Testnet.
    address public constant ARC_IDENTITY_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;

    uint256 public constant DEFAULT_MIN_PREMIUM = 10e6; // 10 USDC
    uint256 public constant DEFAULT_MAX_PREMIUM = 1000e6; // 1000 USDC

    function run() external virtual {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        address deployer = vm.addr(deployerPrivateKey);

        address usdc = vm.envOr("USDC_ADDRESS", ARC_USDC);
        address identityRegistry = vm.envOr("IDENTITY_REGISTRY", ARC_IDENTITY_REGISTRY);
        uint256 minPremium = vm.envOr("MIN_PREMIUM", DEFAULT_MIN_PREMIUM);
        uint256 maxPremium = vm.envOr("MAX_PREMIUM", DEFAULT_MAX_PREMIUM);

        deploy(deployerPrivateKey, deployer, usdc, identityRegistry, minPremium, maxPremium);
    }

    /**
     * @notice Deploy and wire the full protocol.
     * @dev Broken out from `run` so DeployMock can reuse it after deploying its
     *      own token, rather than duplicating the wiring.
     */
    function deploy(
        uint256 deployerPrivateKey,
        address deployer,
        address usdc,
        address identityRegistry,
        uint256 minPremium,
        uint256 maxPremium
    ) public returns (FlightRegistry, Vault, FlightAgent, Insurance) {
        console2.log("Deploying ClearSky Protocol...");
        console2.log("Deployer:", deployer);
        console2.log("Asset (USDC):", usdc);
        console2.log("IdentityRegistry (ERC-8004):", identityRegistry);
        console2.log("Premium band (6dp):", minPremium, "-", maxPremium);

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy FlightRegistry
        FlightRegistry flightRegistry = new FlightRegistry(deployer);
        console2.log("FlightRegistry deployed at:", address(flightRegistry));

        // 2. Deploy Vault
        Vault vault = new Vault(usdc, deployer);
        console2.log("Vault deployed at:", address(vault));

        // 3. Deploy FlightAgent. Passing address(0) for the identity registry
        //    disables ERC-8004 binding, for chains that have no registry.
        FlightAgent flightAgent = new FlightAgent(address(flightRegistry), deployer, identityRegistry);
        console2.log("FlightAgent deployed at:", address(flightAgent));

        // 4. Deploy Insurance
        Insurance insurance = new Insurance(address(flightRegistry), address(vault), deployer, minPremium, maxPremium);
        console2.log("Insurance deployed at:", address(insurance));

        // 5. Wire contracts together
        console2.log("Wiring contracts...");

        // Grant the Insurance contract permission to manage the Vault
        vault.setInsurance(address(insurance));
        console2.log("Insurance granted INSURANCE_ROLE on Vault");

        // Grant the FlightAgent permission to update the FlightRegistry
        flightRegistry.addAgent(address(flightAgent));
        console2.log("FlightAgent granted AGENT_ROLE on FlightRegistry");

        // Revoke the deployer's own AGENT_ROLE on the registry, granted by its
        // constructor. From here the FlightAgent contract is the ONLY address
        // that can write flight data.
        //
        // This is deliberate. It makes the agent the single chokepoint for
        // oracle input, so multi-agent consensus or a dispute window can be
        // added later without touching the registry, and no stray EOA can
        // post a delay directly. Operators are still granted AGENT_ROLE on the
        // FlightAgent itself, which is where they belong.
        flightRegistry.removeAgent(deployer);
        console2.log("Deployer AGENT_ROLE revoked on FlightRegistry (agent is now the sole writer)");

        vm.stopBroadcast();

        console2.log("=== Deployment Complete ===");
        console2.log("FlightRegistry:", address(flightRegistry));
        console2.log("Vault:", address(vault));
        console2.log("FlightAgent:", address(flightAgent));
        console2.log("Insurance:", address(insurance));
        console2.log("Next steps:");
        console2.log("1. Grant UNDERWRITER_ROLE, then fund the Vault via deposit(assets, receiver)");
        console2.log("2. Bind a monitoring agent: FlightAgent.registerAgent(operator, agentId)");
        console2.log("   (agentId comes from ERC-8004 register(string) on the IdentityRegistry)");
        console2.log("3. Register flights using FlightAgent.registerFlight()");
        console2.log("4. Users can buy policies using Insurance.buyPolicy()");
        console2.log("Note: the Vault is ERC-4626. Underwriters receive csUW shares.");

        return (flightRegistry, vault, flightAgent, insurance);
    }
}
