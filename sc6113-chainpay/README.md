# ChainPay

Live application: https://chainpay-sc6113.onrender.com

ChainPay is an ETH transfer application for the Sepolia test network. It records a receipt for each payment and displays sent and received payments for the connected account.

## Submission files

- `contracts/ChainPay.sol`: Solidity smart contract.
- `ChainPay.abi.json`: raw contract ABI.
- `app.py`: Python Flask backend.
- `templates/index.html`: web interface.
- `static/styles.css`: stylesheet.
- `static/app.js` and `static/core.js`: wallet connection, transfers and validation.
- `artifacts/ChainPay.json`: compiled ABI and bytecode used by the application.
- `static/vendor/ethers.umd.min.js`: bundled ethers.js library.
- `requirements.txt` and `render.yaml`: dependencies and Render configuration.

## Run locally

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:6113.

## Use the application

1. Connect MetaMask and switch to Sepolia.
2. Open the setup section. Deploy ChainPay with Sepolia ETH, or enter the address of an existing contract compiled from this build.
3. Enter a recipient address and an ETH amount. Add a short memo if needed.
4. Confirm the transaction in MetaMask. The page shows the transaction hash, receipt status and history.

The backend checks the selected contract's bytecode before reading payments. The contract forwards ETH to the recipient and records both accounts' history. Failed payouts revert the entire transaction. Amounts are handled as integer wei. Memos are public and limited to 140 UTF-8 bytes. Wallet signing takes place in MetaMask.

## Deploy on Render

The deployed service uses branch `codex/chainpay-submission` and root directory `sc6113-chainpay` in the GitHub repository. To deploy the extracted submission as a new repository, leave Root Directory empty and remove `branch` and `rootDir` from `render.yaml`. Select the Free instance type.

Build command: `pip install -r requirements.txt`

Start command: `gunicorn 'app:create_app()' --bind 0.0.0.0:$PORT --workers 2 --threads 4 --timeout 60`

Health check path: `/health`

The default network is Sepolia. Set `CONTRACT_ADDRESS` in the service environment to share a verified contract address with all visitors. Without that setting, visitors can select or deploy a contract in their browser. The Render URL and the Sepolia contract address are separate identifiers.
