import { validatePayment, shortAddress, friendlyError, pendingKey, readPending } from './core.js';
const $ = id => document.getElementById(id);
const state = { config: null, account: null, mode: null, wallet: null, provider: null,
  busy: false, ready: false, offset: 0, pending: null, historySequence: 0 };

async function api(path, body) {
  if (state.config?.contractAddress && !/[?&]contract=/.test(path) && /^\/api\/(overview|history|receipt)/.test(path)) {
    path += (path.includes('?') ? '&' : '?') + 'contract=' + encodeURIComponent(state.config.contractAddress);
  }
  const response = await fetch(path, body === undefined ? {} : { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ChainPay-Request': '1' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}
function showError(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function status(message, kind = '') { $('status').textContent = message; $('status').className = 'status ' + kind; }
function rememberPending(hash) {
  state.pending = hash;
  try {
    if (hash) sessionStorage.setItem(pendingKey(state.config), hash);
    else sessionStorage.removeItem(pendingKey(state.config));
  } catch { /* Receipt checking still works when browser storage is unavailable. */ }
}
function clearHistory() {
  state.historySequence++;
  $('history-body').replaceChildren(); $('history-table').hidden = true;
  $('history-message').textContent = 'Connect an account to see sent and received payments.';
  $('history-message').hidden = false; $('page-label').textContent = '';
  $('prev').disabled = true; $('next').disabled = true;
}
function lock(busy) {
  state.busy = busy;
  ['recipient', 'amount', 'memo', 'connect', 'switch', 'deploy', 'use-contract', 'existing-contract'].forEach(id => { $(id).disabled = busy; });
  $('send').disabled = busy || !state.ready || !state.account || !state.config?.contractAddress || Boolean(state.pending);
}
function wallet() {
  const found = window.ethereum?.providers?.find(p => p.isMetaMask) || window.ethereum;
  if (!found) throw new Error('Install MetaMask from metamask.io, then reload.');
  return found;
}
async function correctNetwork() {
  const id = Number(BigInt(await state.wallet.request({ method: 'eth_chainId' })));
  if (id !== state.config.chainId) throw new Error('Wallet network is incorrect. Open wallet setup and switch networks.');
}
function resetWallet() {
  if (state.mode !== 'wallet') return;
  state.account = null; state.provider = null; state.mode = null; clearHistory();
  $('account').textContent = 'Wallet changed. Reconnect to continue.';
  $('balance').textContent = '—'; $('history-table').hidden = true;
  $('history-message').textContent = 'Reconnect to load the selected account history.';
  $('history-message').hidden = false; lock(state.busy);
}
async function connect() {
  showError();
  try {
    const selected = wallet();
    const accounts = await selected.request({ method: 'eth_requestAccounts' });
    if (!accounts.length) throw new Error('No wallet account was selected.');
    if (selected !== state.wallet) {
      state.wallet?.removeListener?.('accountsChanged', resetWallet);
      state.wallet?.removeListener?.('chainChanged', resetWallet);
      selected.on?.('accountsChanged', resetWallet); selected.on?.('chainChanged', resetWallet);
    }
    state.wallet = selected;
    await correctNetwork();
    state.provider = new ethers.BrowserProvider(selected);
    clearHistory(); $('balance').textContent = 'Loading balance…';
    state.account = ethers.getAddress(accounts[0]); state.mode = 'wallet'; state.offset = 0;
    $('account').textContent = state.account; lock(false); await refresh();
  } catch (error) { showError(friendlyError(error)); }
}
function link(id, text, path) {
  $(id).textContent = text;
  if (state.config.explorer && path) { $(id).href = state.config.explorer + path; $(id).target = '_blank'; $(id).rel = 'noopener noreferrer'; }
  else $(id).removeAttribute('href');
}
async function history() {
  if (!state.account || !state.config.contractAddress) return;
  const account = state.account, sequence = ++state.historySequence;
  const result = await api(`/api/history?account=${account}&offset=${state.offset}&limit=6`);
  if (sequence !== state.historySequence || account !== state.account) return;
  $('history-body').replaceChildren();
  for (const p of result.payments) {
    const sent = p.sender.toLowerCase() === account.toLowerCase();
    const row = document.createElement('tr');
    const receipt = document.createElement('td');
    const a = document.createElement('a'); a.textContent = '#' + p.id; a.title = p.transactionHash;
    if (state.config.explorer && p.transactionHash) { a.href = state.config.explorer + '/tx/' + p.transactionHash; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    receipt.append(a);
    const who = document.createElement('td'); who.textContent = sent ? 'Sent' : 'Received';
    const detail = document.createElement('span'); detail.className = 'subtext';
    const counterparty = sent ? p.recipient : p.sender;
    detail.textContent = shortAddress(counterparty); detail.title = counterparty; who.append(detail);
    const amount = document.createElement('td'); amount.textContent = p.amountEth + ' ETH';
    const memo = document.createElement('td'); memo.textContent = p.memo || '—';
    const resultCell = document.createElement('td'); const badge = document.createElement('span');
    badge.textContent = 'Confirmed'; badge.className = 'confirmed'; resultCell.append(badge);
    row.title = new Date(p.timestamp * 1000).toISOString(); row.append(receipt, who, amount, memo, resultCell); $('history-body').append(row);
  }
  $('history-table').hidden = !result.payments.length;
  $('history-message').hidden = Boolean(result.payments.length);
  $('history-message').textContent = 'No payments yet. Send your first test transfer.';
  $('page-label').textContent = `${result.total} receipt(s) · block ${result.snapshotBlock}`;
  $('prev').disabled = state.offset === 0;
  $('next').disabled = BigInt(state.offset + result.payments.length) >= BigInt(result.total);
}
async function refresh() {
  if (!state.config.contractAddress) return;
  showError();
  try {
    const account = state.account;
    const result = await api('/api/overview' + (account ? '?account=' + account : ''));
    state.ready = true; lock(state.busy);
    if (account === state.account && account) $('balance').textContent = result.balanceEth + ' test ETH';
    await history();
  } catch (error) { state.ready = false; lock(state.busy); showError(friendlyError(error)); }
}
async function confirmation() {
  if (!state.pending) return true;
  const receipt = await api('/api/receipt/' + state.pending);
  if (receipt.status === 'pending') return false;
  rememberPending(null); $('check').hidden = true;
  if (receipt.status === 'confirmed') {
    status('Payment confirmed and recorded on-chain.');
    $('amount').value = ''; $('memo').value = ''; countMemo();
  } else status('Payment reverted. No funds were transferred; gas may still have been spent.', 'failed');
  $('confirmation').textContent = `${receipt.status} · ${receipt.confirmations} confirmation(s) · block ${receipt.blockNumber} · ${receipt.gasUsed} gas`;
  state.offset = 0; await refresh(); lock(state.busy); return true;
}
async function send(event) {
  event.preventDefault(); if (state.busy || !state.account || state.pending) return;
  showError(); lock(true);
  link('hash', '—', ''); $('confirmation').textContent = '—';
  try {
    const p = validatePayment({ recipient: $('recipient').value, amount: $('amount').value.trim(), memo: $('memo').value }, state.account, state.config.contractAddress);
    p.recipient = ethers.getAddress(p.recipient);
    status('Confirm the payment in MetaMask.', 'pending');
    let hash;
    {
      await correctNetwork();
      const signer = await state.provider.getSigner();
      if ((await signer.getAddress()).toLowerCase() !== state.account.toLowerCase()) throw new Error('Signing account changed. Reconnect.');
      const contract = new ethers.Contract(state.config.contractAddress, state.config.abi, signer);
      hash = (await contract.pay(p.recipient, p.memo, { value: p.wei })).hash;
    }
    rememberPending(hash); link('hash', hash, '/tx/' + hash);
    $('confirmation').textContent = 'Waiting for a mined receipt…'; status('Submitted. Waiting for blockchain confirmation…', 'pending');
    for (let i = 0; i < 30; i++) { if (await confirmation()) return; await new Promise(r => setTimeout(r, 2000)); }
    status('Still pending. Check the same transaction again; do not resend.', 'pending'); $('check').hidden = false;
  } catch (error) {
    showError(friendlyError(error));
    if (state.pending) { status('Submitted, but the receipt could not be read. Check confirmation again.', 'pending'); $('check').hidden = false; }
    else status('Payment was not submitted. Check the inputs and try again.', 'failed');
  } finally { lock(false); }
}
async function switchNetwork() {
  try {
    const selected = wallet(), chainId = '0x' + state.config.chainId.toString(16);
    try { await selected.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] }); }
    catch (e) {
      if (e.code !== 4902) throw e;
      await selected.request({ method: 'wallet_addEthereumChain', params: [{ chainId,
        chainName: state.config.network === 'local' ? 'Local EVM' : 'Sepolia',
        nativeCurrency: { name: 'Test Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: [state.config.network === 'local' ? 'http://127.0.0.1:8545' : 'https://ethereum-sepolia-rpc.publicnode.com'],
        ...(state.config.explorer ? { blockExplorerUrls: [state.config.explorer] } : {}) }] });
    }
    await connect();
  } catch (e) { showError(friendlyError(e)); }
}
async function deploy() {
  if (state.busy || state.pending) return;
  try {
    if (state.mode !== 'wallet') await connect();
    if (state.mode !== 'wallet') return;
    await correctNetwork(); lock(true);
    $('deployment-status').textContent = 'Confirm contract deployment in MetaMask…';
    const artifact = await api('/api/artifact');
    const signer = await state.provider.getSigner();
    const contract = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer).deploy();
    const tx = contract.deploymentTransaction();
    $('deployment-status').textContent = 'Deployment pending: ' + tx.hash;
    const receipt = await tx.wait(); const address = await contract.getAddress();
    await selectContract(address);
    $('deployment-status').textContent = 'Deployed and verified: ' + address;
    await refresh();
  } catch (e) { $('deployment-status').textContent = friendlyError(e); }
  finally { lock(false); }
}
async function selectContract(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) throw new Error('Enter a valid contract address.');
  address = ethers.getAddress(address);
  await api('/api/overview?contract=' + encodeURIComponent(address));
  state.config.contractAddress = address;
  state.ready = true; state.offset = 0; clearHistory();
  try { localStorage.setItem('chainpay.contract.' + state.config.chainId, address); } catch { /* Selection remains valid for this visit. */ }
  $('existing-contract').value = address;
  link('contract', address, '/address/' + address);
  rememberPending(null); $('check').hidden = true;
  link('hash', '—', ''); $('confirmation').textContent = '—'; status('No transaction submitted.');
}
function countMemo() { $('memo-counter').textContent = new TextEncoder().encode($('memo').value).length + ' / 140 UTF-8 bytes'; }
async function init() {
  state.config = await api('/api/config');
  try {
    const saved = localStorage.getItem('chainpay.contract.' + state.config.chainId);
    if (/^0x[0-9a-fA-F]{40}$/.test(saved || '')) state.config.contractAddress = saved;
  } catch { /* Use the configured address if browser storage is unavailable. */ }
  $('existing-contract').value = state.config.contractAddress;
  const name = state.config.network === 'local' ? 'Local EVM' : 'Sepolia';
  $('network').textContent = name + ' · test network'; $('network-detail').textContent = name + ' · chain ' + state.config.chainId;
  $('notice').textContent = 'Sepolia testnet: payments use Sepolia ETH.';
  link('contract', state.config.contractAddress || 'Not deployed · open setup below', state.config.contractAddress ? '/address/' + state.config.contractAddress : '');
  $('setup-info').textContent = 'Connect MetaMask and switch to Sepolia. Deploy a contract once, or enter an existing ChainPay address below.';
  if (!state.config.compiled) showError('Contract build is unavailable.');
  state.pending = readPending(sessionStorage, state.config);
  if (state.pending) {
    link('hash', state.pending, '/tx/' + state.pending);
    status('Restored a submitted transaction. Check its confirmation before sending again.', 'pending');
    $('confirmation').textContent = 'Confirmation needs checking.';
    $('check').hidden = false;
  }
  lock(false);
}
$('connect').addEventListener('click', connect);
$('use-contract').addEventListener('click', async () => {
  if (state.busy || state.pending) return;
  lock(true);
  try { await selectContract($('existing-contract').value.trim()); await refresh(); }
  catch (e) { showError(friendlyError(e)); }
  finally { lock(false); }
});
$('transfer-form').addEventListener('submit', send); $('memo').addEventListener('input', countMemo);
$('refresh').addEventListener('click', refresh); $('switch').addEventListener('click', switchNetwork); $('deploy').addEventListener('click', deploy);
$('prev').addEventListener('click', () => { state.offset = Math.max(0, state.offset - 6); history().catch(e => showError(friendlyError(e))); });
$('next').addEventListener('click', () => { state.offset += 6; history().catch(e => showError(friendlyError(e))); });
$('check').addEventListener('click', async () => { try { if (!(await confirmation())) status('Still pending. Check again later.', 'pending'); } catch (e) { showError(friendlyError(e)); } });
try { await init(); await refresh(); } catch (e) { showError(friendlyError(e)); }
