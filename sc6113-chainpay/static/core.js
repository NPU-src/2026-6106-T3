export function parseEth(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)) {
    throw new Error('Enter a positive ETH amount with at most 18 decimal places.');
  }
  const [whole, fractional = ''] = value.split('.');
  const wei = BigInt(whole) * 10n ** 18n + BigInt(fractional.padEnd(18, '0'));
  if (wei <= 0n || wei >= 2n ** 256n) throw new Error('Amount is outside the valid range.');
  return wei;
}

export function validatePayment({ recipient, amount, memo }, sender, contractAddress) {
  recipient = recipient.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw new Error('Enter a valid Ethereum recipient address.');
  if (['0x' + '0'.repeat(40), sender, contractAddress].filter(Boolean)
      .some(a => a.toLowerCase() === recipient.toLowerCase())) {
    throw new Error('Recipient must differ from the sender, zero address and contract.');
  }
  if (new TextEncoder().encode(memo).length > 140) throw new Error('Memo must be at most 140 UTF-8 bytes.');
  return { recipient, amount, memo, wei: parseEth(amount) };
}

export function shortAddress(value) {
  return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : 'Not connected';
}

export function pendingKey(config) {
  return `chainpay.pending.${config.chainId}.${config.contractAddress.toLowerCase()}`;
}

export function readPending(storage, config) {
  if (!config.contractAddress) return null;
  try {
    const hash = storage.getItem(pendingKey(config));
    return /^0x[0-9a-fA-F]{64}$/.test(hash || '') ? hash : null;
  } catch { return null; }
}

export function friendlyError(error) {
  const code = error?.code ?? error?.info?.error?.code;
  if (code === 4001 || code === 'ACTION_REJECTED') return 'You declined the wallet request. No payment was submitted.';
  if (code === -32002) return 'A wallet request is already open. Finish it in MetaMask first.';
  if (code === 'INSUFFICIENT_FUNDS') return 'Insufficient test ETH to cover the amount and gas.';
  if (code === 'CALL_EXCEPTION') return 'The contract rejected this payment. Check the recipient, amount and balance.';
  if (code === 'TRANSACTION_REPLACED') return 'The wallet replaced this transaction. Check its final status in MetaMask.';
  return error?.shortMessage || error?.message || 'The request failed. Please try again.';
}
