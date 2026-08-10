// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IFlightData} from "./interfaces/IFlightData.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {FlightRegistry} from "./FlightRegistry.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title FlightAgent
 * @notice Oracle service that monitors flights and updates their status.
 *
 * @dev This contract is the protocol's single writer to `FlightRegistry`. Every
 *      flight registration, status report, and reschedule flows through here.
 *
 *      ClearSky's agent is an ORACLE, not a counterparty. It never buys a
 *      policy, is never paid by the protocol, and holds no stake. But its word
 *      moves money: one `updateFlightStatus` call reporting a delay can release
 *      up to 5x a premium from the vault to a policyholder. That asymmetry —
 *      no skin in the game, full authority over payouts — is the trust problem
 *      this contract tries to narrow, along two axes:
 *
 *      1. IDENTITY (ERC-8004). An operator must be bound to an on-chain agent
 *         identity it provably owns, so reports are attributable to a
 *         registered agent rather than an anonymous EOA.
 *      2. EVIDENCE. Every status report carries a hash of the off-chain data
 *         that justified it, so any payout can be audited against its source.
 *
 *      Neither stops a compromised key from lying. Together they mean a lie is
 *      signed and attributable rather than anonymous and deniable.
 */
contract FlightAgent is IFlightData, AccessControl {
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    FlightRegistry public immutable flightRegistry;

    /**
     * @notice ERC-8004 IdentityRegistry used to verify agent identities.
     * @dev `address(0)` disables identity binding entirely, which keeps the
     *      protocol deployable on chains without ERC-8004. When unset,
     *      `registerAgent` is unavailable and operators are added with
     *      `addAgent`, which records no identity.
     */
    IIdentityRegistry public immutable identityRegistry;

    /// @notice ERC-8004 identity claimed by each operator (0 if none).
    mapping(address => uint256) public agentIds;

    /// @notice Last time each agent submitted an update (for monitoring)
    mapping(address => uint256) public lastUpdate;

    /// @notice Count of updates submitted by each agent (for monitoring)
    mapping(address => uint256) public updateCount;

    /// @dev `agentId` is 0 for operators registered without an ERC-8004 identity.
    event AgentActive(address indexed agent, uint256 indexed agentId, uint256 timestamp);
    event AgentRegistered(address indexed operator, uint256 indexed agentId);
    event FlightMonitored(string indexed legId, string flightNumber, uint256 scheduledDeparture);

    error AgentNotAuthorized();

    /**
     * @dev Write path gate. `AGENT_ROLE` alone is not enough on a chain that has
     *      an IdentityRegistry: an operator added via `addAgent` holds the role
     *      but carries no identity, and its reports would land with `agentId` 0.
     *      That is the anonymous-EOA case the identity work exists to remove, so
     *      reject it here rather than emit an unattributable report.
     *
     *      Deliberately not applied to the admin's constructor-granted role
     *      either: the deployer is an EOA like any other, and "I hold the admin
     *      key" is not an identity.
     *
     *      When `identityRegistry` is unset the chain has no ERC-8004 and
     *      `addAgent` is the only option, so the role check stands alone.
     */
    modifier onlyIdentifiedAgent() {
        _checkRole(AGENT_ROLE);
        if (address(identityRegistry) != address(0) && agentIds[msg.sender] == 0) {
            revert AgentIdentityRequired();
        }
        _;
    }

    constructor(address flightRegistry_, address admin, address identityRegistry_) {
        if (flightRegistry_ == address(0) || admin == address(0)) {
            revert Unauthorized();
        }
        flightRegistry = FlightRegistry(flightRegistry_);
        // Optional by design: zero address means "no ERC-8004 on this chain".
        identityRegistry = IIdentityRegistry(identityRegistry_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(AGENT_ROLE, admin);
    }

    /**
     * @notice Register a flight leg to be monitored.
     * @param legId Provider-unique id for this leg (`fa_flight_id`)
     * @param flightNumber Human-readable flight number, for display (e.g. "BA208")
     * @param scheduledDeparture Unix timestamp of the scheduled departure
     *
     * @dev Both ids come straight off the provider response the agent just read,
     *      so a leg cannot enter the protocol under an ident the provider has
     *      never published.
     */
    function registerFlight(string calldata legId, string calldata flightNumber, uint256 scheduledDeparture)
        external
        onlyIdentifiedAgent
    {
        flightRegistry.registerFlight(legId, flightNumber, scheduledDeparture);

        _recordActivity(1);

        emit FlightMonitored(legId, flightNumber, scheduledDeparture);
    }


    /**
     * @notice Update the status of a monitored flight leg.
     * @param legId Leg to update
     * @param status New status (e.g., Delayed, OnTime, Departed)
     * @param actualDeparture Actual departure timestamp (0 if not yet departed)
     * @param dataHash Hash of the off-chain data that justifies this report
     *
     * @dev `dataHash` is the agent's commitment to its evidence — typically
     *      `keccak256` of the raw aviation-API response. The chain cannot check
     *      that the hash matches reality, but it makes the claim falsifiable:
     *      anyone holding the original response can recompute the hash and show
     *      whether the agent reported what its source actually said. A zero hash
     *      is rejected, so no payout can rest on an uncommitted report.
     */
    function updateFlightStatus(string calldata legId, FlightStatus status, uint256 actualDeparture, bytes32 dataHash)
        external
        onlyIdentifiedAgent
    {
        flightRegistry.updateFlightStatus(legId, status, actualDeparture, dataHash);

        _recordActivity(1);
    }

    /**
     * @notice Report an airline schedule change for a monitored flight leg.
     * @param legId Leg to reschedule
     * @param newScheduledDeparture The airline's new published departure time
     * @dev Affects new quotes only. Policies already sold keep the baseline
     *      they were purchased against.
     */
    function rescheduleFlight(string calldata legId, uint256 newScheduledDeparture) external onlyIdentifiedAgent {
        flightRegistry.rescheduleFlight(legId, newScheduledDeparture);

        _recordActivity(1);
    }

    /**
     * @notice Bulk update multiple flights in a single transaction.
     *
     * @param legIds Array of leg identifiers
     * @param statuses Array of new statuses
     * @param actualDepartures Array of actual departure timestamps
     * @param dataHashes Array of evidence commitments, one per leg
     * @dev Gas-efficient batch operation for agents monitoring many flights.
     *      Each leg carries its own commitment; a batch is not a way to
     *      report several flights against one piece of evidence.
     */
    function batchUpdateFlights(
        string[] calldata legIds,
        FlightStatus[] calldata statuses,
        uint256[] calldata actualDepartures,
        bytes32[] calldata dataHashes
    ) external onlyIdentifiedAgent {
        uint256 length = legIds.length;
        if (length != statuses.length || length != actualDepartures.length || length != dataHashes.length) {
            revert Unauthorized();
        }

        for (uint256 i = 0; i < length; i++) {
            flightRegistry.updateFlightStatus(legIds[i], statuses[i], actualDepartures[i], dataHashes[i]);
        }

        _recordActivity(length);
    }

    /**
     * @notice Check if a flight leg is delayed beyond threshold.
     * @param legId Leg to check
     * @param delayThreshold Threshold in seconds
     * @return True if delayed beyond threshold
     */
    function isFlightDelayed(string calldata legId, uint256 delayThreshold) external view returns (bool) {
        return flightRegistry.isFlightDelayed(legId, delayThreshold);
    }

    /**
     * @notice Get flight information from the registry.
     * @param legId Leg to query
     * @return FlightInfo struct
     */
    function getFlight(string calldata legId) external view returns (FlightInfo memory) {
        return flightRegistry.getFlight(legId);
    }

    /**
     * @notice Authorize an operator and bind it to an ERC-8004 identity.
     * @param operator Address that will post flight updates
     * @param agentId The ERC-8004 identity the operator claims
     *
     * @dev Verifies against the IdentityRegistry that `operator` actually owns
     *      `agentId` before granting the role, so an operator cannot borrow
     *      someone else's reputation by naming their id.
     *
     *      Identities are per-operator rather than one identity for this
     *      contract. Each monitoring agent then accrues its own attributable
     *      history, which is what makes reputation scoring meaningful later —
     *      a single contract-level identity would blur every operator's record
     *      into one.
     *
     *      This grants AGENT_ROLE on THIS contract only. The registry accepts
     *      writes solely from this contract, which is the protocol's single
     *      oracle chokepoint; granting operators AGENT_ROLE on the registry
     *      directly would bypass it.
     */
    function registerAgent(address operator, uint256 agentId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(identityRegistry) == address(0)) {
            revert AgentIdentityRequired();
        }
        if (operator == address(0) || agentId == 0) {
            revert Unauthorized();
        }

        address owner = identityRegistry.ownerOf(agentId);
        if (owner != operator) {
            revert IdentityNotOwnedByOperator(agentId, operator, owner);
        }

        agentIds[operator] = agentId;
        _grantRole(AGENT_ROLE, operator);

        emit AgentRegistered(operator, agentId);
    }

    /**
     * @notice Add an agent who can post flight updates, with no ERC-8004 identity.
     * @param agent Address to grant AGENT_ROLE
     *
     * @dev Only useful where `identityRegistry` is unset. When a registry IS
     *      configured the write path additionally requires a bound identity, so
     *      an operator added this way holds AGENT_ROLE but cannot post — use
     *      `registerAgent` instead.
     *
     *      Kept rather than removed because the role is still the thing being
     *      granted; `registerAgent` layers identity on top of it, and chains
     *      without ERC-8004 need a path that does not.
     *
     *      Grants the role on THIS contract only — see `registerAgent`.
     */
    function addAgent(address agent) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(AGENT_ROLE, agent);
    }

    /**
     * @notice Remove an agent.
     * @param agent Address to revoke AGENT_ROLE
     */
    function removeAgent(address agent) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(AGENT_ROLE, agent);
        delete agentIds[agent];
    }

    /**
     * @notice Get agent statistics.
     * @param agent Agent address
     * @return lastUpdateTime Last time agent submitted an update
     * @return totalUpdates Total updates submitted by agent
     * @return agentId ERC-8004 identity bound to the agent (0 if unregistered)
     */
    function getAgentStats(address agent)
        external
        view
        returns (uint256 lastUpdateTime, uint256 totalUpdates, uint256 agentId)
    {
        return (lastUpdate[agent], updateCount[agent], agentIds[agent]);
    }

    /// @dev Records monitoring counters and emits the caller's bound identity.
    function _recordActivity(uint256 updates) private {
        lastUpdate[msg.sender] = block.timestamp;
        updateCount[msg.sender] += updates;

        emit AgentActive(msg.sender, agentIds[msg.sender], block.timestamp);
    }
}
