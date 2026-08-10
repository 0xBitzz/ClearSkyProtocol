// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IFlightData} from "./interfaces/IFlightData.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title FlightRegistry
 * @notice Stores and manages flight information
 *
 * @dev Only authorised agents can write here.
 *
 *      Flights are keyed by `legId` — the data provider's per-leg identifier
 *      (`fa_flight_id`). This is deliberately NOT the flight number: an airline
 *      reuses "BA2490" every single day, so a flight-number key would give the
 *      whole protocol one storage slot per route rather than one per flight.
 *      The consequences were concrete: the second day's registration would
 *      revert as a duplicate, and a departure reported for Tuesday would settle
 *      cover bought for Monday.
 */
contract FlightRegistry is IFlightData, AccessControl {
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    // legId => FlightInfo
    mapping(string => FlightInfo) public flights;

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(AGENT_ROLE, admin);
    }

    /**
     * @notice Register a flight leg.
     * @param legId Provider-unique id for this specific leg (`fa_flight_id`).
     * @param flightNumber Human-readable flight number, for display only.
     * @param scheduledDeparture Unix timestamp of scheduled departure.
     *
     * @dev The agent sources both ids from the provider response rather than
     *      constructing them, so a leg cannot be registered under an ident the
     *      provider has never heard of.
     */
    function registerFlight(string calldata legId, string calldata flightNumber, uint256 scheduledDeparture)
        external
        onlyRole(AGENT_ROLE)
    {
        if (bytes(legId).length == 0 || bytes(flightNumber).length == 0) {
            revert EmptyIdentifier();
        }
        if (flights[legId].exists) {
            revert FlightAlreadyExists();
        }
        if (scheduledDeparture <= block.timestamp) {
            revert InvalidFlightTime();
        }

        flights[legId] = FlightInfo({
            legId: legId,
            flightNumber: flightNumber,
            scheduledDeparture: scheduledDeparture,
            actualDeparture: 0,
            status: FlightStatus.Scheduled,
            exists: true,
            lastDataHash: bytes32(0)
        });

        emit FlightRegistered(legId, flightNumber, scheduledDeparture);
    }

    /**
     * @notice Update flight status and actual departure time
     * @param legId Leg to update
     * @param status New status
     * @param actualDeparture Actual departure timestamp (0 if not departed)
     */
    function updateFlightStatus(string calldata legId, FlightStatus status, uint256 actualDeparture, bytes32 dataHash)
        external
        onlyRole(AGENT_ROLE)
    {
        FlightInfo storage flight = flights[legId];
        if (!flight.exists) {
            revert FlightNotFound();
        }
        // A status report with no commitment is an unfalsifiable assertion, and
        // this one can release 5x a premium from the vault. Require the agent to
        // stake its claim on specific data.
        if (dataHash == bytes32(0)) {
            revert MissingDataCommitment();
        }

        flight.status = status;
        flight.actualDeparture = actualDeparture;
        flight.lastDataHash = dataHash;

        emit FlightStatusUpdated(legId, status, actualDeparture);
        emit FlightDataCommitted(legId, dataHash, msg.sender);
    }

    /**
     * @notice Record an airline schedule change.
     * @param legId Leg to reschedule
     * @param newScheduledDeparture The airline's new published departure time
     *
     * @dev Only affects quotes for policies bought AFTER this call. Policies
     *      already sold snapshot their own baseline at purchase time (see
     *      `Insurance.buyPolicy`), so a reschedule can never retroactively
     *      void or trigger existing cover.
     */
    function rescheduleFlight(string calldata legId, uint256 newScheduledDeparture) external onlyRole(AGENT_ROLE) {
        FlightInfo storage flight = flights[legId];
        if (!flight.exists) {
            revert FlightNotFound();
        }
        // Once the plane is off the ground the schedule is history.
        if (flight.actualDeparture != 0) {
            revert FlightAlreadyDeparted();
        }
        if (newScheduledDeparture <= block.timestamp) {
            revert InvalidFlightTime();
        }
        if (newScheduledDeparture == flight.scheduledDeparture) {
            revert SameDeparture();
        }

        uint256 oldDeparture = flight.scheduledDeparture;
        flight.scheduledDeparture = newScheduledDeparture;

        emit FlightRescheduled(legId, oldDeparture, newScheduledDeparture);
    }

    /**
     * @notice Check if a flight is delayed beyond a threshold
     *
     * @param legId Leg to check
     * @param delayThreshold Delay threshold in seconds
     * @return True if flight is delayed beyond threshold
     */
    function isFlightDelayed(string calldata legId, uint256 delayThreshold) external view returns (bool) {
        FlightInfo storage flight = flights[legId];
        if (!flight.exists) {
            revert FlightNotFound();
        }

        // Only check if flight has actually departed
        if (flight.actualDeparture == 0) {
            return false;
        }

        uint256 delay =
            flight.actualDeparture > flight.scheduledDeparture ? flight.actualDeparture - flight.scheduledDeparture : 0;

        return delay >= delayThreshold;
    }

    /**
     * @notice Get flight information
     * @param legId Leg to query
     * @return FlightInfo struct
     */
    function getFlight(string calldata legId) external view returns (FlightInfo memory) {
        FlightInfo storage flight = flights[legId];
        if (!flight.exists) {
            revert FlightNotFound();
        }
        return flight;
    }

    /// @notice Whether a leg has been registered. Does not revert.
    function flightExists(string calldata legId) external view returns (bool) {
        return flights[legId].exists;
    }

    /**
     * @notice Add an agent who can update flight data
     * @param agent Address to grant AGENT_ROLE
     */
    function addAgent(address agent) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(AGENT_ROLE, agent);
    }

    /**
     * @notice Remove an agent
     * @param agent Address to revoke AGENT_ROLE
     */
    function removeAgent(address agent) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(AGENT_ROLE, agent);
    }
}
