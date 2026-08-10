// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IFlightData
 * @notice Shared types and errors for the flight insurance protocol
 */
interface IFlightData {
    /// @notice Flight status enum
    enum FlightStatus {
        Scheduled,
        Delayed,
        Cancelled,
        OnTime,
        Departed,
        Arrived
    }

    /// @notice Policy status enum
    enum PolicyStatus {
        Active,
        Claimed,
        Expired,
        Cancelled
    }

    /**
     * @notice A single flight leg.
     *
     * @dev Keyed by `legId` (the data provider's `fa_flight_id`), not by
     *      `flightNumber`. A flight number is reused every day, so keying by it
     *      collapses every date onto one storage slot: registering Monday's
     *      BA2490 would make Tuesday's revert as a duplicate, and a status
     *      report for one would settle policies bought for the other.
     *
     *      `flightNumber` is retained for display only. Nothing keys off it.
     */
    struct FlightInfo {
        string legId;
        string flightNumber;
        uint256 scheduledDeparture;
        uint256 actualDeparture;
        FlightStatus status;
        bool exists;
        /// @dev Hash of the off-chain data behind the most recent status report.
        bytes32 lastDataHash;
    }

    /// @notice Insurance policy structure
    struct Policy {
        address policyholder;
        /// @dev The leg this cover is bound to. Settlement reads this.
        string legId;
        /// @dev Display copy of the leg's flight number, snapshotted at sale.
        string flightNumber;
        uint256 premium;
        uint256 coverageAmount;
        uint256 departureTime;
        uint256 delayThreshold; // in seconds
        PolicyStatus status;
        uint256 purchaseTime;
    }

    // Events
    // Indexed on legId: a `string indexed` is stored as its hash, so these are
    // filterable by exact leg but not by flight number. The unindexed
    // flightNumber is there so a log reader sees which flight it was.
    event FlightRegistered(string indexed legId, string flightNumber, uint256 scheduledDeparture);
    event FlightStatusUpdated(string indexed legId, FlightStatus status, uint256 actualDeparture);
    /// @notice Commitment to the off-chain data that justified a status report.
    event FlightDataCommitted(string indexed legId, bytes32 indexed dataHash, address indexed reporter);

    event PolicyCreated(uint256 indexed policyId, address indexed policyholder, string legId, uint256 premium);
    event PolicyClaimed(uint256 indexed policyId, address indexed policyholder, uint256 payout);
    event PolicyExpired(uint256 indexed policyId);
    event FlightRescheduled(string indexed legId, uint256 oldDeparture, uint256 newDeparture);


    // Errors
    // NOTE: no `PolicyExpired` error here — it would collide with the
    // `PolicyExpired` event above, since events and errors share a namespace.
    error FlightNotFound();
    error FlightAlreadyExists();
    error PolicyNotFound();
    error PolicyNotActive();
    error InvalidFlightTime();
    error FlightAlreadyDeparted();
    error SameDeparture();
    /// @dev A leg id or flight number was empty.
    error EmptyIdentifier();


    error InvalidDelayThreshold();
    error FlightNotDelayed();
    error ClaimWindowExpired();
    error Unauthorized();

    // --- Agent identity (ERC-8004) ---
    error MissingDataCommitment();
    error IdentityNotOwnedByOperator(uint256 agentId, address claimedBy, address actualOwner);
    error AgentIdentityRequired();
}
