// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ChainPay: direct ETH payments with a verifiable, paginated receipt ledger
/// @notice Designed for coursework on test networks. Memos are public on-chain.
contract ChainPay {
    struct Payment {
        address sender;
        address recipient;
        uint256 amount;
        uint256 timestamp;
        uint256 blockNumber;
        string memo;
    }

    error InvalidRecipient();
    error InvalidAmount();
    error MemoTooLong();
    error PaymentFailed();
    error ReentrantCall();
    error UnknownPayment();
    error InvalidPageSize();

    uint256 public transferCount;
    uint256 public totalTransferred;
    mapping(uint256 => Payment) private payments;
    mapping(address => uint256[]) private history;
    bool private entered;

    event TransferRecorded(
        uint256 indexed id,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        string memo
    );

    modifier nonReentrant() {
        if (entered) revert ReentrantCall();
        entered = true;
        _;
        entered = false;
    }

    /// @dev The actual payer is msg.sender; amount is msg.value, never a typed claim.
    function pay(address payable recipient, string calldata memo) external payable nonReentrant {
        if (recipient == address(0) || recipient == msg.sender || recipient == address(this)) {
            revert InvalidRecipient();
        }
        if (msg.value == 0) revert InvalidAmount();
        if (bytes(memo).length > 140) revert MemoTooLong();

        // Checks -> effects -> interactions. A failed payout reverts every ledger update.
        uint256 id = ++transferCount;
        totalTransferred += msg.value;
        payments[id] = Payment(msg.sender, recipient, msg.value, block.timestamp, block.number, memo);
        history[msg.sender].push(id);
        history[recipient].push(id);

        (bool success,) = recipient.call{value: msg.value}("");
        if (!success) revert PaymentFailed();
        emit TransferRecorded(id, msg.sender, recipient, msg.value, memo);
    }

    function getPayment(uint256 id) external view returns (Payment memory) {
        if (id == 0 || id > transferCount) revert UnknownPayment();
        return payments[id];
    }

    function historyCount(address account) external view returns (uint256) {
        return history[account].length;
    }

    /// @notice Newest first. Reads are bounded, so history does not require an unbounded loop.
    function getHistoryIds(address account, uint256 offset, uint256 limit)
        external view returns (uint256[] memory ids)
    {
        if (limit == 0 || limit > 50) revert InvalidPageSize();
        uint256 count = history[account].length;
        if (offset >= count) return new uint256[](0);
        uint256 size = count - offset;
        if (size > limit) size = limit;
        ids = new uint256[](size);
        for (uint256 i; i < size; ++i) {
            ids[i] = history[account][count - offset - i - 1];
        }
    }
}
