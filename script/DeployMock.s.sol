// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {console2} from "forge-std/console2.sol";
import {Deploy} from "./Deploy.s.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockIdentityRegistry} from "../src/mocks/MockIdentityRegistry.sol";

/**
 * @title DeployMock
 * @notice Deploys ClearSky against a mintable mock USDC.
 *
 * @dev Run with:
 *      forge script script/DeployMock.s.sol:DeployMock --rpc-url $ARC_RPC_URL --broadcast
 *
 *      Why this exists: Arc's faucet dispenses a small amount of USDC, and the
 *      vault locks 5x every premium as collateral, so a single 10 USDC policy
 *      already needs 50 USDC of backing. That is not enough to exercise
 *      multi-underwriter share accounting or concurrent policies.
 *
 *      This deployment is for protocol logic at volume. It does NOT validate
 *      Arc's USDC semantics — blocklist enforcement, dual decimals, native/
 *      ERC-20 equivalence — because a plain ERC-20 cannot reproduce them. Run
 *      Deploy.s.sol against the real USDC for that.
 *
 *      Also deploys a MockIdentityRegistry so the ERC-8004 path can be
 *      exercised end to end without depending on the live registry.
 */
contract DeployMock is Deploy {
    /// @dev Minted to the deployer so there is room to underwrite and buy.
    uint256 public constant MINT_AMOUNT = 10_000_000e6; // 10M USDC

    function run() external override {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);
        MockUSDC usdc = new MockUSDC();
        usdc.mint(deployer, MINT_AMOUNT);

        MockIdentityRegistry registry = new MockIdentityRegistry();
        uint256 agentId = registry.register(deployer);
        vm.stopBroadcast();

        console2.log("MockUSDC deployed at:", address(usdc));
        console2.log("Minted to deployer (6dp):", MINT_AMOUNT);
        console2.log("MockIdentityRegistry deployed at:", address(registry));
        console2.log("Deployer registered as agentId:", agentId);

        deploy(
            deployerPrivateKey,
            deployer,
            address(usdc),
            address(registry),
            vm.envOr("MIN_PREMIUM", DEFAULT_MIN_PREMIUM),
            vm.envOr("MAX_PREMIUM", DEFAULT_MAX_PREMIUM)
        );

        console2.log("Bind the deployer as an identified agent with:");
        console2.log("  FlightAgent.registerAgent(deployer, agentId)");
    }
}
