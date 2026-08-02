// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract FlightInsurance is EIP712 {
    using ECDSA for bytes32;

    struct Policy {
        address owner;
        bytes32 flightIdentHash;
        uint256 scheduledDeparture;
        uint256 delayThreshold;
        uint256 premiumAmount;
        uint256 payoutAmount;
        uint256 createdAt;
        Status status;
    }
    enum Status { Pending, PaidOut, Expired }

    address public immutable owner;
    IERC20 public immutable usdc;
    uint256 public policyCounter;
    address public agentSigner;
    bool public paused;

    mapping(uint256 => Policy) public policies;
    mapping(address => uint256) public claimable;

    uint256 public constant SETTLEMENT_WINDOW = 7 days;
    // EIP-712 typehash for the agent's attestation
    bytes32 private constant ATTESTATION_TYPEHASH =
        keccak256("Attestation(uint256 policyId,uint8 outcome,uint256 timestamp)");

    error Unauthorized();
    error PolicyNotPending();
    error InvalidSignature();
    error ContractPaused();
    error NothingToClaim();
    error PolicyNotExpirable();

    event PolicyCreated(uint256 indexed policyId, address indexed owner, bytes32 flightIdentHash, uint256 scheduledDeparture, uint256 premiumAmount, uint256 payoutAmount);
    event PolicySettled(uint256 indexed policyId, Status outcome);
    event PolicyExpired(uint256 indexed policyId);
    event Claimed(address indexed claimant, uint256 amount);

    constructor(address _owner, IERC20 _usdc, address _agentSigner)
        EIP712("FlightInsurance", "1")
    {
        owner = _owner;
        usdc = _usdc;
        agentSigner = _agentSigner;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    function createPolicy(
        bytes32 _flightID,
        uint256 _scheduledDeparture,
        uint256 _delayThreshold,
        uint256 _premiumAmount,
        uint256 _payoutAmount
    ) public whenNotPaused {
        require(usdc.transferFrom(msg.sender, address(this), _premiumAmount), "transfer failed");

        policies[policyCounter] = Policy({
            owner: msg.sender,
            flightIdentHash: _flightID,
            scheduledDeparture: _scheduledDeparture,
            delayThreshold: _delayThreshold,
            premiumAmount: _premiumAmount,
            payoutAmount: _payoutAmount,
            createdAt: block.timestamp,
            status: Status.Pending
        });

        emit PolicyCreated(policyCounter, msg.sender, _flightID, _scheduledDeparture, _premiumAmount, _payoutAmount);
        policyCounter += 1;
    }

    // _outcome: Status.PaidOut (1) if delay confirmed, Status.Expired (2) if flight was on time
    function settlePolicy(
        uint256 _policyId,
        Status _outcome,
        uint256 _timestamp,
        bytes calldata _signature
    ) public {
        Policy storage policy = policies[_policyId];
        if (policy.status != Status.Pending) revert PolicyNotPending();

        bytes32 structHash = keccak256(abi.encode(ATTESTATION_TYPEHASH, _policyId, uint8(_outcome), _timestamp));
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = digest.recover(_signature);
        if (signer != agentSigner) revert InvalidSignature();

        policy.status = _outcome;

        if (_outcome == Status.PaidOut) {
            claimable[policy.owner] += policy.payoutAmount;
        } else {
            // flight was on time — nothing owed, premium stays in the contract
        }

        emit PolicySettled(_policyId, _outcome);
    }

    function claim() public {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();

        claimable[msg.sender] = 0;
        require(usdc.transfer(msg.sender, amount), "transfer failed");

        emit Claimed(msg.sender, amount);
    }

    function expirePolicy(uint256 _policyId) public {
        Policy storage policy = policies[_policyId];
        if (policy.status != Status.Pending) revert PolicyNotPending();
        if (block.timestamp < policy.createdAt + SETTLEMENT_WINDOW) revert PolicyNotExpirable();

        policy.status = Status.Expired;
        claimable[policy.owner] += policy.premiumAmount; // refund the premium

        emit PolicyExpired(_policyId);
    }

    function setAgentSigner(address _newAgentSigner) public onlyOwner {
        agentSigner = _newAgentSigner;
    }

    function setPaused(bool _paused) public onlyOwner {
        paused = _paused;
    }

    function withdrawExcess(uint256 _amount) public onlyOwner {
        require(usdc.transfer(owner, _amount), "transfer failed");
    }

    function getPolicy(uint256 _policyId) public view returns (Policy memory) {
        return policies[_policyId];
    }
}
