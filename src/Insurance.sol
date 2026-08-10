// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IFlightData} from "./interfaces/IFlightData.sol";
import {FlightRegistry} from "./FlightRegistry.sol";
import {Vault} from "./Vault.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title Insurance
 * @notice The policy engine. Sells parametric flight-delay cover, and settles it
 *         against the flight data the agent posts to the FlightRegistry.
 *
 * @dev Lifecycle of a policy
 *
 *      1. buyPolicy()    - traveller pays a premium BEFORE the cutoff. The vault
 *                          locks `premium * payoutMultiplier` of collateral, so
 *                          the payout is fully funded from the moment of sale.
 *      2. agent monitors - FlightAgent posts the actual departure time to the
 *                          FlightRegistry.
 *      3a. claim()       - if the recorded delay >= the policy's threshold, the
 *                          traveller pulls their payout from the vault.
 *      3b. expirePolicy()- if the flight was on time, or the claim window closed,
 *                          anyone can settle the policy. Collateral is released
 *                          and the premium stays in the vault as protocol profit.
 *
 *      This contract never holds funds. It is purely an authorisation layer over
 *      the Vault, which it controls via INSURANCE_ROLE.
 */
contract Insurance is IFlightData, AccessControl, ReentrancyGuard, Pausable {
    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice Policies must be bought at least this long before departure.
    uint256 public constant PURCHASE_CUTOFF = 1 hours;

    /// @notice How long after departure a traveller has to claim.
    uint256 public constant CLAIM_WINDOW = 30 days;

    /// @notice Bounds on the delay threshold a traveller may select.
    uint256 public constant MIN_DELAY_THRESHOLD = 1 hours;
    uint256 public constant MAX_DELAY_THRESHOLD = 12 hours;

    // ---------------------------------------------------------------------
    // Immutables
    // ---------------------------------------------------------------------

    FlightRegistry public immutable flightRegistry;
    Vault public immutable vault;

    // ---------------------------------------------------------------------
    // Configurable parameters
    // ---------------------------------------------------------------------

    /// @notice Payout = premium * payoutMultiplier.
    uint256 public payoutMultiplier = 5;

    /// @notice Accepted premium band, denominated in the vault's asset.
    uint256 public minPremium;
    uint256 public maxPremium;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    uint256 public nextPolicyId = 1;

    mapping(uint256 => Policy) private _policies;
    mapping(address => uint256[]) private _policiesOf;

    /**
     * @notice Guards against a traveller double-insuring the same flight leg.
     *
     * @dev Keyed by legId, so this is per-LEG, not per flight number. Insuring
     *      Monday's BA2490 and Friday's BA2490 is two distinct risks and both
     *      are allowed; buying twice on the same leg is not.
     */
    mapping(address => mapping(string => uint256)) public activePolicyFor;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event PayoutMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier);
    event PremiumBandUpdated(uint256 minPremium, uint256 maxPremium);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error PurchaseWindowClosed();
    error PremiumOutOfRange(uint256 premium, uint256 min, uint256 max);
    error DuplicatePolicy(uint256 existingPolicyId);
    error NotPolicyholder();
    error ClaimTooEarly();
    error InvalidMultiplier();
    error InvalidPremiumBand();
    error ZeroAddress();

    constructor(address flightRegistry_, address vault_, address admin, uint256 minPremium_, uint256 maxPremium_) {
        if (flightRegistry_ == address(0) || vault_ == address(0) || admin == address(0)) {
            revert ZeroAddress();
        }
        if (minPremium_ == 0 || maxPremium_ < minPremium_) revert InvalidPremiumBand();

        flightRegistry = FlightRegistry(flightRegistry_);
        vault = Vault(vault_);
        minPremium = minPremium_;
        maxPremium = maxPremium_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Policy purchase
    // ---------------------------------------------------------------------

    /**
     * @notice Buy delay cover for a registered flight leg.
     * @param legId The specific leg to insure. Must already exist in the registry.
     * @param premium Amount of the vault asset to pay.
     * @param delayThreshold Delay, in seconds, that triggers a payout.
     * @return policyId The id of the newly created policy.
     *
     * @dev Takes a legId rather than a flight number, so cover binds to the
     *      exact departure the traveller picked. A flight number would be
     *      ambiguous across dates, and settlement would read whichever record
     *      happened to occupy the slot.
     *
     *      The caller must have approved the VAULT (not this contract) for
     *      `premium`, because the vault is what performs the transferFrom.
     *
     *      Collateral is locked at purchase time, so `lockCollateral` reverting
     *      is the protocol's solvency check: if there is not enough underwriting
     *      liquidity to back this payout, the sale simply does not happen.
     */
    function buyPolicy(string calldata legId, uint256 premium, uint256 delayThreshold)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 policyId)
    {
        if (premium < minPremium || premium > maxPremium) {
            revert PremiumOutOfRange(premium, minPremium, maxPremium);
        }
        if (delayThreshold < MIN_DELAY_THRESHOLD || delayThreshold > MAX_DELAY_THRESHOLD) {
            revert InvalidDelayThreshold();
        }

        uint256 existing = activePolicyFor[msg.sender][legId];
        if (existing != 0) revert DuplicatePolicy(existing);

        // Reverts with FlightNotFound if the agent has not registered it yet.
        FlightInfo memory flight = flightRegistry.getFlight(legId);

        // No buying cover for a plane that is already at the gate.
        if (block.timestamp + PURCHASE_CUTOFF > flight.scheduledDeparture) {
            revert PurchaseWindowClosed();
        }

        uint256 coverageAmount = premium * payoutMultiplier;

        policyId = nextPolicyId++;
        _policies[policyId] = Policy({
            policyholder: msg.sender,
            legId: legId,
            // Snapshotted for display. Settlement never reads this.
            flightNumber: flight.flightNumber,
            premium: premium,
            coverageAmount: coverageAmount,
            departureTime: flight.scheduledDeparture,
            delayThreshold: delayThreshold,
            status: PolicyStatus.Active,
            purchaseTime: block.timestamp
        });

        _policiesOf[msg.sender].push(policyId);
        activePolicyFor[msg.sender][legId] = policyId;

        // Take the money first, then reserve the payout against it.
        vault.depositPremium(msg.sender, premium);
        vault.lockCollateral(coverageAmount);

        emit PolicyCreated(policyId, msg.sender, legId, premium);
    }

    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    /**
     * @notice Claim a payout on a delayed flight.
     * @param policyId The policy to settle.
     *
     * @dev Fully parametric: the only thing consulted is the delay the agent
     *      recorded on-chain. There is no adjuster and no discretion.
     */
    function claim(uint256 policyId) external nonReentrant whenNotPaused {
        Policy storage policy = _policies[policyId];

        if (policy.policyholder == address(0)) revert PolicyNotFound();
        if (policy.policyholder != msg.sender) revert NotPolicyholder();
        if (policy.status != PolicyStatus.Active) revert PolicyNotActive();
        if (block.timestamp > policy.departureTime + CLAIM_WINDOW) revert ClaimWindowExpired();

        // The agent must have reported an actual departure before we can settle.
        FlightInfo memory flight = flightRegistry.getFlight(policy.legId);
        if (flight.actualDeparture == 0 && flight.status != FlightStatus.Cancelled) {
            revert ClaimTooEarly();
        }

        // A cancelled flight always pays. Otherwise the recorded delay must
        // meet the threshold the traveller selected, measured against the
        // schedule they actually bought against.
        bool payable_ = flight.status == FlightStatus.Cancelled || _isDelayed(policy, flight);

        if (!payable_) revert FlightNotDelayed();

        uint256 payout = policy.coverageAmount;

        // Effects before interaction.
        policy.status = PolicyStatus.Claimed;
        delete activePolicyFor[msg.sender][policy.legId];

        vault.payClaim(msg.sender, payout);

        emit PolicyClaimed(policyId, msg.sender, payout);
    }

    /**
     * @notice Settle a policy that will never pay out, freeing its collateral.
     * @param policyId The policy to expire.
     *
     * @dev Permissionless on purpose. Anyone (keeper, underwriter, the agent)
     *      can call this, because releasing collateral only ever helps the
     *      protocol's solvency and can never move funds to the caller.
     *
     *      Valid in two cases:
     *        - the flight departed on time (outcome is already known), or
     *        - the claim window has closed.
     */
    function expirePolicy(uint256 policyId) external nonReentrant {
        Policy storage policy = _policies[policyId];

        if (policy.policyholder == address(0)) revert PolicyNotFound();
        if (policy.status != PolicyStatus.Active) revert PolicyNotActive();

        bool windowClosed = block.timestamp > policy.departureTime + CLAIM_WINDOW;

        if (!windowClosed) {
            FlightInfo memory flight = flightRegistry.getFlight(policy.legId);

            // Not resolved yet: the plane has not been reported as departed.
            if (flight.actualDeparture == 0) revert ClaimTooEarly();

            // Departed, but late enough to owe a payout: the traveller still
            // has their claim window, so we must not release the collateral.
            if (_isDelayed(policy, flight)) {
                revert ClaimTooEarly();
            }
        }

        policy.status = PolicyStatus.Expired;
        delete activePolicyFor[policy.policyholder][policy.legId];

        vault.releaseCollateral(policy.coverageAmount);

        emit PolicyExpired(policyId);
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    /**
     * @notice Whether a flight departed late enough to trigger a given policy.
     *
     * @dev Measured against `policy.departureTime` — the schedule snapshotted
     *      when the cover was sold — NOT the registry's current schedule.
     *
     *      This is what makes `rescheduleFlight` safe. If an airline re-times a
     *      flight after someone has bought cover, the traveller is still
     *      measured against the departure they insured. Reading the live
     *      registry schedule here would let a reschedule silently void cover
     *      that had already been paid for, which is exactly what traditional
     *      insurers are not permitted to do.
     *
     *      A reschedule on its own therefore never triggers a payout: only the
     *      actual departure, versus the purchased baseline, can do that.
     */
    function _isDelayed(Policy storage policy, FlightInfo memory flight) internal view returns (bool) {
        if (flight.actualDeparture == 0) return false;

        uint256 delay =
            flight.actualDeparture > policy.departureTime ? flight.actualDeparture - policy.departureTime : 0;

        return delay >= policy.delayThreshold;
    }

    /// @dev Memory-policy variant, for the `view` helpers below.
    function _isDelayedView(Policy memory policy, FlightInfo memory flight) internal pure returns (bool) {
        if (flight.actualDeparture == 0) return false;

        uint256 delay =
            flight.actualDeparture > policy.departureTime ? flight.actualDeparture - policy.departureTime : 0;

        return delay >= policy.delayThreshold;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Fetch a policy by id.

    function getPolicy(uint256 policyId) external view returns (Policy memory) {
        Policy memory policy = _policies[policyId];
        if (policy.policyholder == address(0)) revert PolicyNotFound();
        return policy;
    }

    /// @notice All policy ids ever bought by an address.
    function getPoliciesOf(address holder) external view returns (uint256[] memory) {
        return _policiesOf[holder];
    }

    /// @notice The payout a given premium would buy at current parameters.
    function quoteCoverage(uint256 premium) external view returns (uint256) {
        return premium * payoutMultiplier;
    }

    /**
     * @notice Whether a policy is currently claimable.
     * @dev Convenience helper for frontends; mirrors the checks in `claim`
     *      without reverting.
     */
    function isClaimable(uint256 policyId) external view returns (bool) {
        Policy memory policy = _policies[policyId];

        if (policy.policyholder == address(0)) return false;
        if (policy.status != PolicyStatus.Active) return false;
        if (block.timestamp > policy.departureTime + CLAIM_WINDOW) return false;

        FlightInfo memory flight = flightRegistry.getFlight(policy.legId);
        if (flight.status == FlightStatus.Cancelled) return true;

        return _isDelayedView(policy, flight);
    }

    /**
     * @notice The delay, in seconds, a policy would be settled on right now.
     * @dev Measured against the purchased baseline. Zero if the flight has not
     *      been reported as departed, or departed on time.
     */
    function recordedDelay(uint256 policyId) external view returns (uint256) {
        Policy memory policy = _policies[policyId];
        if (policy.policyholder == address(0)) revert PolicyNotFound();

        FlightInfo memory flight = flightRegistry.getFlight(policy.legId);
        if (flight.actualDeparture == 0) return 0;

        return flight.actualDeparture > policy.departureTime ? flight.actualDeparture - policy.departureTime : 0;
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /**
     * @notice Update the payout multiplier.
     * @dev Only affects policies sold after the change; existing policies keep
     *      the coverage amount they were sold at.
     */
    function setPayoutMultiplier(uint256 newMultiplier) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newMultiplier == 0 || newMultiplier > 20) revert InvalidMultiplier();

        uint256 old = payoutMultiplier;
        payoutMultiplier = newMultiplier;

        emit PayoutMultiplierUpdated(old, newMultiplier);
    }

    /// @notice Update the accepted premium band.
    function setPremiumBand(uint256 newMin, uint256 newMax) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newMin == 0 || newMax < newMin) revert InvalidPremiumBand();

        minPremium = newMin;
        maxPremium = newMax;

        emit PremiumBandUpdated(newMin, newMax);
    }

    /// @notice Halt new sales and claims. Does not block `expirePolicy`.
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /// @notice Resume normal operation.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
