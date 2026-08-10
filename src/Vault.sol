// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
// ERC4626 already overrides ERC20.decimals() to track the underlying asset
// (USDC is 6, not 18), so no further override is needed here.

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Vault
 * @notice An ERC-4626 tokenised vault that custodies all protocol funds:
 *         underwriter capital, collected premiums, and the collateral reserved
 *         against active policies.
 *
 * @dev Accounting model
 *
 *      totalAssets()      = asset.balanceOf(address(this))
 *      lockedCollateral   = sum of coverage still owed to active policies
 *      availableLiquidity = totalAssets() - lockedCollateral
 *
 *      Underwriters deposit the asset and receive shares. Because premiums kept
 *      from on-time flights stay in the vault, they raise `totalAssets` without
 *      minting new shares, so the share price rises and the profit accrues to
 *      shareholders automatically. Conversely, when claims exceed premiums the
 *      share price falls and underwriters absorb the loss. That is what makes
 *      this underwriting rather than custody.
 *
 *      This contract deliberately holds NO policy logic. It does not know what a
 *      flight is. It only knows how much money exists and how much of it is
 *      spoken for. All policy decisions live in Insurance.sol, which holds
 *      INSURANCE_ROLE.
 *
 * ---------------------------------------------------------------------------
 *  MVP SCOPE — read before putting real money in this
 * ---------------------------------------------------------------------------
 *
 *  1. NO PREMIUM VESTING. A premium counts toward `totalAssets` the moment it
 *     is collected, so the share price steps up in a single block. With real
 *     TVL and mempool visibility, someone could deposit immediately before a
 *     batch of premiums is recognised and redeem straight after, capturing
 *     yield they carried no risk for and diluting the underwriters who did.
 *     Acceptable for a hackathon MVP with no meaningful TVL. On the mainnet
 *     roadmap this becomes an `unearnedPremium` bucket excluded from
 *     `totalAssets` and dripped in linearly over a vesting window.
 *
 *  2. `maxWithdraw` IS NON-STANDARD. It returns
 *     `min(your assets, unlocked liquidity)` rather than just your assets,
 *     because collateral backing live policies must not be withdrawable. This
 *     is deliberate and load-bearing, but an integrator assuming vanilla
 *     ERC-4626 semantics could be surprised by a withdrawal that is capped for
 *     reasons unrelated to the caller's own balance.
 *
 *  3. DEPOSITS ARE PERMISSIONED behind UNDERWRITER_ROLE. Shares themselves are
 *     freely transferable ERC-20s once minted.
 */
contract Vault is ERC4626, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Granted to the Insurance contract. Can lock, release and pay out.
    bytes32 public constant INSURANCE_ROLE = keccak256("INSURANCE_ROLE");

    /// @notice Granted to addresses allowed to supply underwriting capital.
    bytes32 public constant UNDERWRITER_ROLE = keccak256("UNDERWRITER_ROLE");

    /// @notice Coverage currently reserved against active policies.
    uint256 public lockedCollateral;

    /// @notice Premiums collected over the vault's lifetime.
    uint256 public totalPremiumsCollected;

    /// @notice Total paid out to claimants over the vault's lifetime.
    uint256 public totalClaimsPaid;

    event PremiumDeposited(address indexed from, uint256 amount);
    event CollateralLocked(uint256 amount, uint256 totalLocked);
    event CollateralReleased(uint256 amount, uint256 totalLocked);
    event ClaimPaid(address indexed to, uint256 amount);

    error ZeroAmount();
    error ZeroAddress();
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error InsufficientLockedCollateral(uint256 requested, uint256 locked);

    constructor(address asset_, address admin) ERC4626(IERC20(asset_)) ERC20("ClearSky Underwriting Share", "csUW") {
        if (asset_ == address(0) || admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UNDERWRITER_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // ERC-4626 overrides
    // ---------------------------------------------------------------------

    /**
     * @notice Assets an owner may withdraw right now.
     * @dev Clamped by the vault's unlocked liquidity, so an underwriter can
     *      never pull capital that is currently backing an active policy.
     *
     *      This override is the single most important line in the contract. A
     *      vanilla ERC-4626 assumes every asset is withdrawable; here they are
     *      not, and without the clamp a redemption could strip the collateral
     *      out from under a policyholder who is still owed a payout.
     */
    function maxWithdraw(address owner) public view override returns (uint256) {
        uint256 owed = _convertToAssets(balanceOf(owner), Math.Rounding.Floor);
        uint256 free = availableLiquidity();
        return owed < free ? owed : free;
    }

    /// @notice Shares an owner may redeem right now, clamped the same way.
    function maxRedeem(address owner) public view override returns (uint256) {
        uint256 shares = balanceOf(owner);
        uint256 withdrawable = maxWithdraw(owner);

        // If the whole position fits inside available liquidity, all shares are
        // redeemable. Otherwise only the portion the liquidity can cover is.
        uint256 owed = _convertToAssets(shares, Math.Rounding.Floor);
        if (owed <= withdrawable) return shares;

        return _convertToShares(withdrawable, Math.Rounding.Floor);
    }

    /**
     * @dev Backstop the liquidity guard at the point of transfer, not just in
     *      the `max*` previews. Anything that reaches here without respecting
     *      `availableLiquidity` is a bug, and we would rather revert than let
     *      reserved collateral leave the vault.
     */
    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
        nonReentrant
    {
        uint256 free = availableLiquidity();
        if (assets > free) revert InsufficientLiquidity(assets, free);

        super._withdraw(caller, receiver, owner, assets, shares);
    }

    /// @dev Underwriting capital is permissioned in this MVP.
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
        nonReentrant
        onlyRole(UNDERWRITER_ROLE)
    {
        if (assets == 0) revert ZeroAmount();
        super._deposit(caller, receiver, assets, shares);
    }

    // ---------------------------------------------------------------------
    // Insurance-only operations
    // ---------------------------------------------------------------------

    /**
     * @notice Pull a policyholder's premium into the vault.
     * @param from The policyholder paying the premium.
     * @param amount Premium amount.
     * @dev `from` must have approved the VAULT (not the Insurance contract).
     *
     *      No shares are minted, so this raises the share price for existing
     *      underwriters. See the MVP note about vesting at the top of the file.
     */
    function depositPremium(address from, uint256 amount) external nonReentrant onlyRole(INSURANCE_ROLE) {
        if (amount == 0) revert ZeroAmount();

        totalPremiumsCollected += amount;
        IERC20(asset()).safeTransferFrom(from, address(this), amount);

        emit PremiumDeposited(from, amount);
    }

    /**
     * @notice Reserve coverage against an active policy.
     * @dev Reverts if the vault is not solvent enough to back the new policy,
     *      which is what makes underwriting safe.
     */
    function lockCollateral(uint256 amount) external onlyRole(INSURANCE_ROLE) {
        if (amount == 0) revert ZeroAmount();

        uint256 available = availableLiquidity();
        if (amount > available) revert InsufficientLiquidity(amount, available);

        lockedCollateral += amount;
        emit CollateralLocked(amount, lockedCollateral);
    }

    /**
     * @notice Release reserved coverage without paying it out.
     * @dev Used when a policy expires on-time or is cancelled. The premium simply
     *      stays in the vault, which raises the share price for underwriters.
     */
    function releaseCollateral(uint256 amount) external onlyRole(INSURANCE_ROLE) {
        if (amount == 0) revert ZeroAmount();
        if (amount > lockedCollateral) revert InsufficientLockedCollateral(amount, lockedCollateral);

        lockedCollateral -= amount;
        emit CollateralReleased(amount, lockedCollateral);
    }

    /**
     * @notice Release reserved coverage AND send it to the claimant.
     * @param to The policyholder receiving the payout.
     * @param amount The coverage amount previously locked for this policy.
     * @dev Reduces `totalAssets`, so the share price falls. Underwriters bear
     *      the loss, which is the whole point of underwriting.
     */
    function payClaim(address to, uint256 amount) external nonReentrant onlyRole(INSURANCE_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > lockedCollateral) revert InsufficientLockedCollateral(amount, lockedCollateral);

        lockedCollateral -= amount;
        totalClaimsPaid += amount;

        IERC20(asset()).safeTransfer(to, amount);

        emit CollateralReleased(amount, lockedCollateral);
        emit ClaimPaid(to, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Assets not reserved against active policies.
    function availableLiquidity() public view returns (uint256) {
        uint256 balance = totalAssets();
        return balance > lockedCollateral ? balance - lockedCollateral : 0;
    }

    /// @notice Whether the vault can back `coverageAmount` of new coverage.
    function canUnderwrite(uint256 coverageAmount) external view returns (bool) {
        return coverageAmount <= availableLiquidity();
    }

    /**
     * @notice Assets backing a single whole share, scaled to asset decimals.
     * @dev Purely informational, for dashboards. Starts at 1.0 and drifts up as
     *      premiums are kept, down as claims are paid.
     */
    function sharePrice() external view returns (uint256) {
        return convertToAssets(10 ** decimals());
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @notice Wire the Insurance contract into the vault.
    function setInsurance(address insurance) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (insurance == address(0)) revert ZeroAddress();
        _grantRole(INSURANCE_ROLE, insurance);
    }

    /// @notice Revoke a previous Insurance contract (e.g. during an upgrade).
    function revokeInsurance(address insurance) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(INSURANCE_ROLE, insurance);
    }

    /// @notice Authorise an address to supply underwriting capital.
    function addUnderwriter(address underwriter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (underwriter == address(0)) revert ZeroAddress();
        _grantRole(UNDERWRITER_ROLE, underwriter);
    }

    /**
     * @notice De-authorise an underwriter.
     * @dev Only blocks NEW deposits. Shares already held remain redeemable and
     *      transferable, so revoking cannot strand someone's capital.
     */
    function removeUnderwriter(address underwriter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(UNDERWRITER_ROLE, underwriter);
    }
}
