/**
 * Minimal ABI fragments for the calls the agent makes.
 *
 * Hand-written rather than generated: the agent touches four functions, and a
 * narrow surface makes it obvious what an agent key is actually able to do.
 */

export const flightAgentAbi = [
    {
        type: "function",
        name: "registerFlight",
        stateMutability: "nonpayable",
        inputs: [
            { name: "legId", type: "string" },
            { name: "flightNumber", type: "string" },
            { name: "scheduledDeparture", type: "uint256" },
        ],
        outputs: [],
    },
    {
        type: "function",
        name: "updateFlightStatus",
        stateMutability: "nonpayable",
        inputs: [
            { name: "legId", type: "string" },
            { name: "status", type: "uint8" },
            { name: "actualDeparture", type: "uint256" },
            { name: "dataHash", type: "bytes32" },
        ],
        outputs: [],
    },
    {
        type: "function",
        name: "rescheduleFlight",
        stateMutability: "nonpayable",
        inputs: [
            { name: "legId", type: "string" },
            { name: "newScheduledDeparture", type: "uint256" },
        ],
        outputs: [],
    },
    {
        type: "function",
        name: "hasRole",
        stateMutability: "view",
        inputs: [
            { name: "role", type: "bytes32" },
            { name: "account", type: "address" },
        ],
        outputs: [{ type: "bool" }],
    },
    {
        type: "function",
        name: "agentIds",
        stateMutability: "view",
        inputs: [{ name: "operator", type: "address" }],
        outputs: [{ type: "uint256" }],
    },
] as const;

/**
 * ERC-8004 IdentityRegistry, as much of it as registration needs.
 *
 * `register` does not return the minted id, so the token id has to be recovered
 * from the ERC-721 `Transfer` log the mint emits — hence the event fragment.
 */
export const identityRegistryAbi = [
    {
        type: "function",
        name: "register",
        stateMutability: "nonpayable",
        inputs: [{ name: "metadataURI", type: "string" }],
        outputs: [],
    },
    {
        type: "function",
        name: "ownerOf",
        stateMutability: "view",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [{ type: "address" }],
    },
    {
        type: "function",
        name: "tokenURI",
        stateMutability: "view",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [{ type: "string" }],
    },
    {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "owner", type: "address" }],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "event",
        name: "Transfer",
        inputs: [
            { name: "from", type: "address", indexed: true },
            { name: "to", type: "address", indexed: true },
            { name: "tokenId", type: "uint256", indexed: true },
        ],
    },
] as const;

export const flightRegistryAbi = [
    {
        type: "function",
        name: "getFlight",
        stateMutability: "view",
        inputs: [{ name: "legId", type: "string" }],
        outputs: [
            {
                type: "tuple",
                components: [
                    { name: "legId", type: "string" },
                    { name: "flightNumber", type: "string" },
                    { name: "scheduledDeparture", type: "uint256" },
                    { name: "actualDeparture", type: "uint256" },
                    { name: "status", type: "uint8" },
                    { name: "exists", type: "bool" },
                    { name: "dataHash", type: "bytes32" },
                ],
            },
        ],
    },
] as const;

export const insuranceAbi = [
    {
        type: "function",
        name: "nextPolicyId",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "getPolicy",
        stateMutability: "view",
        inputs: [{ name: "policyId", type: "uint256" }],
        outputs: [
            {
                type: "tuple",
                components: [
                    { name: "policyholder", type: "address" },
                    { name: "legId", type: "string" },
                    { name: "flightNumber", type: "string" },
                    { name: "premium", type: "uint256" },
                    { name: "coverageAmount", type: "uint256" },
                    { name: "departureTime", type: "uint256" },
                    { name: "delayThreshold", type: "uint256" },
                    { name: "status", type: "uint8" },
                    { name: "purchaseTime", type: "uint256" },
                ],
            },
        ],
    },
    {
        type: "function",
        name: "isClaimable",
        stateMutability: "view",
        inputs: [{ name: "policyId", type: "uint256" }],
        outputs: [{ type: "bool" }],
    },
    {
        type: "function",
        name: "expirePolicy",
        stateMutability: "nonpayable",
        inputs: [{ name: "policyId", type: "uint256" }],
        outputs: [],
    },
] as const;

/** Mirrors IFlightData.PolicyStatus. */
export enum PolicyStatus {
    Active = 0,
    Claimed = 1,
    Expired = 2,
}
