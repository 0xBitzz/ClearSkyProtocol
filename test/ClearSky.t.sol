// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IFlightData} from "../src/interfaces/IFlightData.sol";
import {FlightRegistry} from "../src/FlightRegistry.sol";
import {Vault} from "../src/Vault.sol";
import {FlightAgent} from "../src/FlightAgent.sol";
import {Insurance} from "../src/Insurance.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockIdentityRegistry} from "../src/mocks/MockIdentityRegistry.sol";

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

contract ClearSkyTest is Test, IFlightData {
    MockUSDC internal usdc;
    MockIdentityRegistry internal identityRegistry;
    FlightRegistry internal registry;

    Vault internal vault;
    FlightAgent internal agent;
    Insurance internal insurance;

    address internal admin = makeAddr("admin");
    address internal underwriter = makeAddr("underwriter");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");

    /// @dev The leg under test. Everything keys off this; FLIGHT_NUMBER is display only.
    string internal constant FLIGHT = "BA208-1700000000-fa-0001";
    string internal constant FLIGHT_NUMBER = "BA208";

    uint256 internal constant MIN_PREMIUM = 10e6;
    uint256 internal constant MAX_PREMIUM = 1_000e6;
    uint256 internal constant PREMIUM = 100e6;
    uint256 internal constant COVERAGE = PREMIUM * 5;
    uint256 internal constant LIQUIDITY = 100_000e6;
    uint256 internal constant THRESHOLD = 2 hours;

    uint256 internal departure;

    function setUp() public {
        // Start at a realistic timestamp so `block.timestamp` arithmetic is sane.
        vm.warp(1_700_000_000);
        departure = block.timestamp + 7 days;

        usdc = new MockUSDC();

        identityRegistry = new MockIdentityRegistry();

        vm.startPrank(admin);
        registry = new FlightRegistry(admin);
        vault = new Vault(address(usdc), admin);
        agent = new FlightAgent(address(registry), admin, address(0)); // No identity binding in tests
        insurance = new Insurance(address(registry), address(vault), admin, MIN_PREMIUM, MAX_PREMIUM);

        vault.setInsurance(address(insurance));
        vault.addUnderwriter(underwriter);
        registry.addAgent(address(agent));
        // Mirror production: the FlightAgent contract is the registry's only
        // writer, so the admin EOA gives up the role its constructor granted.
        registry.removeAgent(admin);
        vm.stopPrank();

        // Seed the vault so it can actually underwrite. The vault is ERC-4626,
        // so the underwriter receives shares in exchange.
        usdc.mint(underwriter, LIQUIDITY);
        vm.startPrank(underwriter);
        usdc.approve(address(vault), LIQUIDITY);
        vault.deposit(LIQUIDITY, underwriter);
        vm.stopPrank();

        // Fund travellers.
        usdc.mint(alice, 10_000e6);
        usdc.mint(bob, 10_000e6);

        // The vault pulls premiums, so travellers approve the VAULT.
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(vault), type(uint256).max);

        // Agent registers the leg it will monitor.
        vm.prank(admin);
        agent.registerFlight(FLIGHT, FLIGHT_NUMBER, departure);
    }

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------

    function _buy(address who) internal returns (uint256 policyId) {
        vm.prank(who);
        policyId = insurance.buyPolicy(FLIGHT, PREMIUM, THRESHOLD);
    }

    /// @dev Stands in for a hash of the aviation-API response the agent acted on.
    function _dataHash(FlightStatus status, uint256 actualDeparture) internal pure returns (bytes32) {
        return keccak256(abi.encode("api-response", FLIGHT, status, actualDeparture));
    }

    function _report(FlightStatus status, uint256 actualDeparture) internal {
        vm.prank(admin);
        agent.updateFlightStatus(FLIGHT, status, actualDeparture, _dataHash(status, actualDeparture));
    }

    // -----------------------------------------------------------------
    // Happy paths
    // -----------------------------------------------------------------

    function test_BuyPolicy_CollectsPremiumAndLocksCoverage() public {
        uint256 aliceBefore = usdc.balanceOf(alice);

        uint256 policyId = _buy(alice);

        Policy memory p = insurance.getPolicy(policyId);
        assertEq(p.policyholder, alice);
        assertEq(p.premium, PREMIUM);
        assertEq(p.coverageAmount, COVERAGE);
        assertEq(uint8(p.status), uint8(PolicyStatus.Active));

        assertEq(usdc.balanceOf(alice), aliceBefore - PREMIUM, "premium not taken");
        assertEq(vault.lockedCollateral(), COVERAGE, "coverage not reserved");
        assertEq(vault.totalAssets(), LIQUIDITY + PREMIUM);
        assertEq(vault.availableLiquidity(), LIQUIDITY + PREMIUM - COVERAGE);
    }

    function test_Claim_PaysOutWhenFlightDelayedBeyondThreshold() public {
        uint256 policyId = _buy(alice);
        uint256 aliceBefore = usdc.balanceOf(alice);

        // Departs 3h late against a 2h threshold.
        vm.warp(departure + 3 hours);
        _report(FlightStatus.Delayed, departure + 3 hours);

        assertTrue(insurance.isClaimable(policyId));

        vm.prank(alice);
        insurance.claim(policyId);

        assertEq(usdc.balanceOf(alice), aliceBefore + COVERAGE, "payout not received");
        assertEq(vault.lockedCollateral(), 0, "collateral not released");
        assertEq(vault.totalClaimsPaid(), COVERAGE);

        Policy memory p = insurance.getPolicy(policyId);
        assertEq(uint8(p.status), uint8(PolicyStatus.Claimed));
    }

    function test_ExpirePolicy_KeepsPremiumWhenFlightOnTime() public {
        uint256 policyId = _buy(alice);
        uint256 aliceBefore = usdc.balanceOf(alice);

        // Departs 10 minutes late — under the 2h threshold.
        vm.warp(departure + 10 minutes);
        _report(FlightStatus.Departed, departure + 10 minutes);

        assertFalse(insurance.isClaimable(policyId));

        // Permissionless settlement.
        vm.prank(keeper);
        insurance.expirePolicy(policyId);

        assertEq(usdc.balanceOf(alice), aliceBefore, "traveller should get nothing");
        assertEq(vault.lockedCollateral(), 0, "collateral not released");
        // Premium stays behind as protocol profit.
        assertEq(vault.totalAssets(), LIQUIDITY + PREMIUM);

        Policy memory p = insurance.getPolicy(policyId);
        assertEq(uint8(p.status), uint8(PolicyStatus.Expired));
    }

    function test_Claim_CancelledFlightAlwaysPays() public {
        uint256 policyId = _buy(alice);
        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.warp(departure + 1 hours);
        _report(FlightStatus.Cancelled, 0); // never departed

        vm.prank(alice);
        insurance.claim(policyId);

        assertEq(usdc.balanceOf(alice), aliceBefore + COVERAGE);
        assertEq(vault.lockedCollateral(), 0);
    }

    function test_MultiplePolicies_AccountedIndependently() public {
        uint256 aliceId = _buy(alice);
        uint256 bobId = _buy(bob);

        assertEq(vault.lockedCollateral(), COVERAGE * 2);

        vm.warp(departure + 4 hours);
        _report(FlightStatus.Delayed, departure + 4 hours);

        vm.prank(alice);
        insurance.claim(aliceId);
        assertEq(vault.lockedCollateral(), COVERAGE, "bob's coverage must remain locked");

        vm.prank(bob);
        insurance.claim(bobId);
        assertEq(vault.lockedCollateral(), 0);
    }

    // -----------------------------------------------------------------
    // Purchase guards
    // -----------------------------------------------------------------

    function test_RevertWhen_BuyingAfterCutoff() public {
        vm.warp(departure - 30 minutes); // inside the 1h cutoff
        vm.prank(alice);
        vm.expectRevert(Insurance.PurchaseWindowClosed.selector);
        insurance.buyPolicy(FLIGHT, PREMIUM, THRESHOLD);
    }

    function test_RevertWhen_PremiumOutOfBand() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Insurance.PremiumOutOfRange.selector, 1e6, MIN_PREMIUM, MAX_PREMIUM));
        insurance.buyPolicy(FLIGHT, 1e6, THRESHOLD);
    }

    function test_RevertWhen_DelayThresholdOutOfBounds() public {
        vm.prank(alice);
        vm.expectRevert(IFlightData.InvalidDelayThreshold.selector);
        insurance.buyPolicy(FLIGHT, PREMIUM, 10 minutes);

        vm.prank(alice);
        vm.expectRevert(IFlightData.InvalidDelayThreshold.selector);
        insurance.buyPolicy(FLIGHT, PREMIUM, 24 hours);
    }

    function test_RevertWhen_InsuringUnknownFlight() public {
        vm.prank(alice);
        vm.expectRevert(IFlightData.FlightNotFound.selector);
        insurance.buyPolicy("ZZ999", PREMIUM, THRESHOLD);
    }

    function test_RevertWhen_DoubleInsuringSameFlight() public {
        uint256 first = _buy(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Insurance.DuplicatePolicy.selector, first));
        insurance.buyPolicy(FLIGHT, PREMIUM, THRESHOLD);
    }

    /// @dev The vault's solvency check must block sales it cannot back.
    function test_RevertWhen_VaultCannotBackCoverage() public {
        // Drain the vault so that even after taking the premium it is one unit
        // short of the coverage it would have to reserve. Note the premium
        // itself adds to available liquidity, so it must be accounted for.
        uint256 remaining = COVERAGE - PREMIUM - 1;
        vm.prank(underwriter);
        vault.withdraw(LIQUIDITY - remaining, underwriter, underwriter);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Vault.InsufficientLiquidity.selector, COVERAGE, remaining + PREMIUM));
        insurance.buyPolicy(FLIGHT, PREMIUM, THRESHOLD);
    }

    // -----------------------------------------------------------------
    // Per-leg keying
    // -----------------------------------------------------------------

    /// @dev The bug this keying exists to prevent. An airline reuses "BA208"
    ///      every day, so keying flights by flight number gave the whole route
    ///      one storage slot: the second day's registration reverted as a
    ///      duplicate, and one departure report settled cover bought for the
    ///      other date. Two legs sharing a flight number must be independent.
    function test_SameFlightNumberOnTwoDatesAreDistinctLegs() public {
        string memory tuesday = "BA208-1700604800-fa-0002";
        uint256 tuesdayDeparture = departure + 1 days;

        vm.prank(admin);
        agent.registerFlight(tuesday, FLIGHT_NUMBER, tuesdayDeparture);

        // Alice insures Monday, Bob insures Tuesday. Same flight number.
        uint256 mondayPolicy = _buy(alice);
        vm.prank(bob);
        uint256 tuesdayPolicy = insurance.buyPolicy(tuesday, PREMIUM, THRESHOLD);

        assertEq(insurance.getPolicy(mondayPolicy).departureTime, departure);
        assertEq(insurance.getPolicy(tuesdayPolicy).departureTime, tuesdayDeparture);
        assertEq(insurance.getPolicy(tuesdayPolicy).flightNumber, FLIGHT_NUMBER);

        // Monday runs 3h late. That must not settle Tuesday's cover.
        vm.warp(departure + 3 hours);
        _report(FlightStatus.Delayed, departure + 3 hours);

        assertTrue(insurance.isClaimable(mondayPolicy));
        assertFalse(insurance.isClaimable(tuesdayPolicy), "Monday's delay leaked into Tuesday");

        vm.prank(bob);
        vm.expectRevert(Insurance.ClaimTooEarly.selector);
        insurance.claim(tuesdayPolicy);

        // Tuesday departs on time and keeps its premium, independently.
        vm.warp(tuesdayDeparture + 10 minutes);
        vm.prank(admin);
        agent.updateFlightStatus(
            tuesday, FlightStatus.Departed, tuesdayDeparture + 10 minutes, keccak256("tuesday-evidence")
        );

        vm.prank(alice);
        insurance.claim(mondayPolicy);
        vm.prank(keeper);
        insurance.expirePolicy(tuesdayPolicy);

        assertEq(vault.lockedCollateral(), 0);
    }

    /// @dev The duplicate-policy guard is per leg, so the same traveller may
    ///      insure Monday's and Tuesday's BA208 at once.
    function test_SameTravellerCanInsureTwoLegsOfSameFlightNumber() public {
        string memory tuesday = "BA208-1700604800-fa-0002";

        vm.prank(admin);
        agent.registerFlight(tuesday, FLIGHT_NUMBER, departure + 1 days);

        _buy(alice);
        vm.prank(alice);
        insurance.buyPolicy(tuesday, PREMIUM, THRESHOLD);

        assertEq(insurance.getPoliciesOf(alice).length, 2);
        assertEq(vault.lockedCollateral(), COVERAGE * 2);
    }

    /// @dev ...but the same leg twice is still blocked.
    function test_RevertWhen_ReregisteringSameLeg() public {
        vm.prank(admin);
        vm.expectRevert(IFlightData.FlightAlreadyExists.selector);
        agent.registerFlight(FLIGHT, FLIGHT_NUMBER, departure);
    }

    function test_RevertWhen_RegisteringWithEmptyIdentifier() public {
        vm.startPrank(admin);

        vm.expectRevert(IFlightData.EmptyIdentifier.selector);
        agent.registerFlight("", FLIGHT_NUMBER, departure);

        vm.expectRevert(IFlightData.EmptyIdentifier.selector);
        agent.registerFlight("BA208-1700604800-fa-0003", "", departure);

        vm.stopPrank();
    }

    // -----------------------------------------------------------------
    // Claim guards
    // -----------------------------------------------------------------

    function test_RevertWhen_ClaimingOnTimeFlight() public {
        uint256 policyId = _buy(alice);

        vm.warp(departure + 30 minutes);
        _report(FlightStatus.Departed, departure + 30 minutes);

        vm.prank(alice);
        vm.expectRevert(IFlightData.FlightNotDelayed.selector);
        insurance.claim(policyId);
    }

    function test_RevertWhen_ClaimingBeforeAgentReports() public {
        uint256 policyId = _buy(alice);

        vm.warp(departure + 5 hours);

        vm.prank(alice);
        vm.expectRevert(Insurance.ClaimTooEarly.selector);
        insurance.claim(policyId);
    }

    function test_RevertWhen_NonHolderClaims() public {
        uint256 policyId = _buy(alice);

        vm.warp(departure + 3 hours);
        _report(FlightStatus.Delayed, departure + 3 hours);

        vm.prank(bob);
        vm.expectRevert(Insurance.NotPolicyholder.selector);
        insurance.claim(policyId);
    }

    function test_RevertWhen_ClaimingTwice() public {
        uint256 policyId = _buy(alice);

        vm.warp(departure + 3 hours);
        _report(FlightStatus.Delayed, departure + 3 hours);

        vm.prank(alice);
        insurance.claim(policyId);

        vm.prank(alice);
        vm.expectRevert(IFlightData.PolicyNotActive.selector);
        insurance.claim(policyId);
    }

    function test_RevertWhen_ClaimingAfterWindowCloses() public {
        uint256 policyId = _buy(alice);

        vm.warp(departure + 3 hours);
        _report(FlightStatus.Delayed, departure + 3 hours);

        vm.warp(departure + 31 days);

        vm.prank(alice);
        vm.expectRevert(IFlightData.ClaimWindowExpired.selector);
        insurance.claim(policyId);
    }

    // -----------------------------------------------------------------
    // Expiry guards
    // -----------------------------------------------------------------

    /// @dev A keeper must not be able to strip collateral out from under a
    ///      traveller who is still inside their claim window.
    function test_RevertWhen_ExpiringDelayedPolicyInsideClaimWindow() public {
        uint256 policyId = _buy(alice);

        vm.warp(departure + 3 hours);
        _report(FlightStatus.Delayed, departure + 3 hours);

        vm.prank(keeper);
        vm.expectRevert(Insurance.ClaimTooEarly.selector);
        insurance.expirePolicy(policyId);
    }

    function test_ExpireDelayedPolicy_AllowedOnceWindowCloses() public {
        uint256 policyId = _buy(alice);

        vm.warp(departure + 3 hours);
        _report(FlightStatus.Delayed, departure + 3 hours);

        vm.warp(departure + 31 days);

        vm.prank(keeper);
        insurance.expirePolicy(policyId);

        assertEq(vault.lockedCollateral(), 0);
    }

    function test_RevertWhen_ExpiringBeforeFlightResolves() public {
        uint256 policyId = _buy(alice);

        vm.prank(keeper);
        vm.expectRevert(Insurance.ClaimTooEarly.selector);
        insurance.expirePolicy(policyId);
    }

    // -----------------------------------------------------------------
    // Vault invariants & access control
    // -----------------------------------------------------------------

    function test_RevertWhen_UnderwriterWithdrawsLockedCollateral() public {
        _buy(alice);

        uint256 available = vault.availableLiquidity();

        // ERC-4626 rejects this in `withdraw` itself, because our `maxWithdraw`
        // override clamps to unlocked liquidity.
        vm.prank(underwriter);
        vm.expectRevert(
            abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, underwriter, LIQUIDITY, available)
        );

        vault.withdraw(LIQUIDITY, underwriter, underwriter);
    }

    /// @dev `maxWithdraw` is the safety property: it must never report more
    ///      than the vault can actually free up.
    function test_MaxWithdrawIsClampedByLockedCollateral() public {
        // With nothing locked, the underwriter's whole position is withdrawable.
        assertEq(vault.maxWithdraw(underwriter), LIQUIDITY);

        _buy(alice);

        assertEq(vault.maxWithdraw(underwriter), vault.availableLiquidity());
        assertLt(vault.maxWithdraw(underwriter), LIQUIDITY);
    }

    // -----------------------------------------------------------------
    // Share accounting (ERC-4626)
    // -----------------------------------------------------------------

    /// @dev A fresh vault must price shares 1:1, otherwise every downstream
    ///      assertion about profit and loss is measured from a bent ruler.
    function test_SharePriceStartsAtParity() public view {
        assertEq(vault.sharePrice(), 1e6);
        assertEq(vault.convertToAssets(vault.balanceOf(underwriter)), LIQUIDITY);
    }

    /// @dev An on-time flight is how underwriters make money: the premium stays
    ///      behind and no new shares are minted, so each share is worth more.
    function test_SharePriceRisesWhenPremiumIsKept() public {
        uint256 policyId = _buy(alice);

        vm.warp(departure + 10 minutes);
        _report(FlightStatus.Departed, departure + 10 minutes);
        vm.prank(keeper);
        insurance.expirePolicy(policyId);

        // Share count is unchanged; the assets behind them grew by the premium.
        // Conversion rounds down in the vault's favour, hence the 1-wei slack.
        assertEq(vault.totalSupply(), LIQUIDITY);
        assertGt(vault.sharePrice(), 1e6);
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(underwriter)), LIQUIDITY + PREMIUM, 1);
    }

    /// @dev ...and a payout is how they lose it. 5x coverage against a 1x
    ///      premium means a single claim is a net 4x loss to the pool.
    function test_SharePriceFallsWhenClaimIsPaid() public {
        uint256 policyId = _buy(alice);

        vm.warp(departure + 3 hours);
        _report(FlightStatus.Delayed, departure + 3 hours);
        vm.prank(alice);
        insurance.claim(policyId);

        assertLt(vault.sharePrice(), 1e6);
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(underwriter)), LIQUIDITY + PREMIUM - COVERAGE, 1);
    }

    /// @dev Someone who deposits after a profitable policy must buy in at the
    ///      higher price, not dilute the underwriter who actually carried the
    ///      risk. This is the property that makes the vault fair.
    function test_LateDepositorBuysInAtHigherPriceAndCannotDiluteEarlier() public {
        uint256 policyId = _buy(alice);
        vm.warp(departure + 10 minutes);
        _report(FlightStatus.Departed, departure + 10 minutes);
        vm.prank(keeper);
        insurance.expirePolicy(policyId);

        uint256 earlierValue = vault.convertToAssets(vault.balanceOf(underwriter));

        address latecomer = makeAddr("latecomer");
        vm.prank(admin);
        vault.addUnderwriter(latecomer);
        usdc.mint(latecomer, LIQUIDITY);
        vm.startPrank(latecomer);
        usdc.approve(address(vault), LIQUIDITY);
        vault.deposit(LIQUIDITY, latecomer);
        vm.stopPrank();

        // Same assets in, fewer shares out, because the price has moved up.
        assertLt(vault.balanceOf(latecomer), vault.balanceOf(underwriter));

        // The earlier underwriter's claim on the pool is untouched.
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(underwriter)), earlierValue, 1);
        // And the latecomer cannot immediately withdraw more than they put in.
        assertLe(vault.maxWithdraw(latecomer), LIQUIDITY);
    }

    /// @dev Revoking UNDERWRITER_ROLE must block new capital without trapping
    ///      capital that is already in. Otherwise admin could strand funds.
    function test_RemovedUnderwriterCanStillRedeem() public {
        vm.prank(admin);
        vault.removeUnderwriter(underwriter);

        uint256 shares = vault.balanceOf(underwriter);
        vm.prank(underwriter);
        vault.redeem(shares, underwriter, underwriter);

        assertEq(usdc.balanceOf(underwriter), LIQUIDITY);
        assertEq(vault.balanceOf(underwriter), 0);
    }

    function test_RevertWhen_NonUnderwriterDeposits() public {
        bytes32 role = vault.UNDERWRITER_ROLE();
        vm.startPrank(alice);
        usdc.approve(address(vault), PREMIUM);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role));
        vault.deposit(PREMIUM, alice);
        vm.stopPrank();
    }

    function test_RevertWhen_NonInsuranceTouchesVault() public {
        bytes32 role = vault.INSURANCE_ROLE();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role));
        vault.payClaim(alice, COVERAGE);
    }

    function test_RevertWhen_NonAgentReportsFlightStatus() public {
        bytes32 role = agent.AGENT_ROLE();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role));
        agent.updateFlightStatus(FLIGHT, FlightStatus.Delayed, departure + 5 hours, keccak256("evidence"));
    }

    function test_RevertWhen_RegistryUpdatedByNonAgent() public {
        bytes32 role = registry.AGENT_ROLE();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role));
        registry.updateFlightStatus(FLIGHT, FlightStatus.Delayed, departure + 5 hours, keccak256("evidence"));
    }

    // -----------------------------------------------------------------
    // Agent identity & evidence (ERC-8004)
    // -----------------------------------------------------------------

    /// @dev A report with no evidence commitment must not be able to move
    ///      money. This is the whole point of requiring a data hash.
    function test_RevertWhen_ReportingWithoutDataCommitment() public {
        vm.prank(admin);
        vm.expectRevert(IFlightData.MissingDataCommitment.selector);
        agent.updateFlightStatus(FLIGHT, FlightStatus.Delayed, departure + 5 hours, bytes32(0));
    }

    /// @dev The commitment must be recorded and attributed, so a payout can be
    ///      audited back to the data the agent claimed to be acting on.
    function test_StatusReportRecordsDataCommitment() public {
        bytes32 expected = _dataHash(FlightStatus.Delayed, departure + 3 hours);

        vm.warp(departure + 3 hours);
        vm.expectEmit(true, true, true, true);
        emit FlightDataCommitted(FLIGHT, expected, address(agent));
        _report(FlightStatus.Delayed, departure + 3 hours);

        assertEq(registry.getFlight(FLIGHT).lastDataHash, expected);
    }

    /// @dev Binding succeeds only when the operator actually owns the identity,
    ///      and the bound id then appears in the agent's activity trail.
    function test_RegisterAgent_BindsVerifiedIdentity() public {
        address operator = makeAddr("operator");
        uint256 agentId = identityRegistry.register(operator);

        FlightAgent identified = _deployIdentifiedAgent();

        vm.prank(admin);
        identified.registerAgent(operator, agentId);

        (,, uint256 bound) = identified.getAgentStats(operator);
        assertEq(bound, agentId);
        assertTrue(identified.hasRole(identified.AGENT_ROLE(), operator));
    }

    /// @dev An operator must not be able to claim an identity it does not own —
    ///      otherwise reputation could simply be borrowed.
    function test_RevertWhen_RegisteringIdentityOwnedByAnother() public {
        address operator = makeAddr("operator");
        address impostor = makeAddr("impostor");
        uint256 agentId = identityRegistry.register(operator);

        FlightAgent identified = _deployIdentifiedAgent();

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(IFlightData.IdentityNotOwnedByOperator.selector, agentId, impostor, operator)
        );
        identified.registerAgent(impostor, agentId);
    }

    /// @dev Where no registry is configured, identity binding is unavailable
    ///      rather than silently skipped.
    function test_RevertWhen_RegisteringAgentWithoutIdentityRegistry() public {
        vm.prank(admin);
        vm.expectRevert(IFlightData.AgentIdentityRequired.selector);
        agent.registerAgent(makeAddr("operator"), 1);
    }

    /// @dev Removing an operator must also drop its identity binding, so a
    ///      revoked agent does not keep an on-chain association it can point at.
    function test_RemoveAgent_ClearsIdentityBinding() public {
        address operator = makeAddr("operator");
        uint256 agentId = identityRegistry.register(operator);

        FlightAgent identified = _deployIdentifiedAgent();

        vm.startPrank(admin);
        identified.registerAgent(operator, agentId);
        identified.removeAgent(operator);
        vm.stopPrank();

        (,, uint256 bound) = identified.getAgentStats(operator);
        assertEq(bound, 0);
        assertFalse(identified.hasRole(identified.AGENT_ROLE(), operator));
    }

    /// @dev A bound operator can post; that is the path the live agent uses.
    function test_IdentifiedOperatorCanReport() public {
        address operator = makeAddr("operator");
        uint256 agentId = identityRegistry.register(operator);

        FlightAgent identified = _deployIdentifiedAgent();

        vm.startPrank(admin);
        identified.registerAgent(operator, agentId);
        registry.addAgent(address(identified));
        vm.stopPrank();

        vm.prank(operator);
        identified.updateFlightStatus(FLIGHT, FlightStatus.Delayed, departure + 3 hours, keccak256("evidence"));

        (, uint256 updates, uint256 bound) = identified.getAgentStats(operator);
        assertEq(updates, 1);
        assertEq(bound, agentId);
    }

    /// @dev The role alone must not be enough where ERC-8004 exists. `addAgent`
    ///      grants AGENT_ROLE but binds no identity, and a report from such an
    ///      operator would land unattributable — so the write path rejects it.
    function test_RevertWhen_RoleHolderReportsWithoutIdentity() public {
        address operator = makeAddr("operator");

        FlightAgent identified = _deployIdentifiedAgent();

        vm.startPrank(admin);
        identified.addAgent(operator);
        registry.addAgent(address(identified));
        vm.stopPrank();

        assertTrue(identified.hasRole(identified.AGENT_ROLE(), operator));

        vm.prank(operator);
        vm.expectRevert(IFlightData.AgentIdentityRequired.selector);
        identified.updateFlightStatus(FLIGHT, FlightStatus.Delayed, departure + 3 hours, keccak256("evidence"));
    }

    /// @dev Holding the admin key is not an identity either. The constructor
    ///      grants admin AGENT_ROLE for bootstrapping, but on an ERC-8004 chain
    ///      that still does not buy it the right to move money.
    function test_RevertWhen_AdminReportsWithoutIdentity() public {
        FlightAgent identified = _deployIdentifiedAgent();

        vm.prank(admin);
        registry.addAgent(address(identified));

        vm.prank(admin);
        vm.expectRevert(IFlightData.AgentIdentityRequired.selector);
        identified.updateFlightStatus(FLIGHT, FlightStatus.Delayed, departure + 3 hours, keccak256("evidence"));
    }

    /// @dev Chains without ERC-8004 keep working: with no registry configured
    ///      there is no identity to require, so the role check stands alone.
    ///      `agent` in `setUp` is exactly that deployment.
    function test_UnidentifiedAgentReportsWhenNoRegistryConfigured() public {
        assertEq(address(agent.identityRegistry()), address(0));

        address operator = makeAddr("operator");
        vm.prank(admin);
        agent.addAgent(operator);

        vm.prank(operator);
        agent.updateFlightStatus(FLIGHT, FlightStatus.Delayed, departure + 3 hours, keccak256("evidence"));

        (, uint256 updates, uint256 bound) = agent.getAgentStats(operator);
        assertEq(updates, 1);
        assertEq(bound, 0);
    }

    /// @dev The suite's main agent runs without ERC-8004 (see `setUp`), so the
    ///      identity tests spin up one that is wired to the mock registry.
    function _deployIdentifiedAgent() internal returns (FlightAgent) {
        vm.prank(admin);
        return new FlightAgent(address(registry), admin, address(identityRegistry));
    }

    // -----------------------------------------------------------------
    // Reschedules
    // -----------------------------------------------------------------

    /// @dev The core guarantee: an airline re-timing a flight must not move the
    ///      baseline of cover that was already sold. Alice bought against the
    ///      original departure, so a 3h-late actual departure still pays even
    ///      though it is only 1h after the NEW schedule.
    function test_Reschedule_DoesNotMoveExistingPolicyBaseline() public {
        uint256 policyId = _buy(alice);
        uint256 aliceBefore = usdc.balanceOf(alice);

        // Airline pushes the flight back two hours.
        vm.prank(admin);
        agent.rescheduleFlight(FLIGHT, departure + 2 hours);

        // Policy still measures against the schedule it was sold at.
        assertEq(insurance.getPolicy(policyId).departureTime, departure);

        // Departs 3h after the ORIGINAL time => 3h delay vs. a 2h threshold.
        vm.warp(departure + 3 hours);
        _report(FlightStatus.Delayed, departure + 3 hours);

        assertEq(insurance.recordedDelay(policyId), 3 hours);
        assertTrue(insurance.isClaimable(policyId));

        vm.prank(alice);
        insurance.claim(policyId);
        assertEq(usdc.balanceOf(alice), aliceBefore + COVERAGE);
    }

    /// @dev A policy bought AFTER the reschedule uses the new baseline, so the
    ///      same departure is only 1h late and must not pay.
    function test_Reschedule_NewPolicyUsesNewBaseline() public {
        vm.prank(admin);
        agent.rescheduleFlight(FLIGHT, departure + 2 hours);

        uint256 policyId = _buy(bob);
        assertEq(insurance.getPolicy(policyId).departureTime, departure + 2 hours);

        vm.warp(departure + 3 hours);
        _report(FlightStatus.Departed, departure + 3 hours);

        // Only 1h late against the new schedule; threshold is 2h.
        assertEq(insurance.recordedDelay(policyId), 1 hours);
        assertFalse(insurance.isClaimable(policyId));

        vm.prank(bob);
        vm.expectRevert(IFlightData.FlightNotDelayed.selector);
        insurance.claim(policyId);
    }

    /// @dev A reschedule on its own is not a delay — nobody has sat in an
    ///      airport yet, so there is nothing to pay.
    function test_Reschedule_AloneIsNotClaimable() public {
        uint256 policyId = _buy(alice);

        vm.prank(admin);
        agent.rescheduleFlight(FLIGHT, departure + 10 hours);

        assertFalse(insurance.isClaimable(policyId));
        assertEq(insurance.recordedDelay(policyId), 0);

        vm.prank(alice);
        vm.expectRevert(Insurance.ClaimTooEarly.selector);
        insurance.claim(policyId);
    }

    function test_RevertWhen_ReschedulingDepartedFlight() public {
        _buy(alice);

        vm.warp(departure + 1 hours);
        _report(FlightStatus.Departed, departure + 1 hours);

        vm.prank(admin);
        vm.expectRevert(IFlightData.FlightAlreadyDeparted.selector);
        agent.rescheduleFlight(FLIGHT, departure + 5 hours);
    }

    function test_RevertWhen_ReschedulingIntoThePastOrNoOp() public {
        vm.prank(admin);
        vm.expectRevert(IFlightData.InvalidFlightTime.selector);
        agent.rescheduleFlight(FLIGHT, block.timestamp - 1);

        vm.prank(admin);
        vm.expectRevert(IFlightData.SameDeparture.selector);
        agent.rescheduleFlight(FLIGHT, departure);
    }

    function test_RevertWhen_NonAgentReschedules() public {
        bytes32 role = agent.AGENT_ROLE();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role));
        agent.rescheduleFlight(FLIGHT, departure + 2 hours);
    }

    function test_RevertWhen_ReschedulingUnknownFlight() public {
        vm.prank(admin);
        vm.expectRevert(IFlightData.FlightNotFound.selector);
        agent.rescheduleFlight("ZZ999", departure + 2 hours);
    }

    // -----------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------

    function test_PauseBlocksNewPoliciesButNotExpiry() public {
        uint256 policyId = _buy(alice);

        vm.prank(admin);
        insurance.pause();

        vm.prank(bob);
        vm.expectRevert();
        insurance.buyPolicy(FLIGHT, PREMIUM, THRESHOLD);

        // Settlement of existing risk must still work while paused.
        vm.warp(departure + 10 minutes);
        _report(FlightStatus.Departed, departure + 10 minutes);

        vm.prank(keeper);
        insurance.expirePolicy(policyId);
        assertEq(vault.lockedCollateral(), 0);
    }

    function test_SetPayoutMultiplierAffectsOnlyNewPolicies() public {
        uint256 oldPolicy = _buy(alice);

        vm.prank(admin);
        insurance.setPayoutMultiplier(3);

        uint256 newPolicy = _buy(bob);

        assertEq(insurance.getPolicy(oldPolicy).coverageAmount, PREMIUM * 5);
        assertEq(insurance.getPolicy(newPolicy).coverageAmount, PREMIUM * 3);
    }

    // -----------------------------------------------------------------
    // Fuzz
    // -----------------------------------------------------------------

    /// @dev Payout must always equal premium * multiplier, and the vault must
    ///      end up flat on collateral regardless of the amounts involved.
    function testFuzz_PayoutIsAlwaysPremiumTimesMultiplier(uint256 premium, uint256 threshold) public {
        premium = bound(premium, MIN_PREMIUM, MAX_PREMIUM);
        threshold = bound(threshold, 1 hours, 12 hours);

        usdc.mint(alice, premium);
        uint256 before = usdc.balanceOf(alice);

        vm.prank(alice);
        uint256 policyId = insurance.buyPolicy(FLIGHT, premium, threshold);

        uint256 delayed = departure + threshold + 1;
        vm.warp(delayed);
        _report(FlightStatus.Delayed, delayed);

        vm.prank(alice);
        insurance.claim(policyId);

        assertEq(usdc.balanceOf(alice), before - premium + premium * 5);
        assertEq(vault.lockedCollateral(), 0);
    }

    /// @dev Anything short of the selected threshold must never pay.
    function testFuzz_DelayUnderThresholdNeverPays(uint256 delay) public {
        delay = bound(delay, 0, THRESHOLD - 1);

        uint256 policyId = _buy(alice);

        uint256 actual = departure + delay;
        vm.warp(actual + 1);
        _report(FlightStatus.Departed, actual);

        assertFalse(insurance.isClaimable(policyId));

        vm.prank(alice);
        vm.expectRevert(IFlightData.FlightNotDelayed.selector);
        insurance.claim(policyId);
    }
}
